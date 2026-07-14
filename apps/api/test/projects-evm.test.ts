import { describe, expect, it } from 'vitest';

import { ProjectsEvmService } from '../src/modules/projects/projects-evm.service';

// Closed-form earned-value math (PROJ-06) — workstream 2.4 slice 3. The docs/38 projects PR-4 sub-service
// takes its project row through the rowOf port and reads tasks + the non-billable cost sum from the db,
// so two routed selects + a canned project are enough to pin the BAC/PV/EV/AC/CPI/SPI/EAC formulas.

function fakeDb(routes: any[][]): any {
  let call = 0;
  const chain = (rows: any[]) => {
    const p: any = { from: () => p, where: () => p, limit: () => p, then: (r: any, j: any) => Promise.resolve(rows).then(r, j) };
    return p;
  };
  return { select: () => chain(routes[Math.min(call++, routes.length - 1)] ?? []) };
}

const stubs = [async () => ({}), async () => null, async () => '', async () => undefined] as const;

function svcWith(project: any, tasks: any[], nonBillableSum: string) {
  const db = fakeDb([tasks, [{ v: nonBillableSum }]]);
  const rowOf = async () => project;
  return new ProjectsEvmService(db, { taskRollup: async () => ({}) } as any, rowOf as any, stubs[1] as any, stubs[2] as any, stubs[3] as any);
}

describe('ProjectsEvmService — evm() closed form (PROJ-06)', () => {
  it('computes BAC/PV/EV/AC and the derived indices on a two-task plan', async () => {
    // task A: 1000 planned, 50% done, scheduled by as-of → contributes EV 500 and PV 1000
    // task B: 1000 planned, 0% done, scheduled in the future → no PV, no EV
    const svc = svcWith(
      { id: 1, costToDate: '400', budgetAmount: '0' },
      [
        { plannedCost: '1000', pctComplete: 50, plannedEnd: '2026-01-01', status: 'active' },
        { plannedCost: '1000', pctComplete: 0, plannedEnd: '2999-12-31', status: 'active' },
      ],
      '100', // non-billable actuals → AC = 400 + 100 = 500
    );
    const r = await svc.evm('P-1', '2026-06-30');
    expect(r.bac).toBe(2000);
    expect(r.pv).toBe(1000);
    expect(r.ev).toBe(500);
    expect(r.ac).toBe(500);
    expect(r.cpi).toBe(1);          // EV / AC
    expect(r.spi).toBe(0.5);        // EV / PV
    expect(r.cost_variance).toBe(0);
    expect(r.schedule_variance).toBe(-500);
    expect(r.eac).toBe(2000);       // AC + (BAC − EV)/CPI
    expect(r.etc).toBe(1500);
    expect(r.task_count).toBe(2);
  });

  it('cancelled tasks are excluded from the baseline', async () => {
    const svc = svcWith(
      { id: 1, costToDate: '0', budgetAmount: '0' },
      [
        { plannedCost: '1000', pctComplete: 100, plannedEnd: '2026-01-01', status: 'active' },
        { plannedCost: '9999', pctComplete: 0, plannedEnd: '2026-01-01', status: 'cancelled' },
      ],
      '0',
    );
    const r = await svc.evm('P-1', '2026-06-30');
    expect(r.bac).toBe(1000);
    expect(r.task_count).toBe(1);
  });

  it('falls back to the project budget when no task carries a planned cost (BAC=PV=budget)', async () => {
    const svc = svcWith({ id: 1, costToDate: '0', budgetAmount: '5000' }, [], '0');
    const r = await svc.evm('P-1', '2026-06-30');
    expect(r.bac).toBe(5000);
    expect(r.pv).toBe(5000);
    expect(r.ev).toBe(0);
  });

  it('guards the ratios: AC=0 → CPI null; PV=0 → SPI null; EAC degrades to AC + (BAC − EV)', async () => {
    const svc = svcWith(
      { id: 1, costToDate: '0', budgetAmount: '0' },
      [{ plannedCost: '1000', pctComplete: 30, plannedEnd: '2999-12-31', status: 'active' }],
      '0',
    );
    const r = await svc.evm('P-1', '2026-06-30');
    expect(r.cpi).toBeNull();
    expect(r.spi).toBeNull();
    expect(r.eac).toBe(700); // 0 + (1000 − 300)
  });

  it('a task with no planned_end counts as scheduled (PV includes it)', async () => {
    const svc = svcWith(
      { id: 1, costToDate: '0', budgetAmount: '0' },
      [{ plannedCost: '800', pctComplete: 0, plannedEnd: null, status: 'active' }],
      '0',
    );
    const r = await svc.evm('P-1', '2026-06-30');
    expect(r.pv).toBe(800);
  });
});

// ───────────────────── slice 5: CPM schedule, program CP, S-curve, RAG, baseline guard ─────────────────────

// Multi-route fake for the methods that read more than once; rowOf resolves per project code.
function evmSvc(routes: any[][], opts: { rowOf?: (code: string) => Promise<any>; noWrites?: boolean } = {}) {
  let call = 0;
  const chain = (rows: any[]) => {
    const p: any = { from: () => p, where: () => p, limit: () => p, orderBy: () => p, then: (r: any, j: any) => Promise.resolve(rows).then(r, j) };
    return p;
  };
  const db: any = { select: () => chain(routes[Math.min(call++, routes.length - 1)] ?? []) };
  if (opts.noWrites) {
    db.insert = () => { throw new Error('unexpected write in a guard-path unit test'); };
    db.update = () => { throw new Error('unexpected write in a guard-path unit test'); };
  }
  const rowOf = opts.rowOf ?? (async () => ({ id: 1 }));
  return new ProjectsEvmService(db, { taskRollup: async () => ({}) } as any, rowOf as any, stubs[1] as any, stubs[2] as any, stubs[3] as any);
}

// Schema-shaped task row (shapeTask reads camelCase) — only the fields the CPM pass uses.
const task = (id: number, extra: any = {}) => ({ id, projectId: 1, status: 'active', plannedCost: '0', pctComplete: 0, ...extra });

describe('ProjectsEvmService — schedule() critical path (PROJ-06 CPM)', () => {
  it('forward+backward pass over a fork: the longer branch is critical, the shorter carries slack', async () => {
    // 1 (5d, explicit span) → {2 (16h ⇒ 2d), 3 (40h ⇒ 5d)}; duration 10, critical path 1→3, slack(2)=3
    const svc = evmSvc([[
      task(1, { plannedStart: '2026-01-01', plannedEnd: '2026-01-05' }),
      task(2, { dependsOn: '1', plannedHours: '16' }),
      task(3, { dependsOn: '1', plannedHours: '40' }),
    ]]);
    const r = await svc.schedule('P-1');
    expect(r.project_duration_days).toBe(10);
    expect(r.critical_path).toEqual([1, 3]);
    const t2 = r.tasks.find((t: any) => t.id === 2);
    expect(t2).toMatchObject({ duration_days: 2, es: 5, ef: 7, ls: 8, lf: 10, slack: 3, on_critical_path: false });
    expect(r.tasks.find((t: any) => t.id === 3)).toMatchObject({ es: 5, ef: 10, slack: 0, on_critical_path: true });
  });

  it('cancelled tasks are excluded; a plan-less task defaults to 1 day; a self-dependency is ignored', async () => {
    const svc = evmSvc([[
      task(1, { dependsOn: '1' }),                    // no dates/hours → 1 day; self-dep dropped
      task(9, { status: 'cancelled', plannedHours: '999' }),
    ]]);
    const r = await svc.schedule('P-1');
    expect(r.count).toBe(1);
    expect(r.tasks[0]).toMatchObject({ id: 1, duration_days: 1, es: 0, ef: 1, on_critical_path: true });
  });

  it('a dependency cycle degrades gracefully — the pass still terminates and every task is scheduled', async () => {
    const svc = evmSvc([[
      task(1, { dependsOn: '2', plannedHours: '8' }),
      task(2, { dependsOn: '1', plannedHours: '8' }),
    ]]);
    const r = await svc.schedule('P-1');
    expect(r.count).toBe(2);
    expect(r.project_duration_days).toBeGreaterThan(0);
  });

  it('an enabled working calendar (PPM-B1) counts only working days, excluding weekends + a holiday exception', async () => {
    // 2026-01-01 (Thu) .. 2026-01-14 (Wed) = 14 raw days; excludes 2 Sat + 2 Sun (weekend) and the
    // 2026-01-01 holiday exception (not already a weekend day) → 14 − 4 − 1 = 9 working days.
    const svc = evmSvc(
      [
        [task(1, { plannedStart: '2026-01-01', plannedEnd: '2026-01-14' })], // schedule tasks
        [{ enabled: true, nonWorkingWeekdays: '0,6' }],                      // calRow
        [{ exceptionDate: '2026-01-01' }],                                   // calendar exceptions
        [],                                                                  // depRows
      ],
      { rowOf: async () => ({ id: 1, tenantId: 1 }) },
    );
    const r = await svc.schedule('P-1');
    expect(r.working_calendar_enabled).toBe(true);
    expect(r.project_duration_days).toBe(9);
    expect(r.tasks[0].duration_days).toBe(9);
  });
});

describe('ProjectsEvmService — programCriticalPath (PMO-4 cross-project CPM)', () => {
  it('chains member projects finish-to-start; an independent member carries slack', async () => {
    // A (40h ⇒ 5d) ← B (24h ⇒ 3d, depends on A); C (16h ⇒ 2d, independent) → program 8d, CP = A→B
    // PPM-B1: schedule() now also reads project_task_dependencies (an empty route — no tenantId on
    // these rowOf rows, so the calendar select is skipped) per member's schedule() call.
    const ids: Record<string, number> = { A: 1, B: 2, C: 3 };
    const svc = evmSvc(
      [
        [ // program member scan
          { projectCode: 'A', name: 'a', status: 'active', dependsOnProjects: null },
          { projectCode: 'B', name: 'b', status: 'active', dependsOnProjects: 'A,X-NOT-MEMBER' }, // non-members filtered
          { projectCode: 'C', name: 'c', status: 'active', dependsOnProjects: null },
        ],
        [task(11, { plannedHours: '40' })], // A's schedule tasks
        [], // A's schedule depRows
        [task(21, { plannedHours: '24' })], // B's schedule tasks
        [], // B's schedule depRows
        [task(31, { plannedHours: '16' })], // C's schedule tasks
        [], // C's schedule depRows
      ],
      { rowOf: async (code: string) => ({ id: ids[code] ?? 0 }) },
    );
    const r = await svc.programCriticalPath('PRG-1', { username: 'u' } as any);
    expect(r).toMatchObject({ program_code: 'PRG-1', project_count: 3, program_duration_days: 8, critical_path: ['A', 'B'] });
    expect(r.projects.find((p: any) => p.project_code === 'B')).toMatchObject({ depends_on: ['A'], es: 5, ef: 8, slack: 0 });
    expect(r.projects.find((p: any) => p.project_code === 'C')).toMatchObject({ es: 0, ef: 2, slack: 6, on_critical_path: false });
  });

  it('an empty program is PROGRAM_NOT_FOUND', async () => {
    const svc = evmSvc([[]]);
    await expect(svc.programCriticalPath('PRG-404', { username: 'u' } as any)).rejects.toMatchObject({ response: { code: 'PROGRAM_NOT_FOUND' } });
  });
});

describe('ProjectsEvmService — evmSeries S-curve buckets', () => {
  it('accumulates planned cost by planned_end month with a running cumulative, and overlays the live EVM point', async () => {
    const seriesTasks = [
      task(1, { plannedCost: '100', plannedEnd: '2026-01-15' }),
      task(2, { plannedCost: '50', plannedEnd: '2026-01-20' }),
      task(3, { plannedCost: '200', plannedEnd: '2026-02-10' }),
    ];
    // routes: series scan → evm()'s task scan → evm()'s non-billable sum
    const svc = evmSvc([seriesTasks, seriesTasks, [{ v: '0' }]]);
    const r = await svc.evmSeries('P-1', { as_of: '2026-06-30' });
    expect(r.series).toEqual([
      { month: '2026-01', planned_cost: 150, cumulative_planned: 150 },
      { month: '2026-02', planned_cost: 200, cumulative_planned: 350 },
    ]);
    expect(r.bac).toBe(350);
    expect(r.current.ev).toBe(0);
  });
});

describe('ProjectsEvmService — eacScenarios / submitEtc (PPM-B2, PROJ-22)', () => {
  it('with no manual ETC entries, eacScenarios reports the formulaic EAC only (bottom_up null)', async () => {
    const tasks = [task(1, { plannedCost: '1000', pctComplete: 50, plannedEnd: '2026-01-01' })];
    // routes: evm() task scan → evm() non-billable sum → project_etc scan (empty)
    const svc = evmSvc([tasks, [{ v: '200' }], []], { rowOf: async () => ({ id: 1, costToDate: '300', budgetAmount: '0' }) });
    const r = await svc.eacScenarios('P-1');
    expect(r).toMatchObject({ project_code: 'P-1', ac: 500, bac: 1000, formulaic: { etc: 500, eac: 1000 }, bottom_up: null, variance: null, entries: [] });
  });

  it('sums the LATEST entry per task/project-level bucket into a bottom-up EAC, with variance vs formulaic', async () => {
    const tasks = [task(1, { plannedCost: '1000', pctComplete: 50, plannedEnd: '2026-01-01' })];
    const etcRows = [
      { taskId: 1, etcAmount: '700', note: 'stale', createdAt: 'T1' },
      { taskId: 1, etcAmount: '600', note: 'latest for task 1', createdAt: 'T2' }, // supersedes the row above
      { taskId: null, etcAmount: '100', note: 'contingency', createdAt: 'T3' },
    ];
    const svc = evmSvc([tasks, [{ v: '200' }], etcRows], { rowOf: async () => ({ id: 1, costToDate: '300', budgetAmount: '0' }) });
    const r = await svc.eacScenarios('P-1');
    expect(r.formulaic).toEqual({ etc: 500, eac: 1000 });
    expect(r.bottom_up).toEqual({ etc: 700, eac: 1200, entry_count: 2 }); // 600 (task 1, latest) + 100 (project-level) = 700
    expect(r.variance).toEqual({ eac_delta: 200, etc_delta: 200 });
    expect(r.entries).toEqual([
      { task_id: 1, etc_amount: 600, note: 'latest for task 1' },
      { task_id: null, etc_amount: 100, note: 'contingency' },
    ]);
  });

  it('submitEtc rejects an unknown task_id with TASK_NOT_FOUND, writing nothing', async () => {
    const { svc, cap } = evmWriteSvc([[]]); // task lookup returns nothing
    await expect(svc.submitEtc('P-1', { task_id: 999, etc_amount: 100 } as any, { username: 'pm' } as any))
      .rejects.toMatchObject({ response: { code: 'TASK_NOT_FOUND' } });
    expect(cap.inserts).toHaveLength(0);
  });

  it('submitEtc inserts a project-level entry (task_id omitted) and returns the refreshed EAC scenarios', async () => {
    const tasks = [task(1, { plannedCost: '1000', pctComplete: 50, plannedEnd: '2026-01-01' })];
    // PROJ (evmWriteSvc's fixed rowOf row): costToDate 800, tenantId 1.
    // routes: (no task lookup — task_id omitted) → eacScenarios: evm tasks → evm nb sum → project_etc scan
    const { svc, cap } = evmWriteSvc([tasks, [{ v: '200' }], [{ taskId: null, etcAmount: '750', note: 'mgmt override', createdAt: 'T1' }]]);
    const r = await svc.submitEtc('P-1', { etc_amount: 750, note: 'mgmt override' } as any, { username: 'pm' } as any);
    expect(cap.inserts[0]).toMatchObject({ tenantId: 1, projectId: 1, taskId: null, etcAmount: '750.00', note: 'mgmt override', createdBy: 'pm' });
    expect(r.formulaic).toEqual({ etc: 1000, eac: 2000 });        // ac=1000 (800+200), bac=1000, ev=500, cpi=0.5
    expect(r.bottom_up).toEqual({ etc: 750, eac: 1750, entry_count: 1 });
    expect(r.variance).toEqual({ eac_delta: -250, etc_delta: -250 });
  });

  it('submitEtc validates the task belongs to the project before inserting a per-task entry', async () => {
    const tasks = [task(1, { plannedCost: '1000', pctComplete: 50, plannedEnd: '2026-01-01' })];
    // routes: task lookup (found) → eacScenarios: evm tasks → evm nb sum → project_etc scan
    const { svc, cap } = evmWriteSvc([[{ id: 1 }], tasks, [{ v: '200' }], [{ taskId: 1, etcAmount: '400', note: null, createdAt: 'T1' }]]);
    const r = await svc.submitEtc('P-1', { task_id: 1, etc_amount: 400 } as any, { username: 'pm' } as any);
    expect(cap.inserts[0]).toMatchObject({ tenantId: 1, projectId: 1, taskId: 1, etcAmount: '400.00', createdBy: 'pm' });
    expect(r.bottom_up).toMatchObject({ etc: 400, entry_count: 1 });
  });
});

describe('ProjectsEvmService — earnedSchedule (PROJ-19 Lipke ES / SPI(t) / SV(t))', () => {
  // routes per call: earned-schedule task scan → evm() task scan → evm() non-billable sum
  const esSvc = (tasks: any[], rowOf?: (code: string) => Promise<any>) =>
    evmSvc([tasks, tasks, [{ v: '0' }]], rowOf ? { rowOf } : {});

  it('catches the slip the classic SPI hides: 2-month plan 95% earned read at month 6', async () => {
    // Jan 1000 + Feb 1000, both 95% → EV 1900. Classic SPI = 1900/2000 = 0.95 (reads fine); ES crosses the
    // Feb bucket at 1 + 900/1000 = 1.9 months vs AT = 6.0 (as_of month-end June) → SPI(t) 0.3167 RED.
    const svc = esSvc([
      task(1, { plannedCost: '1000', pctComplete: 95, plannedEnd: '2026-01-31' }),
      task(2, { plannedCost: '1000', pctComplete: 95, plannedEnd: '2026-02-28' }),
    ]);
    const r = await svc.earnedSchedule('P-1', '2026-06-30');
    expect(r).toMatchObject({
      start_month: '2026-01', planned_duration_months: 2,
      earned_schedule_months: 1.9, actual_time_months: 6,
      spi_t: 0.3167, sv_t_months: -4.1, eac_t_months: 6.32, forecast_finish_month: '2026-07',
      spi: 0.95, schedule_rag: 'red',
    });
  });

  it('an EV sitting on a flat PV plateau is credited as earned (reads ahead, never a false slip)', async () => {
    // Jan 1000 done, next planned cost only in Dec → EV 1000 sits on the Jan→Dec plateau; ES lands at the
    // start of the December bucket (11 months) so SPI(t) = 11/6 reads ahead, not behind.
    const svc = esSvc([
      task(1, { plannedCost: '1000', pctComplete: 100, plannedEnd: '2026-01-31' }),
      task(2, { plannedCost: '1000', pctComplete: 0, plannedEnd: '2026-12-31' }),
    ]);
    const r = await svc.earnedSchedule('P-1', '2026-06-30');
    expect(r.earned_schedule_months).toBe(11);
    expect(r.spi_t).toBe(1.8333);
    expect(r.schedule_rag).toBe('green');
  });

  it('a fully-earned plan pins ES at the planned duration (a late finish still reads behind)', async () => {
    const svc = esSvc([
      task(1, { plannedCost: '1000', pctComplete: 100, plannedEnd: '2026-01-31' }),
      task(2, { plannedCost: '1000', pctComplete: 100, plannedEnd: '2026-02-28' }),
    ]);
    const r = await svc.earnedSchedule('P-1', '2026-06-30');
    expect(r.earned_schedule_months).toBe(2); // = planned_duration_months
    expect(r.spi_t).toBe(0.3333);             // 2 / 6 — done, but 4 months late
  });

  it('zero EV → ES 0, SPI(t) 0 and no finish forecast (guarded division)', async () => {
    const svc = esSvc([task(1, { plannedCost: '1000', pctComplete: 0, plannedEnd: '2026-01-31' })]);
    const r = await svc.earnedSchedule('P-1', '2026-06-30');
    expect(r).toMatchObject({ earned_schedule_months: 0, spi_t: 0, sv_t_months: -6, eac_t_months: null, forecast_finish_month: null, schedule_rag: 'red' });
  });

  it('no costed dated plan → explicit NO_DATED_PLAN, no phantom metric', async () => {
    const svc = esSvc([task(1, { plannedCost: '0', plannedEnd: '2026-01-31' })]);
    const r = await svc.earnedSchedule('P-1', '2026-06-30');
    expect(r).toMatchObject({ spi_t: null, earned_schedule_months: null, reason: 'NO_DATED_PLAN', schedule_rag: 'no_data' });
  });

  it('a plan entirely in the future → PLAN_NOT_STARTED (AT clamped to 0)', async () => {
    const svc = esSvc([task(1, { plannedCost: '1000', pctComplete: 50, plannedEnd: '2099-12-31' })]);
    const r = await svc.earnedSchedule('P-1', '2026-06-30');
    expect(r).toMatchObject({ start_month: '2099-12', planned_duration_months: 1, actual_time_months: 0, spi_t: null, reason: 'PLAN_NOT_STARTED', schedule_rag: 'no_data' });
  });

  it('a task with no planned_end buckets into the project start month', async () => {
    const svc = esSvc(
      [task(1, { plannedCost: '800', pctComplete: 100, plannedEnd: null })],
      async () => ({ id: 1, startDate: '2026-03-15', costToDate: '0', budgetAmount: '0' }),
    );
    const r = await svc.earnedSchedule('P-1', '2026-06-30');
    expect(r.start_month).toBe('2026-03');
    expect(r.earned_schedule_months).toBe(1); // fully earned, 1-month plan
  });

  it('a tampered/malformed as_of query param is ignored (typeof + shape guard falls back to today)', async () => {
    const T = [task(1, { plannedCost: '1000', pctComplete: 100, plannedEnd: '2026-01-31' })];
    const arr = await esSvc(T).earnedSchedule('P-1', ['2026-06-30'] as any);
    expect(arr.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/); // not the array — the real business day
    const bad = await esSvc(T).earnedSchedule('P-1', '2026-6-30' as any);
    expect(bad.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(bad.as_of).not.toBe('2026-6-30');
  });
});

describe('ProjectsEvmService — ragOf bands (PPM health)', () => {
  const svc = evmSvc([[]]);
  it.each([
    [null, null, 'no_data'],
    [0.85, 1.2, 'red'],    // either index < 0.9 → red
    [1.2, 0.95, 'amber'],  // either index < 1 → amber
    [1, 1.1, 'green'],
  ] as const)('cpi=%s spi=%s → %s', (cpi, spi, want) => {
    expect(svc.ragOf(cpi as any, spi as any)).toBe(want);
  });
});

describe('ProjectsEvmService — captureBaseline re-baseline guard (PROJ-07)', () => {
  it('re-baselining over an ACTIVE baseline without a reason is BASELINE_REASON_REQUIRED — nothing written', async () => {
    // routes: currentPlan task scan → schedule task scan → schedule depRows (PPM-B1, empty) → active-baseline lookup
    const svc = evmSvc(
      [[task(1, { plannedCost: '1000' })], [task(1, { plannedCost: '1000' })], [], [{ id: 3, status: 'active', baselineBac: '1000' }]],
      { noWrites: true },
    );
    await expect(svc.captureBaseline('P-1', {} as any, { username: 'pm' } as any)).rejects.toMatchObject({ response: { code: 'BASELINE_REASON_REQUIRED' } });
  });
});

// ───────────────────── slice 7: health snapshots, baseline writes, programs ─────────────────────
// A write-capable env: routed selects (strict — an unexpected extra read throws), captured
// inserts/updates, and the four facade ports (rowOf/getOf/fmtOf/emit) observable.

type EvmCap = { inserts: any[]; conflicts: any[]; updates: any[]; emits: any[] };

function evmWriteSvc(routes: any[][], opts: { fmt?: any } = {}) {
  const cap: EvmCap = { inserts: [], conflicts: [], updates: [], emits: [] };
  let call = 0;
  const chain = (rows: any[]) => {
    const p: any = { from: () => p, where: () => p, limit: () => p, orderBy: () => p, then: (r: any, j: any) => Promise.resolve(rows).then(r, j) };
    return p;
  };
  const db: any = {
    select: () => { if (call >= routes.length) throw new Error(`unexpected select #${call + 1} — add a route`); return chain(routes[call++] ?? []); },
    insert: () => ({ values: (v: any) => { cap.inserts.push(v); return { onConflictDoUpdate: (c: any) => { cap.conflicts.push(c); return Promise.resolve(); }, onConflictDoNothing: () => Promise.resolve() }; } }),
    update: () => ({ set: (v: any) => ({ where: () => { cap.updates.push(v); return Promise.resolve(); } }) }),
  };
  const rowOf = async () => PROJ;
  const getOf = async () => ({ project_code: 'P-1', refreshed: true });
  const fmtOf = () => opts.fmt ?? { margin: 42, wip: 7 };
  const emit = (...a: any[]) => { cap.emits.push(a); };
  const svc = new ProjectsEvmService(db, { taskRollup: (_tasks: any[]) => 55 } as any, rowOf as any, getOf as any, fmtOf as any, emit as any);
  return { svc, cap };
}

const PROJ = { id: 1, projectCode: 'P-1', tenantId: 1, costToDate: '800', budgetAmount: '0', endDate: null };

describe('ProjectsEvmService — captureHealth / snapProject (PPM health, PMO-1 red alert)', () => {
  // one task: EV 500, PV 1000 → with AC 800: CPI 0.625 (<0.9) ⇒ RED
  const RED_TASKS = [task(1, { plannedCost: '1000', pctComplete: 50, plannedEnd: '2026-01-01' })];

  it('upserts a dated snapshot (idempotent per project+date) and a RED rag wakes the action center', async () => {
    // routes: evm task scan → evm non-billable sum → rollup task scan
    const { svc, cap } = evmWriteSvc([RED_TASKS, [{ v: '0' }], RED_TASKS]);
    const r = await svc.captureHealth('P-1', { as_of: '2026-06-30' }, { username: 'pm' } as any);
    expect(r).toMatchObject({ project_code: 'P-1', snapshot_date: '2026-06-30', rag: 'red', cpi: 0.625, spi: 0.5, margin: 42 });
    expect(cap.inserts[0]).toMatchObject({
      projectId: 1, tenantId: 1, snapshotDate: '2026-06-30', rag: 'red',
      cpi: '0.6250', spi: '0.5000', pctComplete: '55.00', bac: '1000.00', ev: '500.00', ac: '800.00',
      margin: '42.00', wip: '7.00', createdBy: 'pm',
    });
    expect(cap.conflicts).toHaveLength(1); // ON CONFLICT (project, date) DO UPDATE — re-capture refreshes
    expect(cap.emits[0]).toEqual([1, 'project_red', 'high', 'P-1', { cpi: 0.625, spi: 0.5, snapshot_date: '2026-06-30' }]);
  });

  it('a healthy project snapshots GREEN and does NOT wake the action center', async () => {
    const green = [task(1, { plannedCost: '1000', pctComplete: 100, plannedEnd: '2026-01-01' })];
    const { svc, cap } = evmWriteSvc([green, [{ v: '0' }], green]); // AC 800 → CPI 1.25, SPI 1
    const r = await svc.captureHealth('P-1', { as_of: '2026-06-30' }, { username: 'pm' } as any);
    expect(r.rag).toBe('green');
    expect(cap.emits).toHaveLength(0);
  });
});

describe('ProjectsEvmService — programs() portfolio rollup (PMO-4)', () => {
  it('groups projects by program and reports each program duration + critical path', async () => {
    const rows = [
      { projectCode: 'A', name: 'a', status: 'active', programCode: 'PRG-1', dependsOnProjects: null },
      { projectCode: 'B', name: 'b', status: 'active', programCode: 'PRG-1', dependsOnProjects: 'A' },
    ];
    // routes: program-code scan → programCriticalPath: members → A's schedule tasks → A's depRows (PPM-B1,
    // empty) → B's schedule tasks → B's depRows (PPM-B1, empty)
    const svc = evmSvc([rows, rows, [task(11, { plannedHours: '40' })], [], [task(21, { plannedHours: '24' })], []],
      { rowOf: async (code: string) => ({ id: code === 'A' ? 1 : 2 }) });
    const r = await svc.programs({ username: 'pmo' } as any);
    expect(r.count).toBe(1);
    expect(r.programs[0]).toEqual({ program_code: 'PRG-1', member_count: 2, program_duration_days: 8, critical_path: ['A', 'B'] });
  });
});

describe('ProjectsEvmService — captureAllHealth (scheduled BI action path)', () => {
  it('snapshots every project and reports scanned/captured', async () => {
    const T = [task(1, { plannedCost: '1000', pctComplete: 100, plannedEnd: '2026-01-01' })];
    // routes: project scan → snapProject: evm tasks → nb sum → rollup tasks
    const { svc, cap } = evmWriteSvc([[PROJ], T, [{ v: '0' }], T]);
    const r = await svc.captureAllHealth({ username: 'scheduler' } as any);
    expect(r).toMatchObject({ scanned: 1, captured: 1 });
    expect(cap.inserts).toHaveLength(1);
    expect(cap.inserts[0]).toMatchObject({ projectId: 1, createdBy: 'scheduler' });
  });
});

describe('ProjectsEvmService — healthHistory trajectory', () => {
  it('maps the dated snapshots ascending with numeric indices', async () => {
    const { svc } = evmWriteSvc([[
      { snapshotDate: '2026-06-01', rag: 'amber', cpi: '0.9500', spi: '1.0000', pctComplete: '40.00', bac: '1000', ev: '400', ac: '420', eac: '1052.63', margin: '10', wip: '5', createdAt: 'T1' },
    ]]);
    const r = await svc.healthHistory('P-1');
    expect(r.count).toBe(1);
    expect(r.history[0]).toMatchObject({ snapshot_date: '2026-06-01', rag: 'amber', cpi: 0.95, spi: 1, bac: 1000 });
  });
});

describe('ProjectsEvmService — captureBaseline write paths (PROJ-07)', () => {
  const T = [task(1, { plannedCost: '1000', plannedHours: '8' })];
  const ACTIVE = { id: 1, status: 'active', label: 'Baseline', baselineBac: '1000', baselineDurationDays: 1, baselineEnd: null, reason: null, createdBy: 'pm', capturedAt: 'T1' };

  it('the FIRST baseline is free: snapshots current BAC + CP duration as active, zero variance', async () => {
    // routes: currentPlan tasks → schedule tasks → schedule calRow (PPM-B1, PROJ.tenantId=1 so this select
    // fires; empty = no calendar row) → schedule depRows (PPM-B1, empty) → active lookup (none) →
    // [getBaseline] all-baselines → currentPlan tasks → schedule tasks → schedule calRow → schedule depRows
    const { svc, cap } = evmWriteSvc([T, T, [], [], [], [ACTIVE], T, T, [], []]);
    const r = await svc.captureBaseline('P-1', {} as any, { username: 'pm' } as any);
    expect(cap.inserts[0]).toMatchObject({ projectId: 1, label: 'Baseline', baselineBac: '1000.00', baselineDurationDays: 1, status: 'active', createdBy: 'pm', reason: null });
    expect(cap.updates).toHaveLength(0); // nothing to supersede
    expect(r.baseline).toMatchObject({ label: 'Baseline', baseline_bac: 1000, status: 'active' });
    expect(r.variance).toEqual({ bac_delta: 0, bac_pct: 0, duration_delta: 0 });
  });

  it('re-baselining WITH a reason supersedes the prior active baseline (history preserved)', async () => {
    // routes: see the FIRST-baseline test above (PPM-B1 adds a calRow + depRows select per schedule() call)
    const { svc, cap } = evmWriteSvc([T, T, [], [], [{ ...ACTIVE, id: 3 }], [ACTIVE], T, T, [], []]);
    await svc.captureBaseline('P-1', { reason: 'scope change' } as any, { username: 'pm2' } as any);
    expect(cap.updates[0]).toEqual({ status: 'superseded' });
    expect(cap.inserts[0]).toMatchObject({ label: 'Re-baseline', reason: 'scope change', status: 'active', createdBy: 'pm2' });
  });
});

describe('ProjectsEvmService — setProgram (PMO-4 grouping + dependency guards)', () => {
  it('a project cannot depend on itself (BAD_DEPENDENCY)', async () => {
    const { svc, cap } = evmWriteSvc([]);
    await expect(svc.setProgram('P-1', { depends_on_projects: ['P-1'] } as any, { username: 'pm' } as any))
      .rejects.toMatchObject({ response: { code: 'BAD_DEPENDENCY' } });
    expect(cap.updates).toHaveLength(0);
  });

  it('an unknown dependency project is DEP_PROJECT_NOT_FOUND', async () => {
    const { svc } = evmWriteSvc([[]]); // existence lookup returns nothing
    await expect(svc.setProgram('P-1', { depends_on_projects: ['P-404'] } as any, { username: 'pm' } as any))
      .rejects.toMatchObject({ response: { code: 'DEP_PROJECT_NOT_FOUND' } });
  });

  it('stores the program code + deduped dependency CSV and returns the refreshed project', async () => {
    const { svc, cap } = evmWriteSvc([[{ id: 2 }], [{ id: 3 }]]); // P-2, P-3 both exist
    const r = await svc.setProgram('P-1', { program_code: ' PRG-1 ', depends_on_projects: ['P-2', 'P-2', 'P-3'] } as any, { username: 'pm' } as any);
    expect(cap.updates[0]).toEqual({ programCode: 'PRG-1', dependsOnProjects: 'P-2,P-3' });
    expect(r).toEqual({ project_code: 'P-1', refreshed: true });
  });
});

describe('ProjectsEvmService — working calendar CRUD (PPM-B1, PROJ-21)', () => {
  it('getCalendar defaults to disabled + weekend-only when no tenant row exists yet', async () => {
    const { svc } = evmWriteSvc([[]]);
    const r = await svc.getCalendar({ tenantId: 1, username: 'u' } as any);
    expect(r).toEqual({ enabled: false, non_working_weekdays: [0, 6] });
  });

  it('getCalendar reflects an existing enabled row with custom non-working weekdays', async () => {
    const { svc } = evmWriteSvc([[{ enabled: true, nonWorkingWeekdays: '5,6' }]]);
    const r = await svc.getCalendar({ tenantId: 1, username: 'u' } as any);
    expect(r).toEqual({ enabled: true, non_working_weekdays: [5, 6] });
  });

  it('setCalendar inserts a new row for a tenant with none yet, then returns the refreshed calendar', async () => {
    // routes: existing-lookup (none) → getCalendar re-read
    const { svc, cap } = evmWriteSvc([[], [{ enabled: true, nonWorkingWeekdays: '0,6' }]]);
    const r = await svc.setCalendar({ enabled: true, non_working_weekdays: [0, 6] } as any, { tenantId: 1, username: 'pm' } as any);
    expect(cap.inserts[0]).toMatchObject({ tenantId: 1, enabled: true, nonWorkingWeekdays: '0,6', createdBy: 'pm' });
    expect(r).toEqual({ enabled: true, non_working_weekdays: [0, 6] });
  });

  it('setCalendar updates an existing row, keeping its prior weekdays when none are supplied', async () => {
    const existing = { id: 5, enabled: false, nonWorkingWeekdays: '0,6' };
    const { svc, cap } = evmWriteSvc([[existing], [{ ...existing, enabled: true }]]);
    const r = await svc.setCalendar({ enabled: true } as any, { tenantId: 1, username: 'pm' } as any);
    expect(cap.updates[0]).toEqual({ enabled: true, nonWorkingWeekdays: '0,6' });
    expect(r).toEqual({ enabled: true, non_working_weekdays: [0, 6] });
  });

  it('addCalendarException inserts (idempotent on conflict) and returns the refreshed exception list', async () => {
    const { svc, cap } = evmWriteSvc([[{ exceptionDate: '2026-12-25', description: 'Christmas' }]]);
    const r = await svc.addCalendarException({ exception_date: '2026-12-25', description: 'Christmas' } as any, { tenantId: 1, username: 'pm' } as any);
    expect(cap.inserts[0]).toMatchObject({ tenantId: 1, exceptionDate: '2026-12-25', description: 'Christmas', createdBy: 'pm' });
    expect(r).toEqual({ exceptions: [{ exception_date: '2026-12-25', description: 'Christmas' }], count: 1 });
  });

  it('listCalendarExceptions maps rows to the public shape', async () => {
    const { svc } = evmWriteSvc([[{ exceptionDate: '2026-01-01', description: null }]]);
    const r = await svc.listCalendarExceptions({} as any);
    expect(r).toEqual({ exceptions: [{ exception_date: '2026-01-01', description: null }], count: 1 });
  });
});

describe('ProjectsEvmService — simulateChangeOrder (PROJ-24 change-order what-if)', () => {
  // Read-only projection; the db.select sequence is: CO lookup → project lookup → evm() task scan →
  // evm() non-billable sum → the projectTasks planned-cost sum (BAC basis). rowOf feeds evm()'s project.
  const CO = (extra: any = {}) => ({ id: 7, coNo: 'CO-1', status: 'pending', projectId: 1, contractDelta: '0', budgetDelta: '0', estimatedCostDelta: '0', ...extra });

  it('projects a pending CO on a budget-basis project: margin +5000, bac_basis budget, EAC 180000', async () => {
    const proj = { id: 1, projectCode: 'PRJ-SIM', contractAmount: '200000', budgetAmount: '150000', estimatedCost: '140000', costToDate: '0' };
    // no task carries a planned cost → evm() falls back to the project budget (bac_basis 'budget'), so the
    // CO's budget delta moves the BAC/EAC; empty evm task scan + zero projectTasks sum drive that fallback.
    const svc = evmSvc(
      [[CO({ contractDelta: '50000', budgetDelta: '30000', estimatedCostDelta: '45000' })], [proj], [], [{ v: '0' }], [{ v: '0' }]],
      { rowOf: async () => proj, noWrites: true },
    );
    const r = await svc.simulateChangeOrder(7);
    expect(r).toMatchObject({ change_order: 'CO-1', project_code: 'PRJ-SIM', status: 'pending', bac_basis: 'budget' });
    expect(r.current).toMatchObject({ contract_amount: 200000, budget_amount: 150000, estimated_cost: 140000, margin: 60000, margin_pct: 30, eac: 150000, budget_headroom: 0 });
    expect(r.projected).toMatchObject({ contract_amount: 250000, budget_amount: 180000, estimated_cost: 185000, margin: 65000, margin_pct: 26, bac: 180000, eac: 180000, budget_headroom: 0 });
    expect(r.delta).toEqual({ contract: 50000, budget: 30000, estimated_cost: 45000, margin: 5000, eac: 30000, budget_headroom: 0 });
  });

  it('a task-basis project keeps the BAC (and EAC) fixed under a money-only CO; headroom moves with the budget delta', async () => {
    const proj = { id: 1, projectCode: 'PRJ-T', contractAmount: '300000', budgetAmount: '200000', estimatedCost: '250000', costToDate: '400' };
    const evmTasks = [task(1, { plannedCost: '1000', pctComplete: 50, plannedEnd: '2026-01-01' })]; // BAC 1000, EV 500
    const svc = evmSvc(
      [[CO({ budgetDelta: '50000' })], [proj], evmTasks, [{ v: '0' }], [{ v: '1000' }]], // projectTasks sum > 0 → task basis
      { rowOf: async () => proj, noWrites: true },
    );
    const r = await svc.simulateChangeOrder(7);
    expect(r.bac_basis).toBe('tasks');
    expect(r.projected.bac).toBe(1000);          // a task-derived BAC is unaffected by the money CO
    expect(r.delta.eac).toBe(0);                 // EAC unchanged when estimated cost + BAC are unchanged
    expect(r.delta.budget_headroom).toBe(50000); // headroom rises by exactly the budget delta
    expect(r.delta.contract).toBe(0);
  });

  it('a missing change order is CHANGE_ORDER_NOT_FOUND', async () => {
    const svc = evmSvc([[]], { noWrites: true });
    await expect(svc.simulateChangeOrder(404)).rejects.toMatchObject({ response: { code: 'CHANGE_ORDER_NOT_FOUND' } });
  });

  it('an already-decided change order cannot be simulated (CHANGE_ORDER_DECIDED)', async () => {
    const svc = evmSvc([[CO({ status: 'approved' })]], { noWrites: true });
    await expect(svc.simulateChangeOrder(7)).rejects.toMatchObject({ response: { code: 'CHANGE_ORDER_DECIDED' } });
  });

  it('a change order pointing at a missing project is PROJECT_NOT_FOUND', async () => {
    const svc = evmSvc([[CO()], []], { noWrites: true });
    await expect(svc.simulateChangeOrder(7)).rejects.toMatchObject({ response: { code: 'PROJECT_NOT_FOUND' } });
  });
});
