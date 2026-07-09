import { describe, expect, it } from 'vitest';

import { ClaimsService } from '../src/modules/claims/claims.service';

// Unit tests for claims (2.4 slice 10 — the EXP-12 claim-window control joins the gate). The window is
// enforced against goods_receipts.created_at (fallback: gr_date at midnight +07:00) with the tenant's
// receiving_settings.claim_window_hours (default 24) — a defect must be raised while the delivery is
// still verifiable, after that the system refuses the claim (CLAIM_WINDOW_CLOSED).
// STRICT routed env — same convention as the sibling suites.

type ClaimsCap = { inserts: any[]; updates: any[] };

function claimsEnv(routes: any[][]) {
  const cap: ClaimsCap = { inserts: [], updates: [] };
  let call = 0;
  const chain = (rows: any[]) => {
    const p: any = { from: () => p, where: () => p, limit: () => p, orderBy: () => p, leftJoin: () => p, then: (r: any, j: any) => Promise.resolve(rows).then(r, j) };
    return p;
  };
  const db = {
    select: () => { if (call >= routes.length) throw new Error(`unexpected select #${call + 1} — add a route`); return chain(routes[call++] ?? []); },
    insert: () => ({ values: (v: any) => { cap.inserts.push(v); return Object.assign(Promise.resolve(), { returning: () => Promise.resolve([{ id: 77 }]) }); } }),
    update: () => ({ set: (v: any) => ({ where: () => { cap.updates.push(v); return Promise.resolve(); } }) }),
  };
  const svc = new ClaimsService(db as any, { nextDaily: async () => 'GRC-TEST-001' } as any);
  return { svc, cap };
}

const user = { username: 'whrecv', tenantId: null } as any;
const code = async (fn: () => Promise<unknown>) => {
  try { await fn(); } catch (e: any) { return e?.response?.code ?? String(e); }
  return 'NO_THROW';
};
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

describe('ClaimsService — createGrClaim (EXP-12 claim window)', () => {
  it('image guards run BEFORE any read: not a data:image/* URL → BAD_IMAGE; >~2MB → IMAGE_TOO_LARGE', async () => {
    const { svc } = claimsEnv([]); // strict: any read would throw
    expect(await code(() => svc.createGrClaim({ image_data_url: 'https://evil/img.jpg' }, user))).toBe('BAD_IMAGE');
    expect(await code(() => svc.createGrClaim({ image_data_url: `data:image/jpeg;base64,${'x'.repeat(3_000_001)}` }, user))).toBe('IMAGE_TOO_LARGE');
  });

  it('a claim against an unknown GR is NOT_FOUND', async () => {
    const { svc } = claimsEnv([[]]);
    expect(await code(() => svc.createGrClaim({ gr_no: 'GR-404' }, user))).toBe('NOT_FOUND');
  });

  it('a claim opened AFTER the window (default 24h from receipt) is refused — CLAIM_WINDOW_CLOSED', async () => {
    const { svc, cap } = claimsEnv([[{ grNo: 'GR-7', createdAt: hoursAgo(25) }], []]); // gr → settings (default)
    expect(await code(() => svc.createGrClaim({ gr_no: 'GR-7', claim_qty: 1 }, user))).toBe('CLAIM_WINDOW_CLOSED');
    expect(cap.inserts).toHaveLength(0);
  });

  it('the tenant window applies: 48h settings admit an hour-25 claim that the default would refuse', async () => {
    const { svc, cap } = claimsEnv([[{ grNo: 'GR-7', createdAt: hoursAgo(25) }], [{ claimWindowHours: 48 }]]);
    const r = await svc.createGrClaim({ gr_no: 'GR-7', item_id: 'A', claim_qty: 2, reason: 'ของแตก' }, user);
    expect(r).toEqual({ claim_no: 'GRC-TEST-001', status: 'Open', image_attachment_id: null });
    expect(cap.inserts[0]).toMatchObject({ claimNo: 'GRC-TEST-001', grNo: 'GR-7', itemId: 'A', claimQty: '2', reason: 'ของแตก', status: 'Open', imageKey: null });
  });

  it('no created_at → the window anchors on gr_date at midnight +07:00 (an old receipt still refuses)', async () => {
    const { svc } = claimsEnv([[{ grNo: 'GR-OLD', createdAt: null, grDate: '2020-01-01' }], []]);
    expect(await code(() => svc.createGrClaim({ gr_no: 'GR-OLD' }, user))).toBe('CLAIM_WINDOW_CLOSED');
  });

  it('a dock photo is stored FIRST as a GRC doc_attachment and linked into the claim', async () => {
    const { svc, cap } = claimsEnv([[{ grNo: 'GR-7', createdAt: hoursAgo(1) }], []]);
    const r = await svc.createGrClaim({ gr_no: 'GR-7', claim_qty: 1, reason: 'บุบ', image_data_url: 'data:image/jpeg;base64,AAA' }, user);
    expect(cap.inserts[0]).toMatchObject({ docType: 'GRC', docNo: 'GRC-TEST-001', dataUrl: 'data:image/jpeg;base64,AAA', note: 'บุบ', createdBy: 'whrecv' });
    expect(cap.inserts[1]).toMatchObject({ claimNo: 'GRC-TEST-001', imageKey: '77' });
    expect(r.image_attachment_id).toBe(77);
  });

  it('an off-GR claim (no gr_no — legacy free-form flow) skips the window entirely', async () => {
    const { svc, cap } = claimsEnv([]); // strict: NO reads at all
    const r = await svc.createGrClaim({ po_no: 'PO-9', item_id: 'A', claim_qty: 1 }, user);
    expect(r.status).toBe('Open');
    expect(cap.inserts[0]).toMatchObject({ grNo: null, poNo: 'PO-9' });
  });
});

describe('ClaimsService — sales-claim decisions + GR-claim resolution', () => {
  it('a rejection REQUIRES a reason (REASON_REQUIRED, before any read); decisions map to admin_status', async () => {
    const { svc } = claimsEnv([]);
    expect(await code(() => svc.decideSalesClaim(1, 'reject', '  ', user))).toBe('REASON_REQUIRED');
    const a = claimsEnv([[{ id: 1 }]]);
    expect(await a.svc.decideSalesClaim(1, 'approve', undefined, user)).toEqual({ id: 1, admin_status: 'Approved' });
    expect(a.cap.updates[0]).toEqual({ adminStatus: 'Approved', rejectReason: null });
    const b = claimsEnv([[{ id: 1 }]]);
    await b.svc.decideSalesClaim(1, 'reject', 'ไม่มีหลักฐาน', user);
    expect(b.cap.updates[0]).toEqual({ adminStatus: 'Rejected', rejectReason: 'ไม่มีหลักฐาน' });
  });

  it('resolveGrClaim appends the resolution to the reason (gr_claims has no resolution column)', async () => {
    const { svc, cap } = claimsEnv([[{ claimNo: 'GRC-1', reason: 'ของแตก' }]]);
    const r = await svc.resolveGrClaim('GRC-1', 'Resolved', 'ผู้ขายส่งชดเชย', user);
    expect(r).toEqual({ claim_no: 'GRC-1', status: 'Resolved' });
    expect(cap.updates[0]).toEqual({ status: 'Resolved', reason: 'ของแตก | Resolved: ผู้ขายส่งชดเชย' });
  });

  it('resolveGrClaim without a note keeps the original reason; unknown claim is NOT_FOUND', async () => {
    const { svc, cap } = claimsEnv([[{ claimNo: 'GRC-1', reason: 'เดิม' }]]);
    await svc.resolveGrClaim('GRC-1', 'Rejected', undefined, user);
    expect(cap.updates[0]).toEqual({ status: 'Rejected', reason: 'เดิม' });
    const b = claimsEnv([[]]);
    expect(await code(() => b.svc.resolveGrClaim('GRC-404', 'Resolved', undefined, user))).toBe('NOT_FOUND');
  });
});

describe('ClaimsService — listings', () => {
  it('listGrClaims maps rows with numeric quantities and the attachment link', async () => {
    const { svc } = claimsEnv([[{
      claimNo: 'GRC-1', claimDate: '2026-07-09', grNo: 'GR-7', poNo: null, vendorId: 4, itemId: 'A', itemDescription: 'ปลา',
      grQty: '40', claimQty: '2', uom: 'kg', reason: 'บุบ', status: 'Open', imageKey: '77', createdAt: 'T1',
    }]]);
    const r = await svc.listGrClaims('Open');
    expect(r.count).toBe(1);
    expect(r.claims[0]).toMatchObject({ claim_no: 'GRC-1', gr_qty: 40, claim_qty: 2, image_attachment_id: 77 });
  });

  it('listSalesClaims maps the joined order/line fields', async () => {
    const { svc } = claimsEnv([[{ id: 9, order_no: 'SO-1', item_id: 'A', claimed_qty: '1', admin_status: 'Pending' }]]);
    const r = await svc.listSalesClaims();
    expect(r.count).toBe(1);
    expect(r.claims[0]).toMatchObject({ id: 9, order_no: 'SO-1', claimed_qty: 1 });
  });
});
