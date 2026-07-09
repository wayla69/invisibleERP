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
});

describe('ProjectsEvmService — programCriticalPath (PMO-4 cross-project CPM)', () => {
  it('chains member projects finish-to-start; an independent member carries slack', async () => {
    // A (40h ⇒ 5d) ← B (24h ⇒ 3d, depends on A); C (16h ⇒ 2d, independent) → program 8d, CP = A→B
    const ids: Record<string, number> = { A: 1, B: 2, C: 3 };
    const svc = evmSvc(
      [
        [ // program member scan
          { projectCode: 'A', name: 'a', status: 'active', dependsOnProjects: null },
          { projectCode: 'B', name: 'b', status: 'active', dependsOnProjects: 'A,X-NOT-MEMBER' }, // non-members filtered
          { projectCode: 'C', name: 'c', status: 'active', dependsOnProjects: null },
        ],
        [task(11, { plannedHours: '40' })], // A's schedule
        [task(21, { plannedHours: '24' })], // B's schedule
        [task(31, { plannedHours: '16' })], // C's schedule
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
    // routes: currentPlan task scan → schedule task scan → active-baseline lookup
    const svc = evmSvc(
      [[task(1, { plannedCost: '1000' })], [task(1, { plannedCost: '1000' })], [{ id: 3, status: 'active', baselineBac: '1000' }]],
      { noWrites: true },
    );
    await expect(svc.captureBaseline('P-1', {} as any, { username: 'pm' } as any)).rejects.toMatchObject({ response: { code: 'BASELINE_REASON_REQUIRED' } });
  });
});
