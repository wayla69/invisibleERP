import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, and, ne, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { crmAccounts, crmContacts, crmDqScores, crmMergeLog } from '../../../database/schema';
import { normalizeName, nameSimilarity, normalizeKey } from '../../../common/text-similarity';
import { ymd } from '../../../database/queries';
import type { JwtUser } from '../../../common/decorators';

// CRM-17 CRM data-quality (control CRM-16, migration 0409). The customer master (crm_accounts) is scored on the
// COMPLETENESS + VALIDITY of its key fields so poor records surface for cleanup, likely DUPLICATES are found
// proactively (beyond the create-time exact-key check), and every merge is audited (crm_merge_log). Read-only
// over the CRM spine (+ the one idempotent DQ snapshot); the merge itself + its maker-checker stay in the
// accounts service (this service only reads the log it writes).
//
// Explainable weighted scoring (no trained model): each field earns its weight only when PRESENT and VALID; the
// weights sum to 100, so the score IS the earned total. Bands: good ≥ 80, fair ≥ 50, poor < 50.
type AcctRow = typeof crmAccounts.$inferSelect;
const GOOD_MIN = 80, FAIR_MIN = 50;
const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const digits = (s: string) => s.replace(/\D/g, '');
const nonEmpty = (s: unknown) => typeof s === 'string' && s.trim() !== '';

// field key → { weight, label, check(account, hasContact) → { ok, detail } }
const DQ_FIELDS: { key: string; weight: number; label: string; check: (a: AcctRow, hasContact: boolean) => { ok: boolean; detail: string } }[] = [
  { key: 'tax_id', weight: 20, label: 'Tax ID', check: (a) => !nonEmpty(a.taxId) ? { ok: false, detail: 'missing' } : (digits(a.taxId!).length === 13 ? { ok: true, detail: 'ok' } : { ok: false, detail: 'invalid (not 13 digits)' }) },
  { key: 'email', weight: 15, label: 'Email', check: (a) => !nonEmpty(a.email) ? { ok: false, detail: 'missing' } : (isEmail(a.email!.trim()) ? { ok: true, detail: 'ok' } : { ok: false, detail: 'invalid format' }) },
  { key: 'phone', weight: 15, label: 'Phone', check: (a) => !nonEmpty(a.phone) ? { ok: false, detail: 'missing' } : (digits(a.phone!).length >= 9 ? { ok: true, detail: 'ok' } : { ok: false, detail: 'too short' }) },
  { key: 'owner', weight: 15, label: 'Owner', check: (a) => a.ownerUserId != null ? { ok: true, detail: 'ok' } : { ok: false, detail: 'unassigned' } },
  { key: 'contact', weight: 15, label: 'Contact', check: (_a, hasContact) => hasContact ? { ok: true, detail: 'ok' } : { ok: false, detail: 'no active contact' } },
  { key: 'industry', weight: 10, label: 'Industry', check: (a) => nonEmpty(a.industry) ? { ok: true, detail: 'ok' } : { ok: false, detail: 'missing' } },
  { key: 'website', weight: 5, label: 'Website', check: (a) => nonEmpty(a.website) ? { ok: true, detail: 'ok' } : { ok: false, detail: 'missing' } },
  { key: 'size', weight: 5, label: 'Size', check: (a) => nonEmpty(a.size) ? { ok: true, detail: 'ok' } : { ok: false, detail: 'missing' } },
];

function computeDq(a: AcctRow, hasContact: boolean) {
  let score = 0;
  const breakdown = DQ_FIELDS.map((f) => {
    const r = f.check(a, hasContact);
    if (r.ok) score += f.weight;
    return { field: f.key, label: f.label, weight: f.weight, ok: r.ok, detail: r.detail };
  });
  const band = score >= GOOD_MIN ? 'good' : score >= FAIR_MIN ? 'fair' : 'poor';
  const missing = breakdown.filter((b) => !b.ok).map((b) => b.field);
  return { score, band, breakdown, missing };
}

@Injectable()
export class CrmDqService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private tenantCond<T>(col: any, user: JwtUser) {
    return user.tenantId != null ? eq(col, user.tenantId) : undefined;
  }

  private async liveAccounts(user: JwtUser): Promise<AcctRow[]> {
    return this.db.select().from(crmAccounts)
      .where(and(ne(crmAccounts.status, 'merged'), this.tenantCond(crmAccounts.tenantId, user)))
      .orderBy(desc(crmAccounts.id)).limit(1000);
  }

  // Set of account ids that have ≥1 active contact (the "has a contact of record" DQ signal).
  private async accountsWithContact(user: JwtUser): Promise<Set<number>> {
    const rows = await this.db.select({ accountId: crmContacts.accountId }).from(crmContacts)
      .where(and(eq(crmContacts.status, 'active'), this.tenantCond(crmContacts.tenantId, user)));
    return new Set(rows.filter((r) => r.accountId != null).map((r) => Number(r.accountId)));
  }

  private async accountByNo(accountNo: string, user: JwtUser) {
    const [a] = await this.db.select().from(crmAccounts)
      .where(and(eq(crmAccounts.accountNo, accountNo), this.tenantCond(crmAccounts.tenantId, user))).limit(1);
    if (!a) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: `Account ${accountNo} not found`, messageTh: 'ไม่พบบัญชีลูกค้า' });
    return a;
  }

  // GET /api/crm/dq — the data-quality worklist, worst-score-first, with band counts.
  async worklist(user: JwtUser, opts: { band?: string } = {}) {
    const [accounts, withContact] = [await this.liveAccounts(user), await this.accountsWithContact(user)];
    const scored = accounts.map((a) => {
      const d = computeDq(a, withContact.has(Number(a.id)));
      return { account_no: a.accountNo, name: a.name, score: d.score, band: d.band, missing_count: d.missing.length, missing: d.missing };
    }).sort((x, y) => x.score - y.score);
    const band_counts = { good: 0, fair: 0, poor: 0 } as Record<string, number>;
    for (const s of scored) band_counts[s.band] = (band_counts[s.band] ?? 0) + 1;
    const rows = opts.band ? scored.filter((s) => s.band === opts.band) : scored;
    return { accounts: rows, count: rows.length, band_counts };
  }

  // GET /api/crm/dq/account/:accountNo — one account's score + full field breakdown.
  async accountDq(accountNo: string, user: JwtUser) {
    const a = await this.accountByNo(accountNo, user);
    const withContact = await this.accountsWithContact(user);
    const d = computeDq(a, withContact.has(Number(a.id)));
    return { account_no: a.accountNo, name: a.name, score: d.score, band: d.band, breakdown: d.breakdown, missing: d.missing };
  }

  // POST /api/crm/dq/snapshot — idempotent daily DQ snapshot per account (schedulable BI crm_dq_scan).
  async captureAllDq(user: JwtUser) {
    const db = this.db;
    const date = ymd();
    const [accounts, withContact] = [await this.liveAccounts(user), await this.accountsWithContact(user)];
    let captured = 0;
    for (const a of accounts) {
      const d = computeDq(a, withContact.has(Number(a.id)));
      await db.insert(crmDqScores).values({
        tenantId: user.tenantId ?? null, accountId: Number(a.id), snapshotDate: date, score: d.score, band: d.band,
        signals: { breakdown: d.breakdown, missing: d.missing } as unknown as Record<string, unknown>, createdBy: user.username,
      }).onConflictDoUpdate({
        target: [crmDqScores.tenantId, crmDqScores.accountId, crmDqScores.snapshotDate],
        set: { score: d.score, band: d.band, signals: { breakdown: d.breakdown, missing: d.missing } as unknown as Record<string, unknown>, createdAt: new Date() },
      });
      captured++;
    }
    return { as_of: date, scanned: accounts.length, captured };
  }

  // GET /api/crm/dq/history/:accountNo — the DQ score trend from the snapshots.
  async dqHistory(accountNo: string, user: JwtUser) {
    const a = await this.accountByNo(accountNo, user);
    const rows = await this.db.select().from(crmDqScores)
      .where(and(eq(crmDqScores.accountId, Number(a.id)), this.tenantCond(crmDqScores.tenantId, user)))
      .orderBy(desc(crmDqScores.snapshotDate)).limit(180);
    return { account_no: accountNo, history: rows.map((r) => ({ snapshot_date: r.snapshotDate, score: r.score, band: r.band })), count: rows.length };
  }

  // GET /api/crm/dq/duplicates — proactive near-duplicate surveillance (fuzzy name + exact tax_id/email/phone),
  // beyond the create-time exact-key check. O(n²) app-side pass (pg_trgm not enabled), capped output.
  async duplicateCandidates(user: JwtUser, opts: { threshold?: number } = {}) {
    const threshold = Math.min(Math.max(opts.threshold ?? 0.85, 0.5), 1);
    const accounts = await this.liveAccounts(user);
    const norm = accounts.map((a) => ({ a, name: normalizeName(a.name), tax: a.taxId ? normalizeKey(a.taxId) : '', email: a.email ? normalizeKey(a.email) : '', phone: a.phone ? normalizeKey(a.phone) : '' }));
    const pairs: { a: string; b: string; a_name: string; b_name: string; reasons: string[]; similarity: number }[] = [];
    for (let i = 0; i < norm.length; i++) {
      for (let j = i + 1; j < norm.length; j++) {
        const x = norm[i]!, y = norm[j]!;
        const reasons: string[] = [];
        if (x.tax && x.tax === y.tax) reasons.push('tax_id');
        if (x.email && x.email === y.email) reasons.push('email');
        if (x.phone && x.phone === y.phone) reasons.push('phone');
        const sim = nameSimilarity(x.a.name, y.a.name);
        if (sim >= threshold) reasons.push('name');
        if (reasons.length) pairs.push({ a: x.a.accountNo, b: y.a.accountNo, a_name: x.a.name, b_name: y.a.name, reasons, similarity: Math.round(sim * 100) / 100 });
      }
    }
    // strongest first: an exact-key match outranks a name-only fuzzy match, then by name similarity
    pairs.sort((p, q) => (q.reasons.length - p.reasons.length) || (q.similarity - p.similarity));
    return { candidates: pairs.slice(0, 100), count: Math.min(pairs.length, 100), threshold };
  }

  // GET /api/crm/dq/merge-log — the audit trail of account merges (written by the accounts merge transaction).
  async mergeLog(user: JwtUser) {
    const rows = await this.db.select().from(crmMergeLog)
      .where(this.tenantCond(crmMergeLog.tenantId, user)).orderBy(desc(crmMergeLog.id)).limit(200);
    return { merges: rows.map((r) => ({ id: Number(r.id), survivor_no: r.survivorNo, duplicate_no: r.duplicateNo, reassigned_children: r.reassignedChildren, filled_fields: Array.isArray(r.filledFields) ? r.filledFields : [], merged_by: r.mergedBy, created_at: r.createdAt })), count: rows.length };
  }
}
