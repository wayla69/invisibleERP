import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { payments, tipDistributions, tipDistributionLines } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { LedgerReadService } from '../ledger/ledger-read.service';
import { n, fx } from '../../database/queries';
import { round2, roundCurrency } from '../tax/money';
import type { JwtUser } from '../../common/decorators';

export interface DistributeTipsDto {
  from: string;             // YYYY-MM-DD inclusive
  to: string;               // YYYY-MM-DD inclusive
  method?: 'equal' | 'hours' | 'weight';
  amount?: number;          // defaults to the full available pool
  pay_account?: string;     // GL credited (cash paid out); default 1000
  staff: { staff: string; hours?: number; weight?: number }[];
}

// Tip pooling / distribution (TIP-01). Tips accumulate in 2300 Tips Payable on checkout; a distribution
// pays the pooled tips out to staff for a period — Dr 2300 / Cr 1000 — clearing the liability. A
// distribution can never exceed the available pool (collected − already distributed, hard-capped by the
// 2300 GL outstanding), so tips are never over-paid and 2300 reconciles to what's still owed to staff.
@Injectable()
export class TipService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly ledger: LedgerService,
    private readonly ledgerRead: LedgerReadService,
  ) {}

  // tips collected in a window (Σ payments.tip on captured/settled tenders) + already distributed.
  async pool(from: string, to: string, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId ?? null;
    const captured = sql`${payments.status}::text IN ('Captured','Settled','Refunded')`;
    const [coll] = await db.select({ v: sql<string>`coalesce(sum(${payments.tip}),0)` }).from(payments)
      .where(and(tenantId == null ? sql`true` : eq(payments.tenantId, tenantId), captured, gte(payments.createdAt, new Date(from + 'T00:00:00.000Z')), lte(payments.createdAt, new Date(to + 'T23:59:59.999Z'))));
    const [dist] = await db.select({ v: sql<string>`coalesce(sum(${tipDistributions.poolAmount}),0)` }).from(tipDistributions)
      .where(and(eq(tipDistributions.tenantId, tenantId as number), eq(tipDistributions.periodFrom, from), eq(tipDistributions.periodTo, to)));
    const glOutstanding = await this.outstanding2300(tenantId);
    const collected = roundCurrency(n(coll?.v), 'THB');
    const distributed = roundCurrency(n(dist?.v), 'THB');
    const available = Math.max(0, Math.min(round2(collected - distributed), glOutstanding));
    return { from, to, collected, distributed, available, gl_outstanding: glOutstanding };
  }

  async distribute(dto: DistributeTipsDto, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId ?? null;
    if (!dto.staff?.length) throw new BadRequestException({ code: 'NO_STAFF', message: 'At least one staff member is required', messageTh: 'ต้องระบุพนักงานอย่างน้อยหนึ่งคน' });
    const p = await this.pool(dto.from, dto.to, user);
    const amount = roundCurrency(dto.amount ?? p.available, 'THB');
    if (amount <= 0) throw new BadRequestException({ code: 'NO_POOL', message: 'No tips available to distribute for this period', messageTh: 'ไม่มียอดทิปสำหรับงวดนี้' });
    if (amount > p.available + 1e-6) {
      throw new BadRequestException({ code: 'TIP_OVER_DISTRIBUTE', message: `Cannot distribute ${amount} — only ${p.available} available (collected ${p.collected}, already distributed ${p.distributed}, GL 2300 outstanding ${p.gl_outstanding})`, messageTh: `จ่ายทิปเกินยอดที่มี (${p.available})` });
    }
    const method = dto.method ?? 'equal';
    // weight each staff member by method, then normalise to shares.
    const weights = dto.staff.map((s) => method === 'hours' ? Math.max(0, n(s.hours)) : method === 'weight' ? Math.max(0, n(s.weight)) : 1);
    const totalW = weights.reduce((a, b) => a + b, 0);
    if (totalW <= 0) throw new BadRequestException({ code: 'BAD_WEIGHTS', message: 'Total hours/weight must be positive', messageTh: 'ชั่วโมง/น้ำหนักรวมต้องมากกว่าศูนย์' });
    // allocate; the last line absorbs the satang rounding remainder so Σ lines = amount exactly.
    const lines = dto.staff.map((s, i) => ({ staff: s.staff, basis: weights[i]!, share: weights[i]! / totalW, amount: roundCurrency(amount * (weights[i]! / totalW), 'THB') }));
    const allocated = round2(lines.reduce((a, l) => a + l.amount, 0));
    if (allocated !== amount && lines.length) lines[lines.length - 1]!.amount = round2(lines[lines.length - 1]!.amount + (amount - allocated));

    const distNo = await this.docNo.nextDaily('TIP');
    // GL: Dr 2300 Tips Payable (clear the liability) / Cr pay account (cash paid out).
    const payAccount = dto.pay_account ?? '1000';
    let journalNo: string | null = null;
    if (!(await this.ledger.alreadyPosted('TIP', distNo, tenantId))) {
      const je: any = await this.ledger.postEntry({ source: 'TIP', sourceRef: distNo, tenantId, memo: `Tip distribution ${distNo} (${dto.from}..${dto.to})`, createdBy: user.username, lines: [{ account_code: '2300', debit: amount }, { account_code: payAccount, credit: amount }] });
      journalNo = je?.entry_no ?? null;
    }
    const [hdr] = await db.insert(tipDistributions).values({
      tenantId: tenantId as number, distNo, periodFrom: dto.from, periodTo: dto.to, method, poolAmount: fx(amount, 4), payAccount, journalNo, createdBy: user.username,
    }).returning({ id: tipDistributions.id });
    await db.insert(tipDistributionLines).values(lines.map((l) => ({ tenantId: tenantId as number, distId: Number(hdr!.id), staff: l.staff, basis: fx(l.basis, 4), share: fx(l.share, 6), amount: fx(l.amount, 4) })));
    return { dist_no: distNo, journal_no: journalNo, method, amount, pay_account: payAccount, lines: lines.map((l) => ({ staff: l.staff, amount: l.amount, share: round2(l.share * 100) })) };
  }

  async list(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(tipDistributions).where(eq(tipDistributions.tenantId, user.tenantId as number)).orderBy(sql`${tipDistributions.createdAt} desc`).limit(200);
    const out: any[] = [];
    for (const h of rows) {
      const ls = await db.select().from(tipDistributionLines).where(eq(tipDistributionLines.distId, Number(h.id)));
      out.push({ dist_no: h.distNo, period_from: h.periodFrom, period_to: h.periodTo, method: h.method, pool_amount: n(h.poolAmount), journal_no: h.journalNo, created_by: h.createdBy, created_at: h.createdAt, lines: ls.map((l: any) => ({ staff: l.staff, amount: n(l.amount), share: round2(n(l.share) * 100) })) });
    }
    const outstanding = await this.outstanding2300(user.tenantId ?? null);
    return { distributions: out, count: out.length, gl_outstanding: outstanding };
  }

  // 2300 Tips Payable outstanding = Σ credit − Σ debit over Posted entries (the tips still owed to staff).
  // Read via LedgerReadService (docs/46 Phase 3 boundary) — accountNet returns debit − credit, so negate.
  private async outstanding2300(tenantId: number | null): Promise<number> {
    return roundCurrency(-(await this.ledgerRead.accountNet(['2300'], { tenantId })), 'THB');
  }
}
