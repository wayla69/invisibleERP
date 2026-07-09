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
