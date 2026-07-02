import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, like, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { giftCards, giftCardTxns } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { n, fx } from '../../database/queries';
import { roundCurrency } from '../tax/money';
import type { JwtUser } from '../../common/decorators';
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

  // Issue (sell) a card → Dr 1000 Cash / Cr 2200 Customer Deposits (NOT revenue). Idempotent per cardNo.
  async issue(dto: IssueGiftCardDto, user: JwtUser): Promise<{ card_no: string; balance: number; journal_no: string | null }> {
    const db = this.db;
    const face = roundCurrency(dto.amount, 'THB');
    if (face <= 0) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be positive', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    const cardNo = await this.docNo.nextDaily('GC');
    await db.insert(giftCards).values({ cardNo, tenantId: user.tenantId ?? null, initialAmount: fx(face, 2), balance: fx(face, 2), currency: 'THB', status: 'Active', note: dto.note ?? null, createdBy: user.username });
    let journalNo: string | null = null;
    if (!(await this.ledger.alreadyPosted('GCISSUE', cardNo))) {
      const je: any = await this.ledger.postEntry({ source: 'GCISSUE', sourceRef: cardNo, tenantId: user.tenantId ?? undefined, memo: `Gift card ${cardNo}`, createdBy: user.username, lines: [{ account_code: '1000', debit: face }, { account_code: '2200', credit: face }] });
      journalNo = je?.entry_no ?? null;
    }
    await db.insert(giftCardTxns).values({ txnNo: await this.docNo.nextDaily('GCT'), tenantId: user.tenantId ?? null, cardNo, type: 'Issue', amount: fx(face, 2), balanceAfter: fx(face, 2), refDoc: cardNo, journalNo, createdBy: user.username });
    return { card_no: cardNo, balance: face, journal_no: journalNo };
  }

  // Gift-card register (ops/finance): every card for the caller's tenant + the OUTSTANDING liability
  // (sum of Active balances = the unredeemed 2200 Customer-Deposits exposure). Tenant-scoped explicitly
  // (an HQ/Admin request bypasses RLS); typed builders / column refs only at user-input sites.
  async listCards(q: { status?: string; search?: string; limit?: number }, user: JwtUser) {
    const db = this.db;
    const conds: any[] = [];
    if (user.tenantId != null) conds.push(eq(giftCards.tenantId, user.tenantId));
    if (q.status) conds.push(eq(giftCards.status, q.status as any));
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
    const db = (tx ?? this.db) as any;
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
    const db = (tx ?? this.db) as any;
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
