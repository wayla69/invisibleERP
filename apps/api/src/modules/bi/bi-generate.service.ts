import { Inject, Injectable, Optional, BadRequestException } from '@nestjs/common';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { workflowInstances, purchaseRequests, alertEvents, audienceExports, ropaActivities } from '../../database/schema';
import { arInvoices } from '../../database/schema/finance';
import { branchStock } from '../../database/schema/portal';
import { n, ymd } from '../../database/queries';
import { audienceExportConfigured, pushHashedAudience } from '../../common/cdp-sync';
import { resolveAudienceProviders } from '../../common/audience-providers';
import { activeKeyId, needsRotation, encrypt, decrypt } from '../../common/crypto';
import { CollectionsService } from '../finance/collections.service';
import { FinanceMetricsService } from '../finance/finance-metrics.service';
import { EamService } from '../eam/eam.service';
import { AssetsService } from '../assets/assets.service';
import { LedgerService } from '../ledger/ledger.service';
import { LedgerReadService } from '../ledger/ledger-read.service';
import { LeasesService } from '../leases/leases.service';
import { ScheduledChangesService } from '../scheduled-changes/scheduled-changes.service';
import { RevRecService } from '../revenue/revrec.service';
import { ProjectsService } from '../projects/projects.service';
import { RetentionService } from '../retention/retention.service';
import { RealEstateService } from '../realestate/realestate.service';
import { CrmPipelineService } from '../crm/pipeline/crm-pipeline.service';
import { CrmAccountHealthService } from '../crm/account-health/crm-account-health.module';
import { CrmService } from '../crm/crm.service';
import { NpsService } from '../nps/nps.service';
import { MembershipService } from '../loyalty/membership.service';
import { JourneysService } from '../journeys/journeys.service';
import { BudgetService } from '../budget/budget.service';
import { ProcurementService } from '../procurement/procurement.service';
import { ThreeWayMatchService } from '../match/three-way-match.service';
import { BillingService } from '../billing/billing.service';
import { PdpaService } from '../pdpa/pdpa.service';
import { GovernanceService } from '../governance/governance.service';
import { TaxJobsService } from '../tax/tax-jobs.service';
import { HcmLeaveService } from '../hcm/hcm-leave.service';
import { FluxService } from '../flux/flux.service';
import { RevDisclosureService } from '../revrec-disclosure/rev-disclosure.service';
import { MarketingAutomationService } from '../marketing/marketing-automation.service';
import { VouchersService } from '../campaigns/vouchers.service';
import { FoodCostService } from '../menu/food-cost.service';
import type { JwtUser } from '../../common/decorators';
import type { BiReportGenerator, BiReportSource } from './report-registry';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// Report generation (docs/38 §3 bi pilot, extraction PR-2). generateReport + its ~50 report-type branches
// and the exec_scorecard composite moved VERBATIM out of bi.service.ts behind the facade: BiService keeps a
// private generateReport delegator (used by executeSubscription/reportTypes), so the public API and the
// BiService constructor (a positional contract — the goldenmaster harness constructs it by position) are
// byte-identical. The cached read core (kpiBoard/salesCube/financeTrend/pipelineTrend) STAYS on BiService;
// branches that need it receive it through the BiReadPort callback interface (BiService passes `this`) —
// structural typing, no forwardRef cycle.
export interface BiReadPort {
  kpiBoard(user: JwtUser): Promise<any>;
  salesCube(dto: { period?: 'day' | 'week' | 'month'; start_date?: string; end_date?: string; months?: number }, user: JwtUser): Promise<any>;
  financeTrend(dto: { months?: number; ledger_code?: string }, user: JwtUser): Promise<any>;
  pipelineTrend(dto: { months?: number }, user: JwtUser): Promise<any>;
}

@Injectable()
export class BiGenerateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    // The same @Optional wiring the branches had on BiService — a partial harness still constructs.
    @Optional() private readonly collections?: CollectionsService,
    @Optional() private readonly financeMetrics?: FinanceMetricsService,
    @Optional() private readonly eam?: EamService,
    @Optional() private readonly assets?: AssetsService,
    @Optional() private readonly ledger?: LedgerService,
    @Optional() private readonly leases?: LeasesService,
    @Optional() private readonly scheduledChanges?: ScheduledChangesService,
    @Optional() private readonly revrec?: RevRecService,
    @Optional() private readonly projects?: ProjectsService,
    @Optional() private readonly retention?: RetentionService,
    @Optional() private readonly realestate?: RealEstateService,
    @Optional() private readonly crm?: CrmPipelineService,
    @Optional() private readonly crmMembers?: CrmService,
    @Optional() private readonly nps?: NpsService,
    @Optional() private readonly membership?: MembershipService,
    @Optional() private readonly journeys?: JourneysService,
    @Optional() private readonly budget?: BudgetService,
    @Optional() private readonly procurement?: ProcurementService,
    @Optional() private readonly match?: ThreeWayMatchService,
    @Optional() private readonly billing?: BillingService,
    @Optional() private readonly pdpa?: PdpaService,
    @Optional() private readonly governance?: GovernanceService,
    @Optional() private readonly taxJobs?: TaxJobsService,
    // HR-2 (docs/42) — supplies the hr_leave_accrual scheduled action job. @Optional so a partial harness constructs.
    @Optional() private readonly hcmLeave?: HcmLeaveService,
    // CLS-01 (GL-25) — supplies the flux_analysis report. Appended at the END to preserve the positional
    // constructor contract the goldenmaster harness relies on. @Optional so a partial harness constructs.
    @Optional() private readonly flux?: FluxService,
    // REV-27 (Track D Wave 4) — supplies the contract_liability_rollforward + rpo_backlog disclosure reports.
    // Appended at the END to preserve the positional constructor contract the goldenmaster harness relies on.
    @Optional() private readonly revDisclosure?: RevDisclosureService,
    // G4 (docs/45) — supply the marketing_roi report. Appended at the END (positional contract, as above).
    @Optional() private readonly marketingAuto?: MarketingAutomationService,
    @Optional() private readonly vouchers?: VouchersService,
    @Optional() private readonly foodCost?: FoodCostService,
    // CRM-15 (CRM-08) — supplies the crm_account_health snapshot action job. Appended at the END to preserve
    // the positional constructor contract the goldenmaster harness relies on. @Optional so a partial harness constructs.
    @Optional() private readonly crmHealth?: CrmAccountHealthService,
    // docs/46 Phase 3 — the line_daily_digest GL cash position rides the ledger's narrow read API instead
    // of a direct journal join here. Appended at the END (positional contract, as above).
    @Optional() private readonly ledgerRead?: LedgerReadService,
  ) {}

  // docs/46 Phase 1 — module-owned generators, filled at boot by BiReportRegistrarService (see
  // report-registry.ts). Consulted BEFORE the legacy if-chain below, so a migrated report type has exactly
  // one home; new report types register here from their owning module instead of growing this file (the
  // check-service-size ratchet enforces it).
  private readonly registered = new Map<string, BiReportGenerator>();
  registerReports(source: BiReportSource) {
    for (const g of source.biReports()) this.registered.set(g.type, g);
  }

  async generateReport(reportType: string, filters: any, user: JwtUser, reads: BiReadPort): Promise<{ data: any; summary: string; summaryTh: string }> {
    const f = filters ?? {};
    const provider = this.registered.get(reportType);
    if (provider) return provider.generate(f, user);
    if (reportType === 'kpi_board') {
      const k = await reads.kpiBoard(user);
      return { data: k, summary: `MTD sales ${k.sales.mtd}, open AR ${k.receivables.open_ar}, open AP ${k.payables.open_ap}, pipeline ${k.pipeline.open_value}`, summaryTh: `ยอดขายเดือนนี้ ${k.sales.mtd} · ลูกหนี้คงค้าง ${k.receivables.open_ar} · เจ้าหนี้คงค้าง ${k.payables.open_ap}` };
    }
    if (reportType === 'sales_cube') {
      const c = await reads.salesCube({ period: f.period, months: f.months, start_date: f.start_date, end_date: f.end_date }, user);
      return { data: c, summary: `Sales ${c.totals.total_sales} across ${c.rows.length} ${c.period_type}(s), ${c.totals.total_orders} orders`, summaryTh: `ยอดขายรวม ${c.totals.total_sales} · ${c.totals.total_orders} ออเดอร์` };
    }
    if (reportType === 'finance_trend') {
      const t = await reads.financeTrend({ months: f.months, ledger_code: f.ledger_code }, user);
      const last = t.trend[t.trend.length - 1];
      return { data: t, summary: last ? `Latest ${last.period}: revenue ${last.revenue}, gross profit ${last.gross_profit} (${last.margin_pct}%)` : 'No posted GL in range', summaryTh: last ? `งวดล่าสุด ${last.period}: รายได้ ${last.revenue} · กำไรขั้นต้น ${last.gross_profit}` : 'ไม่มีรายการบัญชีในช่วงนี้' };
    }
    if (reportType === 'pipeline_trend') {
      const p = await reads.pipelineTrend({ months: f.months }, user);
      const last = p.trend[p.trend.length - 1];
      return { data: p, summary: last ? `Latest ${last.month}: ${last.open} open (${last.open_value}), win rate ${last.win_rate_pct}%` : 'No pipeline in range', summaryTh: last ? `เดือนล่าสุด ${last.month}: เปิดอยู่ ${last.open} รายการ` : 'ไม่มีไปป์ไลน์ในช่วงนี้' };
    }
    if (reportType === 'audience_export_sync') return this.audienceExportSync(user, f);
    if (reportType === 'line_daily_digest') {
      const db = this.db;
      const tenantCond = user.tenantId != null ? eq(workflowInstances.tenantId, user.tenantId) : sql`true`;
      const [wf] = await db.select({ c: sql<number>`count(*)` }).from(workflowInstances).where(and(eq(workflowInstances.status, 'pending'), tenantCond));
      const [pr] = await db.select({ c: sql<number>`count(*)` }).from(purchaseRequests).where(eq(purchaseRequests.status, 'Pending'));
      const [ae] = await db.select({ c: sql<number>`count(*)` }).from(alertEvents).where(and(user.tenantId != null ? eq(alertEvents.tenantId, user.tenantId) : sql`true`, sql`${alertEvents.firedAt} > now() - interval '24 hours'`));
      // LP-3 (docs/31) — the wider KPI catalog (Asia/Bangkok business day). Computed ONCE per tenant here;
      // delivery filters per recipient by effective permissions (see runSubscription). Read-only aggregates.
      const bkkNow = new Date(Date.now() + 7 * 3600_000);
      const today = bkkNow.toISOString().slice(0, 10);
      const yesterday = new Date(bkkNow.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
      const [sy] = await db.select({ v: sql<string>`coalesce(sum(${arInvoices.amount}), 0)` }).from(arInvoices)
        .where(and(user.tenantId != null ? eq(arInvoices.tenantId, user.tenantId) : sql`true`, eq(arInvoices.invoiceDate, yesterday)));
      const [ao] = await db.select({ v: sql<string>`coalesce(sum(${arInvoices.amount} - coalesce(${arInvoices.paidAmount}, 0)), 0)` }).from(arInvoices)
        .where(and(user.tenantId != null ? eq(arInvoices.tenantId, user.tenantId) : sql`true`, sql`${arInvoices.status} <> 'Paid'`, sql`${arInvoices.dueDate} < ${today}`));
      // docs/46 Phase 3 — the GL cash position comes from the ledger's narrow read API (CASH_ACCOUNTS +
      // the journal join live with the ledger, not here). ledgerRead is DI-provided in the app; a partial
      // hand-built harness without it reads 0, matching the other degrade-to-empty legs of this digest.
      const cp = { v: this.ledgerRead ? await this.ledgerRead.cashPosition(user.tenantId ?? null) : 0 };
      const [ls] = await db.select({ c: sql<number>`count(*)` }).from(branchStock)
        .where(and(user.tenantId != null ? eq(branchStock.tenantId, user.tenantId) : sql`true`,
          sql`${branchStock.reorderPoint} > 0 and ${branchStock.onHand} <= ${branchStock.reorderPoint}`));
      const data = {
        pending_approvals: Number(wf?.c ?? 0), open_prs: Number(pr?.c ?? 0), alerts_24h: Number(ae?.c ?? 0),
        sales_yesterday: Number(sy?.v ?? 0), cash_position: Number(cp?.v ?? 0), ar_overdue: Number(ao?.v ?? 0), low_stock: Number(ls?.c ?? 0),
      };
      return {
        data,
        summary: `Daily digest: ${data.pending_approvals} pending approvals · ${data.open_prs} open PRs · ${data.alerts_24h} alerts (24h)`,
        summaryTh: `สรุปเช้านี้: รออนุมัติ ${data.pending_approvals} รายการ · PR ค้าง ${data.open_prs} · แจ้งเตือนใน 24 ชม. ${data.alerts_24h}`,
      };
    }
    if (reportType === 'data_retention_purge') {
      // Delete ONLY dead ephemeral security rows (auth-global, no statutory value once expired). This
      // NEVER touches financial / audit / transactional / PII tables — those are under statutory legal
      // hold (see docs/ops/data-retention-policy.md). Idempotent. refresh_tokens are kept until EXPIRED
      // (not merely rotated) so reuse-detection still works within a token's life.
      const db = this.db;
      const rows = (res: any): number => (res?.rows?.length ?? (Array.isArray(res) ? res.length : 0));
      const a = await db.execute(sql`DELETE FROM revoked_tokens WHERE expires_at < now() RETURNING 1 AS one`);
      const b = await db.execute(sql`DELETE FROM refresh_tokens WHERE expires_at < now() RETURNING 1 AS one`);
      const c = await db.execute(sql`DELETE FROM sso_login_state WHERE expires_at < now() RETURNING 1 AS one`);
      const d = await db.execute(sql`DELETE FROM member_otps WHERE consumed_at IS NOT NULL OR expires_at < now() RETURNING 1 AS one`);
      const purged = { revoked_tokens: rows(a), refresh_tokens: rows(b), sso_login_state: rows(c), member_otps: rows(d) };
      const total = purged.revoked_tokens + purged.refresh_tokens + purged.sso_login_state + purged.member_otps;
      return { data: purged, summary: `Retention purge: removed ${total} expired ephemeral security rows (financial/audit data untouched)`, summaryTh: `ล้างข้อมูลชั่วคราวที่หมดอายุ ${total} รายการ (ไม่แตะข้อมูลการเงิน/ออดิต)` };
    }
    if (reportType === 'marketing_roi') return this.marketingRoi(user, f);
    if (reportType === 'exec_scorecard') {
      const r = await this.execScorecard(user, reads);
      return { data: r, summary: `Exec: sales(MTD) ${r.finance.sales_mtd}, margin ${r.finance.margin_pct ?? '—'}%, win rate ${r.crm.win_rate_pct ?? '—'}%, portfolio CPI ${r.projects.cpi ?? '—'}, ${r.supply_chain.blocked_invoices} held invoice(s)`, summaryTh: `ผู้บริหาร: ยอดขายเดือนนี้ ${r.finance.sales_mtd} · มาร์จิน ${r.finance.margin_pct ?? '—'}% · อัตราชนะ ${r.crm.win_rate_pct ?? '—'}% · CPI ${r.projects.cpi ?? '—'}` };
    }
    if (reportType === 'key_rotation_sweep') {
      // 4.3 (ITGC-AC-12) — re-encrypt at-rest ciphertext under the ACTIVE key id (common/crypto.ts keyring).
      // INERT with no keyring configured: active kid = legacy '1' and every existing blob is already v1 ⇒
      // needsRotation() is false for every row, so the sweep scans and rotates 0. After ops sets
      // APP_ENC_KEYRING + APP_ENC_ACTIVE_KID, each run re-encrypts up to 500 rows/column (idempotent — the
      // ciphertext's embedded key id is the discriminator; re-runs converge to 0). Plaintext legacy rows are
      // the encrypt-backfill's job (tools db:backfill-encrypt-pii), not rotation's — they are skipped here.
      const db = this.db;
      const targets: { table: string; column: string }[] = [
        { table: 'customer_master', column: 'tax_id' }, { table: 'customer_master', column: 'address' }, { table: 'customer_master', column: 'notes' },
        { table: 'employees', column: 'national_id' }, { table: 'employees', column: 'sso_no' }, { table: 'employees', column: 'bank_account' },
        { table: 'payslips', column: 'national_id' },
        { table: 'vendors', column: 'tax_id' }, { table: 'vendors', column: 'bank_account' },
        { table: 'vendor_bank_change_requests', column: 'bank_account' }, { table: 'vendor_bank_change_requests', column: 'prev_bank_account' },
        { table: 'customer_addresses', column: 'address_line1' }, { table: 'vendor_addresses', column: 'address_line1' },
        { table: 'users', column: 'totp_secret' }, { table: 'webhooks', column: 'secret' },
        { table: 'tenant_identity', column: 'oidc_client_secret_enc' }, { table: 'tenant_messaging_config', column: 'config_enc' },
      ];
      const activeKid = activeKeyId();
      let scanned = 0, rotated = 0;
      const perColumn: { table: string; column: string; scanned: number; rotated: number }[] = [];
      for (const t of targets) {
        // Identifiers come from the compile-time const list above (never user input); values are bound.
        const res: any = await db.execute(sql`SELECT id, ${sql.raw(`"${t.column}"`)} AS val FROM ${sql.raw(`"${t.table}"`)} WHERE ${sql.raw(`"${t.column}"`)} LIKE 'v%:%' LIMIT 500`);
        const rows: any[] = res.rows ?? res;
        let colScanned = 0, colRotated = 0;
        for (const row of rows) {
          colScanned++;
          const val = String(row.val ?? '');
          if (!needsRotation(val)) continue; // already under the active key (or a v-prefixed plaintext false-positive)
          const reenc = encrypt(decrypt(val)); // decrypt via the blob's embedded kid, re-encrypt under the active kid
          await db.execute(sql`UPDATE ${sql.raw(`"${t.table}"`)} SET ${sql.raw(`"${t.column}"`)} = ${reenc} WHERE id = ${row.id}`);
          colRotated++;
        }
        scanned += colScanned; rotated += colRotated;
        if (colScanned) perColumn.push({ table: t.table, column: t.column, scanned: colScanned, rotated: colRotated });
      }
      const data = { active_key_id: activeKid, scanned, rotated, per_column: perColumn };
      return { data, summary: `Key rotation sweep (active kid ${activeKid}): re-encrypted ${rotated} of ${scanned} scanned ciphertext(s)`, summaryTh: `หมุนกุญแจเข้ารหัส (kid ${activeKid}): เข้ารหัสใหม่ ${rotated} จาก ${scanned} รายการ` };
    }
    throw new BadRequestException({ code: 'BAD_REPORT_TYPE', message: `Unknown report type '${reportType}'`, messageTh: 'ไม่รู้จักประเภทรายงานนี้' });
  }

  // G4 (docs/45) — one exec view of marketing spend → lift → margin. HONEST FRAMING (the semantic trap the
  // plan calls out): campaign attribution's redeemedValue is the DISCOUNT GIVEN (marketing cost), never
  // revenue — real revenue comes from the redeemed sales' own totals, margin from their line items joined
  // to the recipe-based food-cost layer (the same source menu-engineering uses), and the organic holdout
  // lift is the incremental-revenue truth. Optional legs degrade to null like execScorecard.
  // G3 (docs/45) — PDPA-05: the consent-gated, hashed ads-audience activation job. FAIL-CLOSED twice over:
  // (1) it refuses to run without an ACTIVE ROPA activity named 'audience_export' with legal_basis='consent'
  // (the processing register IS the permission to process — ROPA_MISSING otherwise, recorded 'blocked');
  // (2) the payload builder (CrmService.exportForCustomerMatch) includes ONLY members with a live marketing
  // consent row and emits ONLY sha256 hashes — raw PII never reaches the wire. Every attempt lands in the
  // append-only audience_exports register; the push routes through the SSRF-gated pushHashedAudience.
  private async audienceExportSync(user: JwtUser, f: any) {
    if (!this.crmMembers) throw new BadRequestException({ code: 'CRM_UNAVAILABLE', message: 'CRM service not available', messageTh: 'ระบบ CRM ไม่พร้อมใช้งาน' });
    const db = this.db;
    const tenantId = f.tenant_id ?? user.tenantId;
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id' });

    const [ropa] = await db.select().from(ropaActivities).where(and(
      eq(ropaActivities.tenantId, Number(tenantId)), eq(ropaActivities.active, true),
      eq(ropaActivities.name, 'audience_export'), eq(ropaActivities.legalBasis, 'consent'),
    )).limit(1);
    if (!ropa) {
      const blockedTargets = [...resolveAudienceProviders().map((p) => p.name), ...(audienceExportConfigured() ? ['webhook'] : [])];
      await db.insert(audienceExports).values({ tenantId: Number(tenantId), target: blockedTargets.length ? blockedTargets.join('+') : 'mock', status: 'blocked', error: 'ROPA_MISSING', createdBy: user.username }).catch(() => null);
      throw new BadRequestException({ code: 'ROPA_MISSING', message: "Audience export is blocked: create an ACTIVE ROPA activity named 'audience_export' with legal_basis='consent' (POST /api/pdpa/ropa) first", messageTh: 'ยังส่งกลุ่มเป้าหมายไม่ได้: ต้องบันทึกกิจกรรม ROPA ชื่อ audience_export (ฐานความยินยอม) ก่อน' });
    }

    // Targets: every env-configured DIRECT adapter (meta/google) + the generic webhook; none ⇒ mock.
    // Each recipient gets its OWN append-only register row (per-recipient PDPA evidence).
    const providers = resolveAudienceProviders();
    const targets: string[] = [...providers.map((p) => p.name), ...(audienceExportConfigured() ? ['webhook'] : [])];
    const targetLabel = targets.length ? targets.join('+') : 'mock';
    const BATCH = 500;
    let consented = 0, considered = 0;
    const batches: any[] = [];
    let offset = 0;
    for (let i = 0; i < 200; i++) { // safety cap: 200 batches (100k members)
      const exp: any = await this.crmMembers.exportForCustomerMatch(user, { tenantId: Number(tenantId), limit: BATCH, offset });
      if (exp?.error) throw new BadRequestException(exp.error);
      considered = exp.total_active; consented = exp.consented;
      if (exp.members?.length) batches.push(exp);
      offset += exp.count;
      if (exp.count < BATCH) break;
    }
    const totalRows = batches.reduce((a, b) => a + b.members.length, 0);
    const sessionId = Date.now();
    // member_id is INTERNAL (manifest upkeep) — strip it from every wire payload
    const wireRows = (members: any[]) => members.map(({ member_id, ...hashes }: any) => hashes);

    const results: { target: string; ok: boolean; err: string | null; ref?: string }[] = [];
    // webhook / mock leg (unchanged contract: per-batch JSON POST via the SSRF-gated pushHashedAudience)
    if (!targets.length || targets.includes('webhook')) {
      let ok = true, err: string | null = null;
      for (let i = 0; i < batches.length; i++) {
        const exp = batches[i]!;
        const r = await pushHashedAudience({ tenant_id: exp.tenant_id, hash_alg: exp.hash_alg, consent_basis: exp.consent_basis, batch: i, offset: i * BATCH, count: exp.members.length, members: wireRows(exp.members) });
        if (!r.ok) { ok = false; err = r.error ?? `status ${r.status}`; break; }
      }
      results.push({ target: targets.length ? 'webhook' : 'mock', ok, err });
    }
    // direct adapters: each gets the full session (create → add per batch → finalize on the last batch)
    for (const provider of providers) {
      let ok = true, err: string | null = null, ref: string | undefined;
      for (let i = 0; i < batches.length; i++) {
        const r = await provider.push(wireRows(batches[i]!.members), { sessionId, batchSeq: i + 1, lastBatch: i === batches.length - 1, estimatedTotal: totalRows });
        ref = r.ref ?? ref;
        if (!r.ok) { ok = false; err = r.error ?? `status ${r.status}`; break; }
      }
      results.push({ target: provider.name, ok, err, ref });
    }

    // ── Withdrawal removal sync (extends PDPA-05): keep the EXTERNAL audience continuously consistent
    //    with the consent ledger. Only meaningful when at least one REAL target exists and its upload
    //    succeeded (a mock run maintains no external audience). Manifest first, then prune. ──
    const anyRealSuccess = results.some((r) => r.target !== 'mock' && r.ok);
    let removed = 0;
    let removalErr: string | null = null;
    if (anyRealSuccess && totalRows > 0) {
      const uploaded = batches.flatMap((b: any) => b.members);
      await this.crmMembers.upsertAudienceManifest(Number(tenantId), uploaded).catch(() => null);
    }
    if (anyRealSuccess) {
      const candidates = await this.crmMembers.audienceRemovalCandidates(Number(tenantId));
      if (candidates.length) {
        const removalSession = sessionId + 1; // its own adapter session (Google gets its own remove job)
        let allOk = true;
        if (targets.includes('webhook')) {
          const r = await pushHashedAudience({ tenant_id: Number(tenantId), action: 'remove', hash_alg: 'sha256', consent_basis: 'member_consents:marketing', count: candidates.length, members: wireRows(candidates) });
          if (!r.ok) { allOk = false; removalErr = r.error ?? `status ${r.status}`; }
        }
        for (const provider of providers) {
          const r = await provider.remove(wireRows(candidates), { sessionId: removalSession, batchSeq: 1, lastBatch: true, estimatedTotal: candidates.length });
          if (!r.ok) { allOk = false; removalErr = r.error ?? `status ${r.status}`; }
        }
        // stamp removed ONLY when every configured target accepted the removal — a partial removal must
        // stay a candidate next run (fail-visible, never fail-silent)
        if (allOk) { await this.crmMembers.markAudienceRemoved(Number(tenantId), candidates.map((c: any) => c.member_id)); removed = candidates.length; }
      }
    }

    for (const r of results) {
      await db.insert(audienceExports).values({
        tenantId: Number(tenantId), target: r.target, membersConsidered: considered, membersConsented: consented,
        rowsPushed: r.ok ? totalRows : 0, rowsRemoved: r.ok ? removed : 0, status: r.ok ? 'success' : 'failed', error: r.err ?? removalErr,
        ropaActivityId: Number(ropa.id), createdBy: user.username,
      }).catch(() => null);
    }
    const failed = results.filter((r) => !r.ok);
    if (failed.length) throw new BadRequestException({ code: 'AUDIENCE_PUSH_FAILED', message: `Audience push failed (${failed.map((r) => r.target).join(', ')}): ${failed[0]!.err}`, messageTh: 'ส่งกลุ่มเป้าหมายไม่สำเร็จ' });
    if (removalErr) throw new BadRequestException({ code: 'AUDIENCE_REMOVE_FAILED', message: `Audience removal failed: ${removalErr}`, messageTh: 'ถอนสมาชิกออกจากกลุ่มเป้าหมายไม่สำเร็จ' });

    return {
      data: { targets: results.map((r) => ({ target: r.target, ok: r.ok, ref: r.ref ?? null })), considered, consented, pushed: totalRows, removed, hash_alg: 'sha256', consent_basis: 'member_consents:marketing', ropa_activity_id: Number(ropa.id) },
      summary: `Audience export: ${totalRows} hashed row(s) from ${consented} consented (of ${considered} active) → ${targetLabel}${removed ? `; removed ${removed} withdrawn` : ''}; ROPA #${ropa.id}`,
      summaryTh: `ส่งกลุ่มเป้าหมายโฆษณา: ${totalRows} แถว (hash) จากสมาชิกยินยอม ${consented}/${considered} → ${targetLabel}${removed ? ` · ถอนผู้ถอนความยินยอม ${removed}` : ''} · ROPA #${ropa.id}`,
    };
  }

  private async marketingRoi(user: JwtUser, f: any) {
    if (!this.marketingAuto) throw new BadRequestException({ code: 'MARKETING_UNAVAILABLE', message: 'Marketing automation service not available', messageTh: 'ระบบการตลาดอัตโนมัติไม่พร้อมใช้งาน' });
    const mkt = await this.marketingAuto.roiAttribution(user, { days: f.days });

    // margin on the attributed sales via the food-cost layer (only costed items count; coverage is reported)
    let margin: { attributed_margin: number; costed_coverage_pct: number } | null = null;
    if (this.foodCost && mkt.attributed.items.length) {
      const m = await this.foodCost.menuMargins(user).catch(() => null);
      if (m) {
        const costBySku = new Map<string, any>((m.items ?? []).map((i: any) => [String(i.sku), i]));
        let attributedMargin = 0, costedAmount = 0, totalAmount = 0;
        for (const it of mkt.attributed.items) {
          totalAmount = round2(totalAmount + it.amount);
          const cm = costBySku.get(String(it.item_id));
          if (cm && cm.costed) { attributedMargin = round2(attributedMargin + (it.amount - n(cm.cost) * it.qty)); costedAmount = round2(costedAmount + it.amount); }
        }
        margin = { attributed_margin: attributedMargin, costed_coverage_pct: totalAmount > 0 ? round2((costedAmount / totalAmount) * 100) : 0 };
      }
    }

    const vouchers = this.vouchers
      ? await this.vouchers.listCampaigns(user, {}).then((v: any) => {
          const cs = v.campaigns ?? [];
          const redeemed = cs.reduce((a: number, c: any) => a + n(c.redeemed_count), 0);
          // only amount-kind codes have a knowable discount without the sale; percent-kind is counted, not costed
          const est = cs.filter((c: any) => c.kind === 'amount').reduce((a: number, c: any) => a + n(c.value) * n(c.redeemed_count), 0);
          return { campaigns: cs.length, codes_redeemed: redeemed, est_discount_given_amount_kind: round2(est) };
        }).catch(() => null)
      : null;
    const b2b = this.crm ? await this.crm.sourceRoi(user, { months: f.months }).catch(() => null) : null;
    const budget = this.budget && f.fiscal_year
      ? await this.budget.budgetVsActual({ fiscal_year: Number(f.fiscal_year), period: f.period, cost_center: f.cost_center }).catch(() => null)
      : null;

    const spend = round2(mkt.discount_cost + (vouchers?.est_discount_given_amount_kind ?? 0));
    const netMargin = margin ? round2(margin.attributed_margin - mkt.discount_cost) : null;
    const totals = {
      spend, attributed_sales: mkt.attributed.sales_count, attributed_revenue: mkt.attributed.revenue,
      attributed_margin: margin?.attributed_margin ?? null, net_margin_after_discount: netMargin,
      roi_on_spend: netMargin != null && spend > 0 ? round2(netMargin / spend) : null,
      organic_incremental_revenue: mkt.lift?.incremental_revenue ?? null,
      b2b_won: b2b?.total_won ?? null,
    };
    const data = { window_days: mkt.window_days, totals, campaigns: mkt.campaigns, top_campaigns: mkt.top_campaigns, attributed: mkt.attributed, margin, lift: mkt.lift, vouchers, b2b, budget, note: 'spend = ส่วนลดที่ให้จริง (redeemedValue) — ไม่ใช่รายได้; รายได้/กำไรมาจากบิลที่แลกจริง; lift มาจาก holdout baseline' };
    const mg = margin ? `, margin ${margin.attributed_margin} (net ${netMargin})` : '';
    const lf = mkt.lift ? `; organic lift +${mkt.lift.incremental_revenue} (${mkt.lift.campaigns_measured} campaign(s))` : '';
    const bb = b2b ? `; B2B won ${b2b.total_won}` : '';
    return {
      data,
      summary: `Marketing ROI (${mkt.window_days}d): spend ${spend} → ${mkt.attributed.sales_count} attributed sale(s), revenue ${mkt.attributed.revenue}${mg}${lf}${bb}`,
      summaryTh: `ผลตอบแทนการตลาด (${mkt.window_days} วัน): ใช้ส่วนลด ${spend} → บิลที่แลก ${mkt.attributed.sales_count} ใบ รายได้ ${mkt.attributed.revenue}${margin ? ` กำไรขั้นต้น ${margin.attributed_margin} (สุทธิ ${netMargin})` : ''}${mkt.lift ? ` · lift ${mkt.lift.incremental_revenue}` : ''}${b2b ? ` · B2B ชนะ ${b2b.total_won}` : ''}`,
    };
  }

  private async execScorecard(user: JwtUser, reads: BiReadPort) {
    const kpi: any = await reads.kpiBoard(user).catch(() => null);
    const fin: any = await reads.financeTrend({ months: 6 }, user).catch(() => null);
    const finLast = fin?.trend?.[fin.trend.length - 1] ?? null;
    const pipe: any = await reads.pipelineTrend({ months: 6 }, user).catch(() => null);
    const pipeLast = pipe?.trend?.[pipe.trend.length - 1] ?? null;
    const portfolio: any = this.projects ? await this.projects.portfolioEvm(user).catch(() => null) : null;
    const scorecards: any = this.procurement ? await this.procurement.listScorecards({}, user).catch(() => null) : null;
    const holds: any = this.match ? await this.match.listResults({ blocked: true }, user).catch(() => null) : null;
    // docs/35 Phase 1 — pull the finance leg from the canonical KPI engine (single source of truth) when
    // wired; fall back to the legacy trend-derived margin so a partial harness still returns a scorecard.
    const finMetrics: any = this.financeMetrics ? await this.financeMetrics.execFinance(user).catch(() => null) : null;
    return {
      as_of: new Date().toISOString().slice(0, 10),
      finance: {
        sales_mtd: n(kpi?.sales?.mtd), sales_ytd: n(kpi?.sales?.ytd),
        open_ar: n(kpi?.receivables?.open_ar), open_ap: n(kpi?.payables?.open_ap),
        margin_pct: finMetrics ? finMetrics.net_margin_pct : (finLast ? n(finLast.margin_pct) : null),
        gross_profit: finLast ? n(finLast.gross_profit) : null,
        gross_margin_pct: finMetrics?.gross_margin_pct ?? null, current_ratio: finMetrics?.current_ratio ?? null,
        dso: finMetrics?.dso ?? null, operating_cash_flow: finMetrics?.operating_cash_flow ?? null,
        cash_runway_months: finMetrics?.cash_runway_months ?? null,
        kpi_red_flags: finMetrics?.red_flags ?? [],
      },
      crm: {
        open_value: n(kpi?.pipeline?.open_value),
        win_rate_pct: pipeLast ? n(pipeLast.win_rate_pct) : null, open_count: pipeLast ? n(pipeLast.open) : null,
      },
      projects: {
        count: portfolio?.count ?? null, cpi: portfolio?.totals?.cpi ?? null,
        at_risk: portfolio?.at_risk?.length ?? null, over_allocated: portfolio?.capacity?.over_allocated_count ?? null,
      },
      supply_chain: {
        blocked_invoices: n(holds?.blocked), suppliers_scored: scorecards?.count ?? 0,
        supplier_avg_score: scorecards?.avg_score ?? null, underperformers: scorecards?.underperformers ?? 0,
      },
      // The single "what needs attention" rollup — non-zero items the exec should act on.
      attention: {
        held_invoices: n(holds?.blocked),
        at_risk_projects: portfolio?.at_risk?.length ?? 0,
        budget_unfavorable: finLast && n(finLast.margin_pct) < 0,
        supplier_underperformers: scorecards?.underperformers ?? 0,
      },
    };
  }
}
