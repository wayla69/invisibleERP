import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { journalEntries, journalLines, glAuditLog, jeExceptions } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

const n = (x: unknown) => Number(x ?? 0);
const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;

// Rule thresholds — deliberately plain constants (a SOX detective control wants a stable, explainable
// rule set, not tunable knobs that quietly change what "an exception" means between runs).
const SCAN_DAYS_DEFAULT = 90;          // entry_date window
const ROUND_MIN = 10_000;              // a Manual JE ≥ this AND a whole multiple of ROUND_STEP is "round"
const ROUND_STEP = 1_000;
const BACKDATE_DAYS = 7;               // entry_date more than this many days before created_at
const BKK_OPEN_HOUR = 6;               // business hours 06:00–22:00 Asia/Bangkok
const BKK_CLOSE_HOUR = 22;
const CASH_PREFIX = '10';              // 1000-1099 cash/bank
const REVENUE_PREFIX = '4';

export interface JeExceptionListDto { status?: string; rule?: string }

// B5 (docs/50 Wave 5, control GL-28) — rule-based JE anomaly & control-exception analytics: the DETECTIVE
// layer over the preventive GL gates (GL-05 maker-checker, GL-17 immutability). Five rules over
// journal_entries/journal_lines/gl_audit_log:
//   duplicate_je  — same entry_date + same total debit + same account set posted more than once (high)
//   round_amount  — a Manual JE of a suspiciously round total (≥ ฿10,000, whole ฿1,000) (medium)
//   backdated     — a Manual JE whose accounting date is > 7 days before its real capture time (medium)
//   after_hours   — a POST/APPROVE audit event outside 06:00–22:00 Asia/Bangkok (medium)
//   unusual_pair  — a Manual JE that pairs cash (10xx) with revenue (4xxx) directly, bypassing AR (high)
// "Near-threshold approvals" from the plan is consciously N/A here: GL-05 maker-checker applies to EVERY
// manual JE with no amount threshold, so there is no threshold to skirt.
// The scan is IDEMPOTENT: one register row per tenant × rule × entry (0424 coalesce unique index), so a
// re-run finds the same anomalies and inserts nothing new. Dismissal requires a reason and writes a
// gl_audit_log EXCEPTION_DISMISSED row — the periodic-review evidence GL-28 points at.
// Lives INSIDE modules/ledger so the journal-table reads stay within the import-boundary ratchet.
@Injectable()
export class LedgerJeAnomalyService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private tenantConds(tenantId: number | null) {
    return tenantId != null ? [eq(journalEntries.tenantId, tenantId)] : [];
  }

  async scan(user: JwtUser, opts?: { days?: number }) {
    const db = this.db;
    const tenantId = user.tenantId ?? null;
    const days = Math.min(366, Math.max(1, n(opts?.days) || SCAN_DAYS_DEFAULT));
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const entries = await db.select().from(journalEntries)
      .where(and(eq(journalEntries.status, 'Posted'), gte(journalEntries.entryDate, since), ...this.tenantConds(tenantId)))
      .orderBy(desc(journalEntries.id)).limit(5000);
    const ids = entries.map((e: any) => Number(e.id));
    const lines = ids.length ? await db.select().from(journalLines).where(inArray(journalLines.entryId, ids)) : [];
    const linesByEntry = new Map<number, any[]>();
    for (const l of lines) {
      const k = Number(l.entryId);
      (linesByEntry.get(k) ?? linesByEntry.set(k, []).get(k)!).push(l);
    }
    const byId = new Map<number, any>(entries.map((e: any) => [Number(e.id), e]));
    const findings: { ruleKey: string; entryId: number; severity: string; detail: Record<string, unknown> }[] = [];

    // ── duplicate_je: same entry_date + total debit + sorted account set, > 1 Posted entry ──
    const groups = new Map<string, number[]>();
    for (const e of entries) {
      const ls = linesByEntry.get(Number(e.id)) ?? [];
      const total = r2(ls.reduce((s, l) => s + n(l.debit), 0));
      if (!(total > 0)) continue;
      const accounts = [...new Set(ls.map((l) => String(l.accountCode)))].sort().join(',');
      const key = `${e.entryDate}|${total}|${accounts}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(Number(e.id));
    }
    for (const [key, members] of groups) {
      if (members.length < 2) continue;
      for (const id of members) {
        findings.push({ ruleKey: 'duplicate_je', entryId: id, severity: 'high', detail: { group: key, peer_entry_nos: members.filter((m) => m !== id).map((m) => byId.get(m)?.entryNo) } });
      }
    }

    // ── round_amount + backdated + unusual_pair (Manual entries only) ──
    for (const e of entries) {
      if (e.source !== 'Manual') continue;
      const ls = linesByEntry.get(Number(e.id)) ?? [];
      const total = r2(ls.reduce((s, l) => s + n(l.debit), 0));
      if (total >= ROUND_MIN && Math.abs(total % ROUND_STEP) < 0.005) {
        findings.push({ ruleKey: 'round_amount', entryId: Number(e.id), severity: 'medium', detail: { total } });
      }
      if (e.createdAt && e.entryDate) {
        const lagDays = (new Date(e.createdAt).getTime() - Date.parse(`${e.entryDate}T00:00:00+07:00`)) / 86_400_000;
        if (lagDays > BACKDATE_DAYS) {
          findings.push({ ruleKey: 'backdated', entryId: Number(e.id), severity: 'medium', detail: { entry_date: e.entryDate, created_at: e.createdAt, lag_days: Math.floor(lagDays) } });
        }
      }
      const hasCash = ls.some((l) => String(l.accountCode).startsWith(CASH_PREFIX));
      const hasRevenue = ls.some((l) => String(l.accountCode).startsWith(REVENUE_PREFIX));
      if (hasCash && hasRevenue) {
        findings.push({ ruleKey: 'unusual_pair', entryId: Number(e.id), severity: 'high', detail: { accounts: [...new Set(ls.map((l) => String(l.accountCode)))].sort() } });
      }
    }

    // ── after_hours: POST/APPROVE audit events outside 06:00–22:00 Asia/Bangkok ──
    const audits = ids.length
      ? await this.db.select().from(glAuditLog).where(and(inArray(glAuditLog.entryId, ids), inArray(glAuditLog.action, ['POST', 'APPROVE'])))
      : [];
    const flaggedAfterHours = new Set<number>();
    for (const a of audits) {
      if (!a.at || a.entryId == null || flaggedAfterHours.has(Number(a.entryId))) continue;
      const bkkHour = (new Date(a.at).getUTCHours() + 7) % 24;
      if (bkkHour < BKK_OPEN_HOUR || bkkHour >= BKK_CLOSE_HOUR) {
        flaggedAfterHours.add(Number(a.entryId));
        findings.push({ ruleKey: 'after_hours', entryId: Number(a.entryId), severity: 'medium', detail: { action: a.action, actor: a.actor, at: a.at, bkk_hour: bkkHour } });
      }
    }

    // Idempotent register write: the 0424 coalesce unique index dedupes per tenant × rule × entry.
    let inserted = 0;
    for (const f of findings) {
      const e = byId.get(f.entryId);
      const rows = await db.insert(jeExceptions).values({
        tenantId, ruleKey: f.ruleKey, entryId: f.entryId, entryNo: e?.entryNo ?? null,
        severity: f.severity, detail: f.detail, status: 'open',
      }).onConflictDoNothing().returning({ id: jeExceptions.id });
      inserted += rows.length;
    }
    const byRule: Record<string, number> = {};
    for (const f of findings) byRule[f.ruleKey] = (byRule[f.ruleKey] ?? 0) + 1;
    const open = await this.openCount(tenantId);
    return { since, days, scanned: entries.length, findings: findings.length, new: inserted, by_rule: byRule, open };
  }

  private async openCount(tenantId: number | null): Promise<number> {
    const conds = [eq(jeExceptions.status, 'open')];
    if (tenantId != null) conds.push(eq(jeExceptions.tenantId, tenantId));
    const [row] = await this.db.select({ c: sql<string>`count(*)` }).from(jeExceptions).where(and(...conds));
    return n(row?.c);
  }

  async list(dto: JeExceptionListDto, user: JwtUser) {
    const conds: any[] = [];
    if (user.tenantId != null) conds.push(eq(jeExceptions.tenantId, user.tenantId));
    if (dto.status) conds.push(eq(jeExceptions.status, dto.status));
    if (dto.rule) conds.push(eq(jeExceptions.ruleKey, dto.rule));
    const rows = await this.db.select().from(jeExceptions).where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(jeExceptions.id)).limit(200);
    const byRule: Record<string, { open: number; dismissed: number }> = {};
    for (const r of rows) {
      const b = byRule[r.ruleKey] ?? (byRule[r.ruleKey] = { open: 0, dismissed: 0 });
      b[r.status === 'open' ? 'open' : 'dismissed']++;
    }
    return {
      exceptions: rows.map((r: any) => ({
        id: Number(r.id), rule: r.ruleKey, entry_id: Number(r.entryId), entry_no: r.entryNo, severity: r.severity,
        detail: r.detail, status: r.status, dismissed_by: r.dismissedBy, dismissed_at: r.dismissedAt,
        dismiss_reason: r.dismissReason, detected_at: r.detectedAt,
      })),
      count: rows.length,
      open: rows.filter((r: any) => r.status === 'open').length,
      high_open: rows.filter((r: any) => r.status === 'open' && r.severity === 'high').length,
      by_rule: byRule,
    };
  }

  // Dismiss = the GL-28 review disposition: a mandatory reason, who/when stamped on the row, and an
  // append-only gl_audit_log EXCEPTION_DISMISSED record (mirrors the POST/APPROVE audit-trail pattern).
  async dismiss(id: number, dto: { reason?: string }, user: JwtUser) {
    const reason = (dto.reason ?? '').trim();
    if (!reason) throw new BadRequestException({ code: 'DISMISS_REASON_REQUIRED', message: 'A dismissal reason is required', messageTh: 'ต้องระบุเหตุผลในการยกเลิกข้อยกเว้น' });
    const conds = [eq(jeExceptions.id, Number(id))];
    if (user.tenantId != null) conds.push(eq(jeExceptions.tenantId, user.tenantId));
    const [row] = await this.db.select().from(jeExceptions).where(and(...conds)).limit(1);
    if (!row) throw new NotFoundException({ code: 'EXCEPTION_NOT_FOUND', message: `Exception ${id} not found`, messageTh: 'ไม่พบข้อยกเว้น' });
    if (row.status !== 'open') throw new BadRequestException({ code: 'ALREADY_DISMISSED', message: 'Exception is already dismissed', messageTh: 'ข้อยกเว้นถูกยกเลิกไปแล้ว' });
    await this.db.transaction(async (tx: any) => {
      await tx.update(jeExceptions)
        .set({ status: 'dismissed', dismissedBy: user.username, dismissedAt: new Date(), dismissReason: reason })
        .where(eq(jeExceptions.id, Number(row.id)));
      await tx.insert(glAuditLog).values({
        tenantId: row.tenantId, entryId: row.entryId, action: 'EXCEPTION_DISMISSED', actor: user.username,
        detail: { exception_id: Number(row.id), rule: row.ruleKey, entry_no: row.entryNo, reason },
      });
    });
    return { id: Number(row.id), status: 'dismissed', dismissed_by: user.username, reason };
  }

  // The Close-Cockpit pillar feed: open counts by severity → RAG (red = any HIGH open, amber = any open).
  async cockpitSummary(tenantId: number | null) {
    const conds = [eq(jeExceptions.status, 'open')];
    if (tenantId != null) conds.push(eq(jeExceptions.tenantId, tenantId));
    const rows = await this.db.select({ severity: jeExceptions.severity, c: sql<string>`count(*)` })
      .from(jeExceptions).where(and(...conds)).groupBy(jeExceptions.severity);
    const open = rows.reduce((s, r) => s + n(r.c), 0);
    const high = n(rows.find((r) => r.severity === 'high')?.c);
    return { open, high_open: high, rag: high > 0 ? 'red' : open > 0 ? 'amber' : 'green' };
  }
}
