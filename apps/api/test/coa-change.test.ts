import { describe, expect, it } from 'vitest';

import { CoaService } from '../src/modules/ledger/coa.service';

// GL-27 (COA follow-up C) — canonical CoA maker-checker unit ToE. The harness DBs always carry MANY
// Admin users, so the SINGLE-ADMIN EXCEPTION (owner decision 2026-07-12: with exactly one active Admin
// the change applies immediately, recorded AutoApplied) is only exercisable here, with a fake db that
// pins the Admin count. The staging path and the self-approve SoD guard are asserted too (they are
// also re-performed end-to-end by the compliance harness).

// Sequential drizzle-shaped read fake + write capture: select() chains resolve the next canned row
// list; insert(...).values(v).returning() echoes v with an id and records it for assertions.
function fakeDb(selectRoutes: any[][], inserts: any[]): any {
  let call = 0;
  const chain = (rows: any[]) => {
    const p: any = {
      from: () => p, where: () => p, limit: () => p, orderBy: () => p,
      then: (res: any, rej: any) => Promise.resolve(rows).then(res, rej),
    };
    return p;
  };
  return {
    select: () => chain(selectRoutes[Math.min(call++, selectRoutes.length - 1)] ?? []),
    insert: () => ({ values: (v: any) => { inserts.push(v); return { returning: async () => [{ id: 77, ...v }] }; } }),
    update: () => { throw new Error('unexpected update in this path'); },
  };
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); } catch (e: any) { return e?.response?.code ?? e?.code ?? String(e); }
  return 'NO_THROW';
}

const CREATE_DTO = { code: '9990', name: 'Unit Expense', type: 'Expense' } as any;

describe('CoaService — GL-27 canonical CoA maker-checker', () => {
  it('single-Admin exception: exactly ONE active Admin → the create applies immediately, recorded AutoApplied', async () => {
    const inserts: any[] = [];
    // routes: 1 validateChange account lookup (miss) · 2 pending-request lookup (none) · 3 admin count = 1
    // · 4 createAccount duplicate re-check (miss)
    const svc = new CoaService(fakeDb([[], [], [{ n: '1' }], []], inserts) as any);
    const res: any = await svc.requestChange('create', '9990', CREATE_DTO, { username: 'solo' });
    expect(res.change_request?.status).toBe('AutoApplied');
    const acct = inserts.find((v) => v.code === '9990');
    const req = inserts.find((v) => v.action === 'create');
    expect(acct?.name).toBe('Unit Expense');            // the account WAS written
    expect(req?.status).toBe('AutoApplied');            // …and the exception is on the trail
    expect(req?.approvedBy).toBe('solo');
    expect(String(req?.reason)).toContain('single-admin');
  });

  it('with ≥2 active Admins the create STAGES PendingApproval and writes NO account', async () => {
    const inserts: any[] = [];
    const svc = new CoaService(fakeDb([[], [], [{ n: '2' }]], inserts) as any);
    const res: any = await svc.requestChange('create', '9990', CREATE_DTO, { username: 'maker' });
    expect(res.status).toBe('PendingApproval');
    expect(inserts.some((v) => v.code === '9990')).toBe(false);   // chart untouched
    expect(inserts.find((v) => v.action === 'create')?.createdBy).toBe('maker');
  });

  it('a second request for the same code while one is pending → CHANGE_ALREADY_PENDING', async () => {
    const svc = new CoaService(fakeDb([[], [{ id: 5 }]], []) as any);
    expect(await code(() => svc.requestChange('create', '9990', CREATE_DTO, { username: 'maker' }))).toBe('CHANGE_ALREADY_PENDING');
  });

  it('creator self-approval → SOD_VIOLATION (binds even Admin)', async () => {
    const svc = new CoaService(fakeDb([[{ id: 9, status: 'PendingApproval', createdBy: 'maker', action: 'create', accountCode: '9990', payload: CREATE_DTO }]], []) as any);
    expect(await code(() => svc.approveChange(9, { username: 'maker' } as any))).toBe('SOD_VIOLATION');
  });

  // Sub-account scaffolding — a parent-child code (e.g. 5150 ค่าเดินทาง → 515001 ค่าเครื่องบิน) must share
  // its parent's account type and can't name itself as parent (validated fail-closed at request time).
  const SUB_DTO = { code: '515001', name: 'Airfare', type: 'Expense', parentCode: '5150' } as any;

  it('a sub-account whose type differs from its parent → PARENT_TYPE_MISMATCH', async () => {
    // routes: existing-account miss · parent lookup (an Asset) — dto type Expense ≠ Asset
    const svc = new CoaService(fakeDb([[], [{ code: '5150', type: 'Asset' }]], []) as any);
    expect(await code(() => svc.requestChange('create', '515001', SUB_DTO, { username: 'maker' }))).toBe('PARENT_TYPE_MISMATCH');
  });

  it('an account that names itself as parent → PARENT_SELF', async () => {
    const svc = new CoaService(fakeDb([[]], []) as any); // existing miss; parent===code throws before the parent lookup
    expect(await code(() => svc.requestChange('create', '5150', { ...SUB_DTO, code: '5150', parentCode: '5150' }, { username: 'maker' }))).toBe('PARENT_SELF');
  });

  it('a same-type sub-account STAGES PendingApproval (Expense under an Expense header)', async () => {
    const inserts: any[] = [];
    // routes: existing miss · parent lookup (an Expense) · pending none · admin count = 2
    const svc = new CoaService(fakeDb([[], [{ code: '5150', type: 'Expense' }], [], [{ n: '2' }]], inserts) as any);
    const res: any = await svc.requestChange('create', '515001', SUB_DTO, { username: 'maker' });
    expect(res.status).toBe('PendingApproval');
    expect(inserts.find((v) => v.action === 'create')?.accountCode).toBe('515001');
  });
});
