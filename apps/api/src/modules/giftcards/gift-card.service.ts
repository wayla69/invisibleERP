import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, like, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { giftCards, giftCardTxns } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { n, fx } from '../../database/queries';
import { roundCurrency } from '../tax/money';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import type { IssueGiftCardDto } from './dto';

// Gift cards / store credit. A card is a 2200 Customer-Deposits liability. Issue posts GL (Dr 1000 /
// Cr 2200); redeem-as-tender and store-credit-credit do NOT post GL here — the sale/return that calls
// them posts the matching 2200 leg, so the card movement and the GL stay in one balanced entry.
@Injectable()
export class GiftCardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly ledger: LedgerService,
  ) {}

  // Face value (THB) at/below which a card auto-issues at the till; ABOVE it, issuance is maker-checker
  // (audit G1) — a gift card is a cash-equivalent 2200 liability, so a large issue needs an independent
  // approval before it posts GL / becomes usable. Small values keep the till fast (mirrors the audit note).
  static readonly ISSUE_APPROVAL_THRESHOLD = 5000;

  // Post the issuance GL (Dr 1000 Cash / Cr 2200 Customer Deposits — NOT revenue) + the Issue txn. Idempotent.
  private async postIssuance(cardNo: string, face: number, tenantId: number | null, by: string): Promise<string | null> {
    let journalNo: string | null = null;
    if (!(await this.ledger.alreadyPosted('GCISSUE', cardNo))) {
      const je: any = await this.ledger.postEntry({ source: 'GCISSUE', sourceRef: cardNo, tenantId: tenantId ?? undefined, memo: `Gift card ${cardNo}`, createdBy: by, lines: [{ account_code: '1000', debit: face }, { account_code: '2200', credit: face }] });
      journalNo = je?.entry_no ?? null;
    }
    await this.db.insert(giftCardTxns).values({ txnNo: await this.docNo.nextDaily('GCT'), tenantId: tenantId ?? null, cardNo, type: 'Issue', amount: fx(face, 2), balanceAfter: fx(face, 2), refDoc: cardNo, journalNo, createdBy: by });
    return journalNo;
  }

  // Issue (sell) a card. Face ≤ threshold → Active immediately (posts GL). Face > threshold → created
  // PendingApproval with NO GL and NOT redeemable until a DIFFERENT user approves it (audit G1). Idempotent per cardNo.
  async issue(dto: IssueGiftCardDto, user: JwtUser): Promise<{ card_no: string; balance: number; status: string; pending?: boolean; journal_no: string | null }> {
    const db = this.db;
    const face = roundCurrency(dto.amount, 'THB');
    if (face <= 0) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be positive', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    const cardNo = await this.docNo.nextDaily('GC');
    const pending = face > GiftCardService.ISSUE_APPROVAL_THRESHOLD;
    await db.insert(giftCards).values({ cardNo, tenantId: user.tenantId ?? null, initialAmount: fx(face, 2), balance: fx(face, 2), currency: 'THB', status: pending ? 'PendingApproval' : 'Active', note: dto.note ?? null, createdBy: user.username });
    if (pending) {
      // Maker-checker: no GL and no Issue txn until an independent approver activates the card.
      return { card_no: cardNo, balance: face, status: 'PendingApproval', pending: true, journal_no: null };
    }
    const journalNo = await this.postIssuance(cardNo, face, user.tenantId ?? null, user.username);
    return { card_no: cardNo, balance: face, status: 'Active', journal_no: journalNo };
  }

  // Approve a PendingApproval issuance (audit G1) — a DIFFERENT user than the issuer activates the card and
  // posts the Dr 1000 / Cr 2200 GL. Self-approval (issuer === approver) → 403 SOD_VIOLATION, except a
  // control_profile='sme' tenant with a logged justification (docs/49; evidence → self_approvals, SME-01).
  async approveIssue(cardNo: string, user: JwtUser, selfApprovalReason?: string | null): Promise<{ card_no: string; status: string; balance: number; journal_no: string | null; approved_by: string; issued_by: string | null }> {
    const db = this.db;
    const [c] = await db.select().from(giftCards).where(eq(giftCards.cardNo, cardNo)).limit(1);
    if (!c) throw new NotFoundException({ code: 'GIFT_CARD_NOT_FOUND', message: 'Gift card not found', messageTh: 'ไม่พบบัตรของขวัญ' });
    if (String(c.status) !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Gift card ${cardNo} is ${c.status}, not pending approval`, messageTh: 'บัตรนี้ไม่ได้รออนุมัติ' });
    await assertMakerChecker(db, { user, maker: c.createdBy, event: 'giftcard.issue.approve', ref: cardNo, amount: n(c.initialAmount), reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a gift card you issued', messageTh: 'ผู้ออกบัตรอนุมัติบัตรของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    const face = n(c.initialAmount);
    const journalNo = await this.postIssuance(cardNo, face, c.tenantId ?? user.tenantId ?? null, user.username);
    await db.update(giftCards).set({ status: 'Active', updatedAt: new Date() }).where(eq(giftCards.id, c.id));
    return { card_no: cardNo, status: 'Active', balance: face, journal_no: journalNo, approved_by: user.username, issued_by: c.createdBy ?? null };
  }

  // Gift-card register (ops/finance): every card for the caller's tenant + the OUTSTANDING liability
  // (sum of Active balances = the unredeemed 2200 Customer-Deposits exposure). Tenant-scoped explicitly
  // (an HQ/Admin request bypasses RLS); typed builders / column refs only at user-input sites.
  async listCards(q: { status?: string; search?: string; limit?: number }, user: JwtUser) {
    const db = this.db;
    const conds: any[] = [];
    if (user.tenantId != null) conds.push(eq(giftCards.tenantId, user.tenantId));
    if (q.status) conds.push(eq(giftCards.status, q.status as NonNullable<typeof giftCards.$inferSelect.status>));
    if (q.search) conds.push(like(giftCards.cardNo, `%${q.search}%`));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(giftCards).where(where).orderBy(desc(giftCards.id)).limit(q.limit ?? 200);
    const [agg] = await db.select({
      total: sql<string>`count(*)`,
      active: sql<string>`coalesce(sum(case when ${giftCards.status}='Active' then 1 else 0 end),0)`,
      liability: sql<string>`coalesce(sum(case when ${giftCards.status}='Active' then ${giftCards.balance} else 0 end),0)`,
    }).from(giftCards).where(user.tenantId != null ? eq(giftCards.tenantId, user.tenantId) : undefined);
    return {
      cards: rows.map((c: any) => ({ card_no: c.cardNo, initial_amount: n(c.initialAmount), balance: n(c.balance), status: String(c.status), currency: c.currency ?? 'THB', note: c.note ?? null, issued_by: c.createdBy ?? null, created_at: c.createdAt ?? null })),
      count: rows.length, total: n(agg?.total), active: n(agg?.active), outstanding: roundCurrency(n(agg?.liability), 'THB'),
    };
  }

  // Per-card transaction ledger (issue / redeem / refund) for the register drill-down.
  async cardTxns(cardNo: string) {
    const db = this.db;
    const [c] = await db.select().from(giftCards).where(eq(giftCards.cardNo, cardNo)).limit(1);
    if (!c) throw new NotFoundException({ code: 'GIFT_CARD_NOT_FOUND', message: 'Gift card not found', messageTh: 'ไม่พบบัตรของขวัญ' });
    const txns = await db.select().from(giftCardTxns).where(eq(giftCardTxns.cardNo, cardNo)).orderBy(desc(giftCardTxns.id));
    return { card_no: c.cardNo, initial_amount: n(c.initialAmount), balance: n(c.balance), status: String(c.status), txns: txns.map((t: any) => ({ txn_no: t.txnNo, type: String(t.type), amount: n(t.amount), balance_after: n(t.balanceAfter), ref_doc: t.refDoc, created_at: t.createdAt ?? null })) };
  }

  // Live balance + status (RLS-scoped → cross-tenant lookup 404s).
  async balance(cardNo: string): Promise<{ card_no: string; balance: number; status: string; currency: string }> {
    const db = this.db;
    const [c] = await db.select().from(giftCards).where(eq(giftCards.cardNo, cardNo)).limit(1);
    if (!c) throw new NotFoundException({ code: 'GIFT_CARD_NOT_FOUND', message: 'Gift card not found', messageTh: 'ไม่พบบัตรของขวัญ' });
    return { card_no: c.cardNo, balance: n(c.balance), status: String(c.status), currency: c.currency ?? 'THB' };
  }

  // Draw `amount` off a card as a tender against a sale. Locks the row, validates Active + sufficient
  // balance, decrements, writes a Redeem GCT. NO GL here — the sale's buildSale posts the Dr 2200 leg.
  async redeemForSale(cardNo: string, amount: number, saleNo: string, tenantId: number | null, user: JwtUser, tx?: any): Promise<{ applied: number; balance_after: number }> {
    const db = tx ?? this.db;
    const want = roundCurrency(amount, 'THB');
    if (want <= 0) return { applied: 0, balance_after: 0 };
    const [c] = await db.select().from(giftCards).where(eq(giftCards.cardNo, cardNo)).for('update').limit(1);
    if (!c) throw new NotFoundException({ code: 'GIFT_CARD_NOT_FOUND', message: 'Gift card not found', messageTh: 'ไม่พบบัตรของขวัญ' });
    if (String(c.status) !== 'Active') throw new BadRequestException({ code: 'GIFT_CARD_INACTIVE', message: `Gift card is ${c.status}`, messageTh: 'บัตรของขวัญใช้ไม่ได้' });
    if (want > n(c.balance) + 1e-9) throw new BadRequestException({ code: 'GIFT_CARD_INSUFFICIENT', message: `Card balance ${n(c.balance)} < ${want}`, messageTh: `ยอดในบัตรไม่พอ (มี ${n(c.balance)})` });
    const after = roundCurrency(n(c.balance) - want, 'THB');
    await db.update(giftCards).set({ balance: fx(after, 2), status: after <= 0 ? 'Redeemed' : 'Active', updatedAt: new Date() }).where(eq(giftCards.id, c.id));
    await db.insert(giftCardTxns).values({ txnNo: await this.docNo.nextDaily('GCT'), tenantId: tenantId ?? c.tenantId ?? null, cardNo, type: 'Redeem', amount: fx(-want, 2), balanceAfter: fx(after, 2), refDoc: saleNo, createdBy: user.username });
    return { applied: want, balance_after: after };
  }

  // Add store credit onto a card (used by returns store-credit refund). If cardNo omitted, mint a NEW
  // card. Writes a Refund GCT. NO GL here — the return posts the Cr 2200 leg.
  async creditFromReturn(amount: number, tenantId: number | null, refDoc: string, user: JwtUser, cardNo?: string, tx?: any): Promise<{ card_no: string; balance_after: number }> {
    const db = tx ?? this.db;
    const credit = roundCurrency(amount, 'THB');
    if (credit <= 0) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be positive', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    if (cardNo) {
      const [c] = await db.select().from(giftCards).where(eq(giftCards.cardNo, cardNo)).for('update').limit(1);
      if (!c) throw new NotFoundException({ code: 'GIFT_CARD_NOT_FOUND', message: 'Gift card not found', messageTh: 'ไม่พบบัตรของขวัญ' });
      const after = roundCurrency(n(c.balance) + credit, 'THB');
      await db.update(giftCards).set({ balance: fx(after, 2), status: 'Active', updatedAt: new Date() }).where(eq(giftCards.id, c.id));
      await db.insert(giftCardTxns).values({ txnNo: await this.docNo.nextDaily('GCT'), tenantId: tenantId ?? c.tenantId ?? null, cardNo, type: 'Refund', amount: fx(credit, 2), balanceAfter: fx(after, 2), refDoc, createdBy: user.username });
      return { card_no: cardNo, balance_after: after };
    }
    const newNo = await this.docNo.nextDaily('GC');
    await db.insert(giftCards).values({ cardNo: newNo, tenantId: tenantId ?? null, initialAmount: fx(credit, 2), balance: fx(credit, 2), currency: 'THB', status: 'Active', note: `Store credit ${refDoc}`, createdBy: user.username });
    await db.insert(giftCardTxns).values({ txnNo: await this.docNo.nextDaily('GCT'), tenantId: tenantId ?? null, cardNo: newNo, type: 'Refund', amount: fx(credit, 2), balanceAfter: fx(credit, 2), refDoc, createdBy: user.username });
    return { card_no: newNo, balance_after: credit };
  }
}
