import { eq, and, or, desc, ilike } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { purchaseRequests, items, invBalances } from '../../database/schema';
import { reportSubscriptions } from '../../database/schema/bi';
import type { JwtUser } from '../../common/decorators';
import { LineLinkService } from './line-link.service';
import { CHAT_USAGE } from './line-cards';
import { DIGEST_KPIS, DEFAULT_DIGEST_KPIS, allowedDigestKpis } from '../bi/digest-kpis';
import { ProcurementService } from '../procurement/procurement.service';
import { ClaimsService } from '../claims/claims.service';
import { PettyCashService } from '../petty-cash/petty-cash.service';
import { EssService } from '../ess/ess.service';
import { PmrService } from '../pmr/pmr.service';
import { NlAnalyticsService } from '../nl-analytics/nl-analytics.service';

export const STATUS_TH: Record<string, string> = { Draft: 'ฉบับร่าง', Pending: 'รออนุมัติ', Approved: 'อนุมัติแล้ว', Rejected: 'ไม่อนุมัติ', Cancelled: 'ยกเลิกแล้ว' };

export const NOT_LINKED =
    'ยังไม่ได้เชื่อมบัญชีพนักงาน — เปิดหน้า "คำขอซื้อ (PR)" ในระบบ ERP กด "เชื่อมต่อ LINE" เพื่อรับรหัส แล้วพิมพ์ link <รหัส> ที่นี่';

// The domain services this chat surface reaches arrive as LAZY GETTER PORTS (docs/46 Phase 4d): the
// webhook service owns the ModuleRef lookups (Messaging → Procurement → … → Messaging is a circular module
// graph, so they cannot be constructor-injected) and hands them down explicitly — this class never touches
// ModuleRef, so its cross-module reach is visible in one place.
export interface ChatActionPorts {
  procurement(): ProcurementService | null;
  pmr(): PmrService | null;
  claims(): ClaimsService | null;
  pettyCash(): PettyCashService | null;
  ess(): EssService | null;
  nl(): NlAnalyticsService | null;
}

// docs/46 Phase 4d — the STATELESS chat command ACTIONS (approve/receive/claim/stock/PR/petty-cash/leave/
// digest/ask …), moved VERBATIM out of line-webhook.controller.ts. Each action re-resolves the linked
// user's effective permissions and routes through the SAME service path as the web (createPr/approvePr/
// createGrClaim/…), so maker-checker/SoD bind identically. A plain class constructed in the
// LineWebhookService constructor BODY; the webhook keeps the matcher/dispatch (the routing table), the
// throttle/dedupe/reply plumbing, and the STATEFUL flows (attach/capture photos, postback confirm, copilot).
export class LineChatActionsService {
  constructor(private readonly db: DrizzleDb, private readonly link: LineLinkService, private readonly ports: ChatActionPorts) {}

  // approve/reject <PR no> — the chat approval channel (0228). The permission mirrors the web endpoint
  // (`procurement`), and the decision routes through ProcurementService.approvePr → the workflow engine,
  // so maker-checker/SoD and multi-level chains bind exactly as on the web.
  async chatDecision(u: any, docNo: string, approve: boolean): Promise<string> {
    const doc = docNo.toUpperCase();
    // M2 (docs/32) — an over-budget Project Material Requisition (PMR-...) approval routes to PmrService, which
    // enforces the same maker-checker (approver ≠ requester) and, on approval, auto-drafts the project PO.
    if (doc.startsWith('PMR-')) return this.chatDecidePmr(u, doc, approve);
    const prNo = doc;
    if (!prNo.startsWith('PR-')) return 'อนุมัติผ่านแชทได้เฉพาะคำขอซื้อ (PR-) หรือใบขอเบิกวัสดุ (PMR-)';
    const perms = await this.link.effectivePerms(u);
    if (!perms.includes('procurement')) return 'บัญชีของคุณไม่มีสิทธิ์อนุมัติคำขอซื้อ (procurement)';
    const procurement = this.ports.procurement();
    if (!procurement) return 'ระบบคำขอซื้อยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const res = await procurement.approvePr(prNo, approve, jwtUser);
      const th = res.status === 'Approved' ? 'อนุมัติแล้ว ✅' : res.status === 'Rejected' ? 'ปฏิเสธแล้ว ❌' : `${STATUS_TH[String(res.status)] ?? res.status} (รอขั้นถัดไป)`;
      return `${prNo}: ${th}`;
    } catch (e: any) {
      if (e?.response?.code === 'SOD_VIOLATION') return `${prNo}: อนุมัติไม่ได้ — ผู้สร้างเอกสารอนุมัติเองไม่ได้ (SOD_VIOLATION)`;
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `${prNo}: ดำเนินการไม่สำเร็จ — ${String(msg).slice(0, 200)}`;
    }
  }

  // M2 (docs/32) — approve/reject an over-budget PMR from chat. Requires procurement/exec; PmrService enforces
  // maker-checker (approver ≠ requester) and, on approval, auto-drafts the project-tagged PO.
  async chatDecidePmr(u: any, pmrNo: string, approve: boolean): Promise<string> {
    const perms = await this.link.effectivePerms(u);
    if (!perms.some((p) => ['procurement', 'exec'].includes(p))) return 'บัญชีของคุณไม่มีสิทธิ์อนุมัติใบขอเบิกวัสดุ (procurement/exec)';
    const pmr = this.ports.pmr();
    if (!pmr) return 'ระบบใบขอเบิกวัสดุยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const res = approve ? await pmr.approve(pmrNo, jwtUser) : await pmr.reject(pmrNo, 'ปฏิเสธผ่านแชท', jwtUser);
      if (approve) return `${pmrNo}: อนุมัติแล้ว ✅ — ร่างใบสั่งซื้อ ${res.linked_doc_no ?? '-'} ให้ฝ่ายจัดซื้อ`;
      return `${pmrNo}: ปฏิเสธแล้ว ❌`;
    } catch (e: any) {
      if (e?.response?.code === 'SOD_SELF_APPROVAL') return `${pmrNo}: อนุมัติไม่ได้ — ผู้ขอเบิกอนุมัติเองไม่ได้ (SOD)`;
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `${pmrNo}: ดำเนินการไม่สำเร็จ — ${String(msg).slice(0, 200)}`;
    }
  }

  // my prs — the caller's 5 most recent requisitions. Replies a flex CAROUSEL (one card per PR, status
  // colour-coded); the text doubles as the altText so clients without flex rendering lose nothing.
  async chatMyPrs(u: any): Promise<{ text: string; flex?: any }> {
    const rows = await this.db.select().from(purchaseRequests).where(eq(purchaseRequests.requestedBy, u.username)).orderBy(desc(purchaseRequests.id)).limit(5);
    if (!rows.length) return { text: 'คุณยังไม่มีคำขอซื้อ — พิมพ์ "pr <รหัสสินค้า> <จำนวน>" เพื่อสร้าง' };
    const text = 'คำขอซื้อล่าสุดของคุณ:\n' + rows.map((r: any) => `• ${r.prNo} — ${STATUS_TH[String(r.status)] ?? r.status}${r.prDate ? ` (${r.prDate})` : ''}`).join('\n');
    const colour: Record<string, string> = { Approved: '#1b7f3b', Rejected: '#b3261e', Cancelled: '#777777', Pending: '#8a6d1d' };
    const flex = {
      type: 'carousel',
      contents: rows.map((r: any) => ({
        type: 'bubble', size: 'micro',
        body: {
          type: 'box', layout: 'vertical', spacing: 'sm', contents: [
            { type: 'text', text: String(r.prNo), weight: 'bold', size: 'sm', wrap: true },
            { type: 'text', text: STATUS_TH[String(r.status)] ?? String(r.status), size: 'sm', color: colour[String(r.status)] ?? '#333333' },
            ...(r.prDate ? [{ type: 'text', text: String(r.prDate), size: 'xs', color: '#888888' }] : []),
          ],
        },
      })),
    };
    return { text, flex };
  }

  // receive <PO no> [<item> <qty>] — warehouse receives goods on an approved PO from chat. Perm wh_receive
  // (or warehouse/procurement), re-resolved per command; the service enforces the EXP-03 approval gate,
  // posts stock + lot movements and auto-closes the PO — the chat only triggers the ordinary GR path.
  // With a trailing item + qty (D4) it receives a PARTIAL quantity of that one line; otherwise all of it.
  async chatReceive(u: any, docNo: string, rest: string[] = []): Promise<string> {
    const poNo = docNo.toUpperCase();
    if (!poNo.startsWith('PO-')) return 'รับของผ่านแชทได้เฉพาะใบสั่งซื้อ (เลขที่ขึ้นต้น PO-)';
    const perms = await this.link.effectivePerms(u);
    if (!perms.includes('wh_receive') && !perms.includes('warehouse') && !perms.includes('procurement')) {
      return 'บัญชีของคุณไม่มีสิทธิ์รับของ (ต้องมี wh_receive / warehouse / procurement)';
    }
    const procurement = this.ports.procurement();
    if (!procurement) return 'ระบบจัดซื้อยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    // D4 — partial: `receive <PO> <item id…> <qty>` (qty is the LAST token; the item id is everything before it).
    const qtyMaybe = rest.length >= 2 ? Number(rest[rest.length - 1]) : NaN;
    const itemId = rest.slice(0, -1).join(' ').trim();
    try {
      if (Number.isFinite(qtyMaybe) && qtyMaybe > 0 && itemId) {
        const res = await procurement.receiveItem(poNo, itemId.toUpperCase(), qtyMaybe, jwtUser);
        const th = res.po_status === 'Closed' ? 'รับครบแล้ว ✅ (ปิด PO)' : 'รับบางส่วนแล้ว';
        return `${poNo}: ${th}\nรับ ${itemId.toUpperCase()} × ${qtyMaybe} · ใบรับของ ${res.gr_no}`;
      }
      const res = await procurement.receiveAllRemaining(poNo, jwtUser);
      const th = res.po_status === 'Closed' ? 'รับครบแล้ว ✅ (ปิด PO)' : 'รับบางส่วนแล้ว';
      return `${poNo}: ${th}\nใบรับของ ${res.gr_no} · ${res.lines} รายการ`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `${poNo}: รับของไม่ได้ — ${String(msg).slice(0, 200)}`;
    }
  }

  // claim <PO/GR no> <qty> [เหตุผล] — open a goods-receipt claim (short/damaged delivery) from chat. Perm
  // procurement/wh_receive. Opens a GRC- via ClaimsService; procurement finishes the detail on /claims.
  async chatClaim(u: any, docNo: string, qtyStr: string, reason: string): Promise<string> {
    const doc = docNo.toUpperCase();
    if (!doc.startsWith('PO-') && !doc.startsWith('GR-')) return 'เปิดเคลมได้เฉพาะใบสั่งซื้อ/ใบรับของ (เลขที่ขึ้นต้น PO- หรือ GR-)';
    const qty = Number(qtyStr);
    if (!Number.isFinite(qty) || qty <= 0) return 'ระบุจำนวนที่เคลม เช่น claim GR-20260101-001 2 ของแตก';
    const perms = await this.link.effectivePerms(u);
    if (!perms.includes('procurement') && !perms.includes('wh_receive') && !perms.includes('warehouse')) {
      return 'บัญชีของคุณไม่มีสิทธิ์เปิดเคลม (ต้องมี procurement / wh_receive)';
    }
    const claims = this.ports.claims();
    if (!claims) return 'ระบบเคลมยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const dto = doc.startsWith('GR-') ? { gr_no: doc, claim_qty: qty, reason: reason || 'แจ้งของขาด/เสียผ่านแชท' } : { po_no: doc, claim_qty: qty, reason: reason || 'แจ้งของขาด/เสียผ่านแชท' };
      const res = await claims.createGrClaim(dto, jwtUser);
      return `เปิดเคลมแล้ว ✅ ${res.claim_no} (${doc} × ${qty})\nทีมจัดซื้อจะติดตามกับผู้ขายที่หน้าเคลม (/claims)`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `เปิดเคลมไม่ได้ — ${String(msg).slice(0, 200)}`;
    }
  }

  // low — read-only list of items at/below their reorder point (on-hand vs items.min_stock), tenant-scoped.
  // A hint points at `reorder` to raise the top-up PR in one tap. Any pr_raise-capable linked user may look.
  async chatLowStock(u: any): Promise<string> {
    const procurement = this.ports.procurement();
    if (!procurement) return 'ระบบจัดซื้อยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const perms = await this.link.effectivePerms(u);
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    const { items: low, count } = await procurement.lowStock(jwtUser, { limit: 10 });
    if (!count) return 'สินค้าใกล้หมด: ไม่มี ✅ (ทุกอย่างสูงกว่าจุดสั่งซื้อ)';
    const lines = low.map((x: any) => `• ${x.item_id} — เหลือ ${x.on_hand}${x.uom ? ` ${x.uom}` : ''} (จุดสั่งซื้อ ${x.min_stock}) → แนะนำ ${x.suggested_qty}`);
    const more = count > low.length ? `\n…และอีก ${count - low.length} รายการ` : '';
    return `สินค้าใกล้หมด ${count} รายการ:\n${lines.join('\n')}${more}\nพิมพ์ reorder เพื่อเปิด PR เติมทั้งหมดในครั้งเดียว`;
  }

  // reorder — one-tap: raise a SINGLE PR covering every low-stock item at its suggested top-up qty.
  // Runs the ordinary createPr path (needs pr_raise), so numbering/status-log/workflow are unchanged.
  async chatReorder(u: any): Promise<string> {
    const procurement = this.ports.procurement();
    if (!procurement) return 'ระบบจัดซื้อยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const perms = await this.link.effectivePerms(u);
    if (!perms.includes('pr_raise') && !perms.includes('procurement') && !perms.includes('planner')) {
      return 'บัญชีของคุณไม่มีสิทธิ์เปิดคำขอซื้อ (ต้องมี pr_raise)';
    }
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const res = await procurement.reorderPr(jwtUser);
      const head = res.items.slice(0, 8).map((x: any) => `• ${x.item_id} × ${x.qty}`).join('\n');
      const more = res.items.length > 8 ? `\n…และอีก ${res.items.length - 8} รายการ` : '';
      return `เปิดคำขอซื้อเติมสต็อกแล้ว ✅ ${res.pr_no} (${res.lines} รายการ)\n${head}${more}\nสถานะ: ${res.status === 'Pending' ? 'รออนุมัติ' : res.status}`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `เปิด PR เติมสต็อกไม่ได้ — ${String(msg).slice(0, 200)}`;
    }
  }

  // D3 — `spend [YYYY-MM]` (`ยอดซื้อ`/`สรุปซื้อ`): purchase spend for a business month — total, top vendors,
  // most-bought items. Read-only; gated on a buyer/analytics permission (procurement/planner/exec/dashboard).
  async chatSpend(u: any, arg: string): Promise<string> {
    const procurement = this.ports.procurement();
    if (!procurement) return 'ระบบจัดซื้อยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const perms = await this.link.effectivePerms(u);
    if (!['procurement', 'planner', 'exec', 'dashboard'].some((p) => perms.includes(p))) {
      return 'บัญชีของคุณไม่มีสิทธิ์ดูยอดซื้อ (ต้องมี procurement / exec / dashboard)';
    }
    const period = /^\d{4}-\d{2}$/.test(arg) ? arg : undefined;
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const s = await procurement.purchaseSpend(jwtUser, { period });
      const money = (v: number) => v.toLocaleString('th-TH', { maximumFractionDigits: 2 });
      if (!s.po_count) return `💰 ยอดซื้อเดือน ${s.period}: ยังไม่มีใบสั่งซื้อ`;
      const vendors = s.by_vendor.slice(0, 5).map((v: any) => `• ${v.vendor} — ฿${money(v.total)} (${v.po_count} ใบ)`).join('\n');
      const items = s.top_items.slice(0, 5).map((i: any) => `• ${i.item_id} — ${money(i.qty)} หน่วย (฿${money(i.value)})`).join('\n');
      return `💰 ยอดซื้อเดือน ${s.period}: ฿${money(s.total)} · ${s.po_count} ใบสั่งซื้อ\nผู้ขายสูงสุด:\n${vendors}\nสินค้าซื้อมากสุด:\n${items}`;
    } catch (e: any) {
      return `ดูยอดซื้อไม่ได้ — ${String(e?.response?.messageTh ?? e?.message ?? 'ไม่ทราบสาเหตุ').slice(0, 200)}`;
    }
  }

  // find <keyword> — item-master search so people can discover real item ids before raising a PR.
  async chatFind(keyword: string): Promise<string> {
    const kw = keyword.trim().slice(0, 100);
    if (!kw) return 'ระบุคำค้น เช่น find กระดาษ';
    const rows = await this.db.select({ itemId: items.itemId, itemDescription: items.itemDescription, uom: items.uom })
      .from(items).where(or(ilike(items.itemId, `%${kw}%`), ilike(items.itemDescription, `%${kw}%`))).limit(5);
    if (!rows.length) return `ไม่พบสินค้าที่ตรงกับ "${kw}"`;
    return `ผลค้นหา "${kw}":\n` + rows.map((r: any) => `• ${r.itemId} — ${r.itemDescription ?? '-'}${r.uom ? ` (${r.uom})` : ''}`).join('\n') + '\nสร้างคำขอซื้อ: pr <รหัสสินค้า> <จำนวน>';
  }

  // cancel <PR no> — the requester withdraws their own still-Pending PR (service enforces own-doc + status).
  async chatCancel(u: any, docNo: string): Promise<string> {
    const prNo = docNo.toUpperCase();
    const procurement = this.ports.procurement();
    if (!procurement) return 'ระบบคำขอซื้อยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const perms = await this.link.effectivePerms(u);
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      await procurement.cancelPr(prNo, jwtUser);
      return `${prNo}: ยกเลิกแล้ว ✅`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `${prNo}: ยกเลิกไม่ได้ — ${String(msg).slice(0, 200)}`;
    }
  }

  // ── LC-2 (docs/30) — petty-cash self-service: `expense <fund> <amount> [purpose]` / `advance …` ──
  // RAISE-only, exactly like the web maker: creates a PEX- request (PendingApproval, NO GL) through the
  // same PettyCashService path; approval stays on /petty-cash (chat money-DECISIONS deferred per plan).
  // Permission mirrors the web endpoint (`creditors`/`exec`); the service's own guards (fund existence,
  // FUND_CLOSED, INSUFFICIENT_FLOAT) apply unchanged, and its LC-2 hooks notify the approvers.
  async chatPettyCash(u: any, kind: 'expense' | 'advance', fundCode: string, amountStr: string, purpose: string): Promise<string> {
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) return `จำนวนเงินไม่ถูกต้อง — รูปแบบ: ${kind} <รหัสกองทุน> <จำนวนเงิน> [เหตุผล]`;
    const perms = await this.link.effectivePerms(u);
    if (!perms.includes('creditors') && !perms.includes('exec')) return 'บัญชีของคุณไม่มีสิทธิ์เบิกเงินสดย่อย (ต้องมี creditors หรือ exec)';
    const pettyCash = this.ports.pettyCash();
    if (!pettyCash) return 'ระบบเงินสดย่อยยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const res = await pettyCash.createRequest({ fund_code: fundCode.toUpperCase(), kind, amount, purpose: purpose || undefined }, jwtUser);
      return `สร้างคำขอ${kind === 'advance' ? 'เงินยืม' : 'เบิกค่าใช้จ่าย'}แล้ว ✔ เลขที่ ${res.req_no} (${res.amount} บาท, รออนุมัติ) — จะแจ้งเตือนเมื่อมีการอนุมัติ`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `สร้างคำขอไม่สำเร็จ: ${String(msg).slice(0, 200)}`;
    }
  }

  // ── LC-3 (docs/30) — `leave <from YYYY-MM-DD> <days> [เหตุผล]` → ESS self-service leave request ──
  // Same path as the web (/ess): requires the `ess` permission and a linked employee record
  // (ESS_NO_EMPLOYEE binds unchanged); to_date is derived from <from>+<days>. The ESS hook notifies the
  // leave approvers; approval stays on /hcm.
  async chatLeave(u: any, fromDate: string, daysStr: string, reason: string): Promise<string> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return 'รูปแบบวันที่ไม่ถูกต้อง — leave <จากวันที่ YYYY-MM-DD> <จำนวนวัน> [เหตุผล]';
    const days = Number(daysStr);
    if (!Number.isFinite(days) || days <= 0 || days > 60) return 'จำนวนวันลาไม่ถูกต้อง (1–60) — leave <จากวันที่> <จำนวนวัน> [เหตุผล]';
    const perms = await this.link.effectivePerms(u);
    if (!perms.includes('ess')) return 'บัญชีของคุณไม่มีสิทธิ์ลางานผ่านระบบ (ess)';
    const ess = this.ports.ess();
    if (!ess) return 'ระบบลางานยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const to = new Date(`${fromDate}T00:00:00Z`);
    to.setUTCDate(to.getUTCDate() + Math.ceil(days) - 1);
    const toDate = to.toISOString().slice(0, 10);
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const res = await ess.requestLeave({ from_date: fromDate, to_date: toDate, days, reason: reason || undefined }, jwtUser);
      return `ส่งใบลาแล้ว ✔ #${res.id} — ${days} วัน (${fromDate} → ${toDate}) สถานะรออนุมัติ — จะแจ้งเตือนเมื่ออนุมัติ`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `ส่งใบลาไม่สำเร็จ: ${String(msg).slice(0, 200)}`;
    }
  }

  // ── LC-4 (docs/30) — `subscribe digest` / `unsubscribe digest`: opt in/out of the LINE morning
  // digest. Self-service, but permission-at-subscribe applies (the digest carries approval/PR/alert
  // counts → requires dashboard/fin_report/exec). The opt-in rides the tenant's single
  // `line_daily_digest` report subscription as a {line_user} recipient — the BI scheduler delivers it
  // daily; force-unlink (LC-3) silences it automatically because delivery resolves the link registry.
  async chatDigest(tenantId: number, u: any, on: boolean, kpiList = ''): Promise<string> {
    const perms = await this.link.effectivePerms(u);
    if (on && !perms.includes('dashboard') && !perms.includes('fin_report') && !perms.includes('exec')) {
      return 'บัญชีของคุณไม่มีสิทธิ์รับสรุปประจำวัน (ต้องมี dashboard / fin_report / exec)';
    }
    // LP-3: optional per-subscriber KPI selection — `subscribe digest sales_yesterday,cash_position`.
    // Keys are validated against the catalog AND the caller's current permissions (delivery re-filters
    // at send time anyway, but refusing an un-seeable key here beats a silently thinner digest later).
    let kpis: string[] | null = null;
    if (on && kpiList.trim()) {
      const wanted = kpiList.split(/[,\s]+/).map((k) => k.trim().toLowerCase()).filter(Boolean);
      const mine = allowedDigestKpis(perms);
      const bad = wanted.filter((k) => !DIGEST_KPIS[k]);
      if (bad.length) return `ไม่รู้จัก KPI: ${bad.join(', ')} — พิมพ์ "digest kpis" เพื่อดูรายการที่เลือกได้`;
      const denied = wanted.filter((k) => !mine.includes(k));
      if (denied.length) return `บัญชีของคุณไม่มีสิทธิ์เห็น: ${denied.join(', ')} — พิมพ์ "digest kpis" เพื่อดูรายการของคุณ`;
      kpis = wanted;
    }
    const [sub] = await this.db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.tenantId, tenantId), eq(reportSubscriptions.reportType, 'line_daily_digest'))).limit(1);
    const recipients: Array<{ line_user?: string; email?: string; kpis?: string[] }> = Array.isArray(sub?.recipients) ? [...(sub!.recipients as Array<{ line_user?: string; email?: string; kpis?: string[] }>)] : [];
    const idx = recipients.findIndex((r: any) => r?.line_user === u.username);
    if (on) {
      const entry: { line_user: string; kpis?: string[] } = { line_user: u.username, ...(kpis ? { kpis } : {}) };
      if (idx >= 0) recipients[idx] = entry; else recipients.push(entry);
      if (sub) await this.db.update(reportSubscriptions).set({ recipients, isActive: true }).where(eq(reportSubscriptions.id, sub.id));
      else await this.db.insert(reportSubscriptions).values({ tenantId, name: 'LINE Daily Digest', reportType: 'line_daily_digest', filters: {}, frequency: 'daily', recipients, isActive: true, nextRunAt: new Date(), createdBy: 'system:line-chat' });
      const picked = kpis ? ` (${kpis.map((k) => DIGEST_KPIS[k]!.th).join(' · ')})` : '';
      return `รับสรุปประจำวันทาง LINE แล้ว ✔${picked} (ส่งทุกเช้าตามรอบรายงาน) — พิมพ์ "unsubscribe digest" เพื่อยกเลิก`;
    }
    if (!sub || idx < 0) return 'คุณยังไม่ได้รับสรุปประจำวันอยู่แล้ว';
    await this.db.update(reportSubscriptions).set({ recipients: recipients.filter((r: any) => r?.line_user !== u.username) }).where(eq(reportSubscriptions.id, sub.id));
    return 'ยกเลิกการรับสรุปประจำวันแล้ว ✔';
  }

  // D1 — subscribe/unsubscribe the morning low-stock reorder alert (report type `low_stock_reorder_alert`).
  // Gated on pr_raise, since the whole point is to reorder; the scheduler delivers it (with a one-tap
  // [สั่งเติมทั้งหมด] button) once per day and only when something is actually low. Force-unlink silences it.
  async chatLowStockAlert(tenantId: number, u: any, on: boolean): Promise<string> {
    const perms = await this.link.effectivePerms(u);
    if (on && !perms.includes('pr_raise') && !perms.includes('procurement') && !perms.includes('planner')) {
      return 'บัญชีของคุณไม่มีสิทธิ์รับแจ้งเตือนสินค้าใกล้หมด (ต้องมี pr_raise)';
    }
    const [sub] = await this.db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.tenantId, tenantId), eq(reportSubscriptions.reportType, 'low_stock_reorder_alert'))).limit(1);
    const recipients: Array<{ line_user?: string; email?: string }> = Array.isArray(sub?.recipients) ? [...(sub!.recipients as Array<{ line_user?: string; email?: string }>)] : [];
    const idx = recipients.findIndex((r: any) => r?.line_user === u.username);
    if (on) {
      if (idx < 0) recipients.push({ line_user: u.username });
      if (sub) await this.db.update(reportSubscriptions).set({ recipients, isActive: true }).where(eq(reportSubscriptions.id, sub.id));
      else await this.db.insert(reportSubscriptions).values({ tenantId, name: 'LINE Low-stock Reorder Alert', reportType: 'low_stock_reorder_alert', filters: {}, frequency: 'daily', recipients, isActive: true, nextRunAt: new Date(), createdBy: 'system:line-chat' });
      return 'รับแจ้งเตือนสินค้าใกล้หมดทาง LINE แล้ว ✔ (ส่งทุกเช้าเมื่อมีของถึงจุดสั่งซื้อ พร้อมปุ่มสั่งเติม) — พิมพ์ "unsubscribe lowstock" เพื่อยกเลิก';
    }
    if (!sub || idx < 0) return 'คุณยังไม่ได้รับแจ้งเตือนสินค้าใกล้หมดอยู่แล้ว';
    await this.db.update(reportSubscriptions).set({ recipients: recipients.filter((r: any) => r?.line_user !== u.username) }).where(eq(reportSubscriptions.id, sub.id));
    return 'ยกเลิกการรับแจ้งเตือนสินค้าใกล้หมดแล้ว ✔';
  }

  // LP-3 — `digest kpis`: list the catalog keys THIS user's permissions may see (permission-aware menu).
  // Gated like `subscribe digest` — the baseline trio is permissionless, so the menu (not the KPI list)
  // carries the subscriber gate.
  async chatDigestKpis(u: any): Promise<string> {
    const perms = await this.link.effectivePerms(u);
    if (!perms.includes('dashboard') && !perms.includes('fin_report') && !perms.includes('exec')) {
      return 'บัญชีของคุณไม่มีสิทธิ์รับสรุปประจำวัน (ต้องมี dashboard / fin_report / exec)';
    }
    const mine = allowedDigestKpis(perms);
    const dflt = new Set(DEFAULT_DIGEST_KPIS);
    return 'KPI ที่เลือกได้สำหรับสรุปประจำวันของคุณ:\n'
      + mine.map((k) => `• ${k} — ${DIGEST_KPIS[k]!.th}${dflt.has(k) ? ' (ค่าเริ่มต้น)' : ''}`).join('\n')
      + '\nเลือกโดยพิมพ์: subscribe digest <kpi,kpi,…>';
  }

  // ── LC-5 (docs/30) — read-only NL analytics: `ask <คำถาม>` via the governed nl-analytics engine ──
  // Same permission gate as POST /api/nl/ask (exec/dashboard/masterdata) — chat is no data bypass. The
  // query engine is whitelist-only + RLS-scoped; NL never produces raw SQL.
  async chatAsk(u: any, question: string): Promise<string> {
    const perms = await this.link.effectivePerms(u);
    if (!perms.includes('exec') && !perms.includes('dashboard') && !perms.includes('masterdata')) {
      return 'บัญชีของคุณไม่มีสิทธิ์ถามข้อมูลวิเคราะห์ (ต้องมี dashboard / exec / masterdata)';
    }
    const nl = this.ports.nl();
    if (!nl) return 'ระบบวิเคราะห์ยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const res: any = await nl.ask(question, jwtUser);
      const rows: any[] = res?.result?.rows ?? [];
      if (!rows.length) return `ไม่มีข้อมูลสำหรับ "${question}" (มิติ: ${res?.resolved?.dimension ?? '-'})`;
      const top = rows.slice(0, 5).map((r: any) => `• ${r.dim}: ${Number(r.sales_total).toLocaleString('th-TH')} บาท (${r.orders} บิล)`).join('\n');
      return `ยอดขายตาม ${res.resolved?.dimension ?? '-'}:\n${top}\nดูเต็มที่หน้า /query`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `ถามไม่สำเร็จ: ${String(msg).slice(0, 200)}`;
    }
  }

  // stock <item id> — read-only on-hand lookup from inv_balances (tenant-scoped to the linked user's shop).
  async chatStock(u: any, itemId: string): Promise<string> {
    const conds: any[] = [ilike(invBalances.itemId, itemId)]; // ilike w/o wildcards = case-insensitive equality
    if (u.tenantId != null) conds.push(eq(invBalances.tenantId, Number(u.tenantId)));
    const rows = await this.db.select().from(invBalances).where(and(...conds)).limit(5);
    if (!rows.length) return `ไม่พบยอดคงเหลือของ ${itemId}`;
    const total = rows.reduce((a: number, r: any) => a + Number(r.onHandQty ?? 0), 0);
    const name = rows[0]?.itemDescription ? ` (${rows[0].itemDescription})` : '';
    return `สต็อก ${rows[0]!.itemId}${name}: รวม ${total}\n` + rows.map((r: any) => `• ${r.locationId}: ${Number(r.onHandQty ?? 0)}`).join('\n');
  }

  // `pr <item> <qty> [reason][, …]` → ProcurementService.createPr under the linked user's identity. The
  // pr_raise permission is enforced here (the chat has no JWT guard), and the PR routes into the same
  // approval workflow as a web-raised PR — the chat can RAISE, never approve.
  async chatCreatePr(u: any, text: string): Promise<string> {
    const body = text.replace(/^(?:pr|ขอซื้อ)\s*/i, '').trim();
    if (!body) return CHAT_USAGE;
    const items: { item_id: string; request_qty: number; reason?: string }[] = [];
    for (const raw of body.split(/[,;\n]+/)) {
      const line = raw.trim();
      if (!line) continue;
      // token split (linear) instead of a backtracking regex — the text is uncontrolled chat input
      const parts = line.split(/\s+/);
      // Quantity = the LAST pure-number token; everything before it is the item name (so multi-word,
      // un-coded names work — "Iberico ham 2"), everything after is an optional reason. Storefronts
      // order by product name, not a single-token code, so we don't assume the id is one word.
      let qi = -1;
      for (let i = parts.length - 1; i >= 1; i--) { if (/^\d+(?:\.\d+)?$/.test(parts[i]!)) { qi = i; break; } }
      const qty = qi >= 0 ? Number(parts[qi]!) : NaN;
      const name = qi >= 1 ? parts.slice(0, qi).join(' ').trim() : '';
      if (qi < 1 || !name || !Number.isFinite(qty) || qty <= 0) {
        return `อ่านรายการนี้ไม่ได้: "${line}" — พิมพ์ <ชื่อสินค้า> <จำนวน> เช่น  pr Iberico ham 2\n${CHAT_USAGE}`;
      }
      items.push({ item_id: name, request_qty: qty, reason: parts.slice(qi + 1).join(' ') || undefined });
    }
    if (!items.length) return CHAT_USAGE;

    const perms = await this.link.effectivePerms(u);
    if (!perms.includes('pr_raise')) return 'บัญชีของคุณไม่มีสิทธิ์สร้างคำขอซื้อ (pr_raise)';
    const procurement = this.ports.procurement();
    if (!procurement) return 'ระบบคำขอซื้อยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง';
    const jwtUser: JwtUser = { username: u.username, role: u.role, customerName: null, tenantId: u.tenantId != null ? Number(u.tenantId) : null, permissions: perms };
    try {
      const res = await procurement.createPr({ items }, jwtUser);
      return `สร้างคำขอซื้อแล้ว ✔ เลขที่ ${res.pr_no} (${res.lines} รายการ) — ส่งเข้าขั้นตอนอนุมัติของทีมจัดซื้อแล้ว พิมพ์ "status ${res.pr_no}" เพื่อเช็คสถานะ`;
    } catch (e: any) {
      const msg = e?.response?.messageTh ?? e?.response?.message ?? e?.message ?? 'ไม่ทราบสาเหตุ';
      return `สร้างคำขอซื้อไม่สำเร็จ: ${String(msg).slice(0, 200)}`;
    }
  }

  async prStatus(prNo: string): Promise<string> {
    const [pr] = await this.db.select().from(purchaseRequests).where(eq(purchaseRequests.prNo, prNo)).limit(1);
    if (!pr) return `ไม่พบคำขอซื้อ ${prNo}`;
    return `PR ${prNo}: ${STATUS_TH[String(pr.status)] ?? pr.status}${pr.approvedBy ? ` (โดย ${pr.approvedBy})` : ''}`;
  }
}
