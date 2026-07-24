import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { resolveEntitledSuites } from '@ierp/shared';
import type { DrizzleDb } from '../../../database/database.module';
import { crmLeads, plans, subscriptions } from '../../../database/schema';
import { tenants } from '../../../database/schema/tenants';
import { entitlementsEnforced } from '../../billing/plan.guard';
import { DocNumberService } from '../../../common/doc-number.service';
import { parseCsv, parseXlsx, type ImportError } from '../../masterdata/masterdata.service';
import type { JwtUser } from './../../../common/decorators';

// CRM-2 lead capture (public web-to-lead + bulk import wizard) — extracted off CrmPipelineService
// (600-LOC service-size headroom round; ctor-body plain class, no DI). Scoring + the pipeline event
// bus stay canonical on the facade and arrive as ctor closures (the CrmPipelineLegacyService pattern).
export class CrmLeadCaptureService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly scoreLead: (leadNo: string, user: JwtUser) => Promise<{ grade: string }>,
    private readonly emitEvent: (event: string, payload: Record<string, any>, user: JwtUser) => Promise<void>,
  ) {}

  // ── Lead capture (CRM-2) ───────────────────────────────────────────────

  // Public website-form capture → a 'web' lead. Tenant resolution: an explicit tenant_code wins; a
  // single-tenant install needs none. The caller is anonymous (no JWT) — the edge rate limiter gives this
  // path its own strict per-IP bucket (see common/edge.ts), and the controller silently drops honeypot hits
  // before this method runs. Responds { ok: true } only (no lead number leaks to the public caller).
  async webToLead(dto: { name: string; company?: string; email?: string; phone?: string; message?: string; source?: string; tenant_code?: string }) {
    const db = this.db;
    let tenantId: number | null = null;
    if (dto.tenant_code) {
      const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, dto.tenant_code)).limit(1);
      if (!t) throw new BadRequestException({ code: 'TENANT_NOT_FOUND', message: 'Unknown tenant code', messageTh: 'ไม่พบรหัสบริษัทนี้' });
      tenantId = Number(t.id);
    } else {
      const ts = await db.select({ id: tenants.id }).from(tenants).limit(2);
      if (ts.length === 1) tenantId = Number(ts[0]!.id);
      else throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'tenant_code is required on a multi-tenant install', messageTh: 'ต้องระบุ tenant_code' });
    }
    // 0451 — web-to-lead is the 'integrations' add-on suite. The route is @Public (PlanGuard never sees
    // it), so the entitlement is checked HERE against the resolved tenant, mirroring the guard's
    // semantics: only when ENTITLEMENTS_ENFORCE is on; an unexpired trial grants everything; the plan's
    // suites plus purchased subscriptions.addons decide. Grandfathered into pro/franchise/enterprise.
    if (entitlementsEnforced()) await this.assertIntegrationsEntitled(tenantId);
    const leadNo = await this.docNo.nextDaily('LEAD');
    const source = dto.source?.trim().slice(0, 60) || 'web';
    await db.insert(crmLeads).values({
      tenantId, leadNo, name: dto.name.trim().slice(0, 200), company: dto.company?.trim().slice(0, 200) || null,
      email: dto.email?.trim().slice(0, 200) || null, phone: dto.phone?.trim().slice(0, 60) || null,
      source, status: 'new',
      notes: dto.message?.trim().slice(0, 2000) || null, createdBy: 'web-to-lead',
    });
    // CRM-4: score the inbound lead + emit lead.created (best-effort; the anonymous caller still gets { ok }).
    const sysUser = { username: 'web-to-lead', tenantId, role: 'System', customerName: null, permissions: [] } as unknown as JwtUser;
    try {
      const sc = await this.scoreLead(leadNo, sysUser);
      await this.emitEvent('lead.created', { lead_no: leadNo, name: dto.name, company: dto.company ?? null, source, owner: null, grade: sc.grade }, sysUser);
    } catch { /* best-effort */ }
    return { ok: true };
  }

  // 0451 — the enforce-mode entitlement read for the public webhook path (see webToLead). Fail-open on an
  // infra error like PlanGuard (a DB blip must never drop leads); a read that succeeds decides fail-closed.
  private async assertIntegrationsEntitled(tenantId: number): Promise<void> {
    let row: { features: unknown; status: string | null; trialEndsAt: Date | null; planCode: string | null; addons: unknown } | undefined;
    try {
      [row] = await this.db
        .select({ features: plans.features, status: subscriptions.status, trialEndsAt: subscriptions.trialEndsAt, planCode: subscriptions.planCode, addons: subscriptions.addons })
        .from(subscriptions)
        .leftJoin(plans, eq(subscriptions.planCode, plans.code))
        .where(eq(subscriptions.tenantId, tenantId))
        .orderBy(desc(subscriptions.createdAt))
        .limit(1);
    } catch { return; }
    if (row?.status === 'Trialing' && !(row.trialEndsAt && Date.now() > new Date(row.trialEndsAt).getTime())) return;
    const features = (row?.features as Record<string, unknown>) ?? {};
    const entitled = resolveEntitledSuites(row?.planCode ?? null, features.suites, row?.addons);
    if (!entitled.includes('integrations')) {
      throw new ForbiddenException({
        code: 'SUITE_NOT_ENTITLED',
        message: 'This company\'s plan does not include the inbound webhook integration (integrations add-on).',
        messageTh: 'แพ็กเกจของบริษัทนี้ไม่รวมโมดูล Webhook ขาเข้า กรุณาซื้อโมดูลเสริมหรืออัปเกรดแพ็กเกจ',
      });
    }
  }

  // Bulk lead import (CRM-2 wizard) — accepts csv / base64 xlsx / pre-parsed rows (the masterdata engine's
  // parsers, reused). Header contract: Name (required) + Company/Email/Phone/Source/Owner/Notes. dry_run
  // validates and reports per-row errors without writing; the commit skips invalid rows and numbers each
  // created lead through the normal LEAD- counter.
  static readonly LEAD_IMPORT_HEADERS = ['Name', 'Company', 'Email', 'Phone', 'Source', 'Owner', 'Notes'] as const;

  async importLeads(input: { format?: 'rows' | 'csv' | 'xlsx'; csv?: string; xlsx?: string; rows?: Record<string, any>[]; dry_run?: boolean }, user: JwtUser) {
    const rows: Record<string, any>[] = input.format === 'xlsx'
      ? await parseXlsx(Buffer.from(input.xlsx ?? '', 'base64'))
      : input.format === 'csv' ? parseCsv(input.csv ?? '') : (input.rows ?? []);
    if (!rows.length) throw new BadRequestException({ code: 'NO_ROWS', message: 'No rows to import', messageTh: 'ไม่มีข้อมูลให้นำเข้า' });
    if (!Object.keys(rows[0] ?? {}).includes('Name')) {
      throw new BadRequestException({ code: 'MISSING_COLUMNS', message: `Missing required column: Name`, messageTh: 'ขาดคอลัมน์ที่จำเป็น: Name' });
    }
    const errors: ImportError[] = [];
    const prepared: { rowNo: number; value: Record<string, any> }[] = [];
    rows.forEach((raw, i) => {
      const rowNo = i + 1;
      const name = String(raw['Name'] ?? '').trim();
      if (!name) { errors.push({ row: rowNo, column: 'Name', code: 'REQUIRED_EMPTY', message: `'Name' is required`, messageTh: `ต้องระบุ 'Name'` }); return; }
      const pick = (h: string, max: number) => { const v = String(raw[h] ?? '').trim(); return v ? v.slice(0, max) : null; };
      prepared.push({ rowNo, value: {
        name: name.slice(0, 200), company: pick('Company', 200), email: pick('Email', 200), phone: pick('Phone', 60),
        source: pick('Source', 60) ?? 'import', owner: pick('Owner', 60) ?? user.username, notes: pick('Notes', 2000),
      } });
    });
    if (input.dry_run) return { entity: 'crm_leads', dry_run: true, total: rows.length, valid: prepared.length, invalid: errors.length, errors };
    const db = this.db;
    // Allocate the LEAD- numbers up-front (the counter bump is atomic on its own row), then insert the
    // batch in one transaction so a mid-batch failure rolls the rows back together.
    const numbered: { leadNo: string; value: Record<string, any> }[] = [];
    for (const p of prepared) numbered.push({ leadNo: await this.docNo.nextDaily('LEAD'), value: p.value });
    let imported = 0;
    await db.transaction(async (tx: any) => {
      for (const p of numbered) {
        await tx.insert(crmLeads).values({ tenantId: user.tenantId ?? null, leadNo: p.leadNo, ...p.value, status: 'new', createdBy: user.username });
        imported++;
      }
    });
    return { entity: 'crm_leads', dry_run: false, total: rows.length, imported, skipped: rows.length - imported, errors };
  }
}
