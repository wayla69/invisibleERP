import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { fsReportDefinitions, accounts, tenants } from '../../database/schema';
import { currentTenantStore } from '../../common/tenant-context';
import { LedgerService } from '../ledger/ledger.service';
import { resolveBsGroup, resolveIsGroup } from '../ledger/ledger-statement-sections';
import { THAI_DBD_DEFS } from './thai-dbd-fs';
import { INDUSTRY_FS_DEFS } from './industry-fs';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const dayBefore = (ymd: string) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

// The RE account that closeYear sweeps the P&L into (ledger-constants 3100 Retained Earnings). The current
// unclosed-year result is presented against this component in the SOCE (as "profit for the period").
const RETAINED_EARNINGS = '3100';

// ── Financial-report builder config (stored in fs_report_definitions.config) ────────────────────────────
// A group either SELECTS accounts (accounts/prefixes/types) or COMPUTES a subtotal from other groups
// (sumOf: signed references). `normalSide` flips a credit-normal section to a positive display figure.
export interface FsGroup {
  key: string;
  label: string;
  labelTh?: string;
  level?: number;               // indent depth for presentation (0 = top)
  normalSide?: 'debit' | 'credit';
  accounts?: string[];          // explicit account codes
  prefixes?: string[];          // account-code startsWith
  types?: string[];             // account_type in (Asset|Liability|Equity|Revenue|Expense)
  bsGroups?: string[];          // resolved balance-sheet section (current_asset|noncurrent_asset|…|equity)
  isGroups?: string[];          // resolved income-statement section (revenue|cogs|selling_admin|…|tax)
  sumOf?: { key: string; factor: number }[]; // computed subtotal over other group keys
  showAccounts?: boolean;       // emit per-account child rows under the group
}
export interface FsBuilderConfig { groups?: FsGroup[] }
export interface FsNoteDef {
  number: string;
  title: string;
  titleTh?: string;
  policyText?: string;
  policyTextTh?: string;
  normalSide?: 'debit' | 'credit';
  accounts?: string[];
  prefixes?: string[];
  types?: string[];
}
export interface FsNotesConfig { notes?: FsNoteDef[] }

type NetRow = { account_code: string; account_name: string | null; account_type: string | null; net: number; bs_group?: string | null; is_group?: string | null; parent_code?: string | null };

@Injectable()
export class StatutoryFsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
  ) {}

  private tid(): number | null { return currentTenantStore()?.tenantId ?? null; }

  // ───────────────────── Report-definition CRUD (the buyer's own FS layouts) ─────────────────────
  async listDefinitions(statementType?: string) {
    const conds: any[] = [];
    if (statementType) conds.push(eq(fsReportDefinitions.statementType, statementType));
    const rows = await this.db.select().from(fsReportDefinitions)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(fsReportDefinitions.statementType), asc(fsReportDefinitions.code));
    const tenantDefs = rows.map((r: any) => this.shapeDef(r));
    // Surface the built-in Thai DBD/TFRS defaults too (so they are discoverable + renderable out of the box),
    // unless the tenant has authored its own definition of the same code (which overrides it).
    const authored = new Set(tenantDefs.map((d) => d.code));
    const builtins = Object.values(THAI_DBD_DEFS)
      .filter((d) => !authored.has(d.code) && (!statementType || d.statementType === statementType))
      .map((d) => ({ code: d.code, name: d.name, statement_type: d.statementType, config: d.config, active: true, created_by: 'system', is_default: true }));
    const definitions = [...tenantDefs, ...builtins].sort((a, b) => a.statement_type.localeCompare(b.statement_type) || a.code.localeCompare(b.code));
    return { definitions, count: definitions.length };
  }

  // The active tenant's industry (drives the per-industry default statutory layout). Null off-tenant.
  private async tenantIndustry(): Promise<string | null> {
    const tid = this.tid();
    if (tid == null) return null;
    const [row] = await this.db.select({ industry: tenants.industry }).from(tenants).where(eq(tenants.id, tid)).limit(1);
    return (row?.industry as string | null) ?? null;
  }

  async getDefinition(code: string) {
    const [row] = await this.db.select().from(fsReportDefinitions).where(eq(fsReportDefinitions.code, code)).limit(1);
    if (row) return this.shapeDef(row);
    // Fall back to a built-in Thai DBD/TFRS default so the standard statements render out of the box; a
    // tenant that authors its own definition of the same code (the DB row above) overrides it.
    const def = THAI_DBD_DEFS[code];
    if (def) {
      let name = def.name;
      let config = def.config;
      // P6: some industries have a genuinely different P&L SHAPE (nonprofit Statement of Activities,
      // manufacturing COGS-by-element, construction cost-of-work, hospitality departmental). Resolve the
      // caller's industry to its bespoke DBD-PL layout; everything else keeps the generic multi-step P&L.
      if (code === 'DBD-PL') {
        const ind = await this.tenantIndustry();
        const ic = ind ? INDUSTRY_FS_DEFS[ind]?.pl : undefined;
        if (ic) { name = ic.name; config = ic.config; }
      }
      return { code: def.code, name, statement_type: def.statementType, config, active: true, created_by: 'system', is_default: true };
    }
    throw new NotFoundException({ code: 'FS_DEF_NOT_FOUND', message: `FS report definition ${code} not found`, messageTh: `ไม่พบรูปแบบรายงาน ${code}` });
  }

  async upsertDefinition(dto: { code: string; name: string; statement_type: string; config: FsBuilderConfig | FsNotesConfig; active?: boolean }, createdBy: string) {
    const st = dto.statement_type;
    if (!['bs', 'pl', 'soce', 'notes'].includes(st)) {
      throw new BadRequestException({ code: 'FS_BAD_STATEMENT_TYPE', message: `statement_type must be one of bs|pl|soce|notes`, messageTh: 'ประเภทงบไม่ถูกต้อง' });
    }
    const tid = this.tid();
    const [existing] = await this.db.select().from(fsReportDefinitions).where(eq(fsReportDefinitions.code, dto.code)).limit(1);
    if (existing) {
      await this.db.update(fsReportDefinitions)
        .set({ name: dto.name, statementType: st, config: dto.config as Record<string, unknown>, active: dto.active ?? true, updatedAt: new Date() })
        .where(eq(fsReportDefinitions.id, existing.id));
      return this.getDefinition(dto.code);
    }
    await this.db.insert(fsReportDefinitions).values({
      tenantId: tid, code: dto.code, name: dto.name, statementType: st, config: dto.config as Record<string, unknown>,
      active: dto.active ?? true, createdBy,
    });
    return this.getDefinition(dto.code);
  }

  async deleteDefinition(code: string) {
    const [row] = await this.db.select().from(fsReportDefinitions).where(eq(fsReportDefinitions.code, code)).limit(1);
    if (!row) throw new NotFoundException({ code: 'FS_DEF_NOT_FOUND', message: `FS report definition ${code} not found`, messageTh: `ไม่พบรูปแบบรายงาน ${code}` });
    await this.db.delete(fsReportDefinitions).where(eq(fsReportDefinitions.id, row.id));
    return { deleted: true, code };
  }

  private shapeDef(r: any) {
    return { code: r.code, name: r.name, statement_type: r.statementType, config: r.config ?? {}, active: r.active, created_by: r.createdBy };
  }

  // ───────────────────── Financial-report builder (row-grouping + comparative columns) ─────────────────────
  // Renders a configured P&L (statement_type 'pl') or balance sheet ('bs') with buyer-defined subtotals /
  // row groups, plus a comparative (prior-period / budget) column — the reusable layout layer the notes,
  // SOCE and DBD exports all ride on. Numbers come from LedgerService.perAccountNet (the canonical engine).
  async renderStatement(code: string, params: { asOf?: string; from?: string; priorAsOf?: string; priorFrom?: string; ledger?: string | null }) {
    const def = await this.getDefinition(code);
    if (def.statement_type !== 'pl' && def.statement_type !== 'bs') {
      throw new BadRequestException({ code: 'FS_NOT_RENDERABLE', message: `render supports statement_type pl|bs (got ${def.statement_type})`, messageTh: 'รองรับเฉพาะงบกำไรขาดทุน/งบแสดงฐานะการเงิน' });
    }
    const ledger = params.ledger ?? null;
    if (!params.asOf) throw new BadRequestException({ code: 'FS_ASOF_REQUIRED', message: 'as_of (period end) is required', messageTh: 'ต้องระบุ as_of' });
    const isPl = def.statement_type === 'pl';
    if (isPl && !params.from) throw new BadRequestException({ code: 'FS_FROM_REQUIRED', message: 'from is required for a P&L', messageTh: 'ต้องระบุ from สำหรับงบกำไรขาดทุน' });

    // Presentation over the PRIMARY statement: the builder pulls the same numbers the canonical
    // income-statement / balance-sheet read (no source exclusion) so a rendered subtotal always ties to it.
    let cur = await this.ledger.perAccountNet(params.asOf, isPl ? params.from : null, ledger) as NetRow[];
    let prior: NetRow[] | null = null;
    let comparative = false;
    if (params.priorAsOf) {
      comparative = true;
      prior = await this.ledger.perAccountNet(params.priorAsOf, isPl ? (params.priorFrom ?? null) : null, ledger) as NetRow[];
    }
    // Enrich each row with its own statement-section binding + parent (P3): a sub-account (own is_group/
    // bs_group set, or inherited from its canonical parent) then rolls into the correct statutory line
    // instead of the type fallback — so an industry chart's WIP-by-phase / COGS-by-element groups correctly.
    const codes = [...new Set([...cur, ...(prior ?? [])].map((r) => r.account_code))];
    if (codes.length) {
      const metaRows = await this.db.select({ code: accounts.code, bs: accounts.bsGroup, is: accounts.isGroup, parent: accounts.parentCode })
        .from(accounts).where(inArray(accounts.code, codes));
      const metaMap = new Map(metaRows.map((m: any) => [m.code, m]));
      const enrich = (rows: NetRow[]) => rows.map((r) => { const m = metaMap.get(r.account_code); return m ? { ...r, bs_group: m.bs, is_group: m.is, parent_code: m.parent } : r; });
      cur = enrich(cur);
      if (prior) prior = enrich(prior);
    }
    const groups = (def.config as FsBuilderConfig).groups ?? [];
    const built = this.buildGroups(groups, cur, prior);
    return {
      code: def.code, name: def.name, statement_type: def.statement_type, ledger: ledger ?? 'LEADING',
      as_of: params.asOf, from: isPl ? params.from : null,
      comparative, prior_as_of: params.priorAsOf ?? null, prior_from: isPl ? (params.priorFrom ?? null) : null,
      rows: built,
    };
  }

  // Membership + signed display amount for a selecting group.
  private groupAmount(g: FsGroup, rows: NetRow[]): number {
    const sign = g.normalSide === 'credit' ? -1 : 1;
    let sum = 0;
    for (const r of rows) {
      if (this.matches(g, r)) sum += sign * r.net;
    }
    return round2(sum);
  }
  private matches(g: FsGroup, r: NetRow): boolean {
    if (g.accounts && g.accounts.includes(r.account_code)) return true;
    if (g.prefixes && g.prefixes.some((p) => r.account_code.startsWith(p))) return true;
    if (g.types && r.account_type && g.types.includes(r.account_type)) return true;
    // Select by the account's RESOLVED statement section (canonical default map / type fallback) so a
    // layout can bind whole งบดุล / งบกำไรขาดทุน sections without enumerating every code — the same
    // classification the quick balanceSheet/incomeStatement use, so the rendered subtotals tie to them.
    if (g.bsGroups || g.isGroups) {
      const a = { code: r.account_code, type: r.account_type ?? '', bsGroup: r.bs_group, isGroup: r.is_group, parentCode: r.parent_code };
      if (g.bsGroups) { const bs = resolveBsGroup(a); if (bs && g.bsGroups.includes(bs)) return true; }
      if (g.isGroups) { const is = resolveIsGroup(a); if (is && g.isGroups.includes(is)) return true; }
    }
    return false;
  }
  private accountRows(g: FsGroup, rows: NetRow[], priorRows: NetRow[] | null): any[] {
    const sign = g.normalSide === 'credit' ? -1 : 1;
    const priorMap = new Map((priorRows ?? []).map((r) => [r.account_code, r.net]));
    return rows.filter((r) => this.matches(g, r)).map((r) => ({
      account_code: r.account_code, account_name: r.account_name,
      current: round2(sign * r.net),
      ...(priorRows ? { prior: round2(sign * (priorMap.get(r.account_code) ?? 0)) } : {}),
      is_account: true,
    }));
  }
  private buildGroups(groups: FsGroup[], cur: NetRow[], prior: NetRow[] | null): any[] {
    const curVals: Record<string, number> = {};
    const priorVals: Record<string, number> = {};
    // First pass: selecting groups.
    for (const g of groups) {
      if (g.sumOf) continue;
      curVals[g.key] = this.groupAmount(g, cur);
      priorVals[g.key] = prior ? this.groupAmount(g, prior) : 0;
    }
    // Second pass: computed subtotals (reference already-computed keys; single level of dependency).
    for (const g of groups) {
      if (!g.sumOf) continue;
      curVals[g.key] = round2(g.sumOf.reduce((a, s) => a + s.factor * (curVals[s.key] ?? 0), 0));
      priorVals[g.key] = round2(g.sumOf.reduce((a, s) => a + s.factor * (priorVals[s.key] ?? 0), 0));
    }
    const out: any[] = [];
    for (const g of groups) {
      if (g.showAccounts && !g.sumOf) {
        for (const ar of this.accountRows(g, cur, prior)) out.push({ ...ar, level: (g.level ?? 0) + 1, key: `${g.key}:${ar.account_code}` });
      }
      out.push({
        key: g.key, label: g.label, label_th: g.labelTh ?? null, level: g.level ?? 0,
        is_subtotal: !!g.sumOf,
        current: curVals[g.key] ?? 0,
        ...(prior ? { prior: priorVals[g.key] ?? 0 } : {}),
      });
    }
    return out;
  }

  // ───────────────────── Statement of changes in equity (SOCE) ─────────────────────
  // Roll-forward per equity component: opening + own-period movements (direct equity postings, e.g. share
  // issues +, dividends −) + profit for the period (allocated to retained earnings) = closing. The current
  // unclosed-year result sits in Revenue/Expense until closeYear sweeps it to 3100, so it is surfaced here as
  // "profit for the period" against the retained-earnings component (never double-counted). Ties to the
  // balance sheet: Σ closing == balanceSheet(to).equity + balanceSheet(to).net_income.
  async statementOfChangesInEquity(params: { from: string; to: string; ledger?: string | null }) {
    const { from, to } = params;
    const ledger = params.ledger ?? null;
    if (!from || !to) throw new BadRequestException({ code: 'FS_RANGE_REQUIRED', message: 'from and to are required', messageTh: 'ต้องระบุ from และ to' });
    const before = dayBefore(from);
    const openingRows = await this.ledger.perAccountNet(before, null, ledger);
    const movementRows = await this.ledger.perAccountNet(to, from, ledger, ['CLOSE']);
    const is = await this.ledger.incomeStatement(from, to, undefined, ledger, ['CLOSE']);
    const profit = round2(is.net_income);

    const creditPos = (rows: NetRow[], code: string) => { const r = rows.find((x) => x.account_code === code); return r ? -r.net : 0; };
    const nameOf = (code: string) => {
      const r = openingRows.find((x) => x.account_code === code) ?? movementRows.find((x) => x.account_code === code);
      return r?.account_name ?? code;
    };
    const codes = new Set<string>();
    for (const r of [...openingRows, ...movementRows]) if (r.account_type === 'Equity') codes.add(r.account_code);
    codes.add(RETAINED_EARNINGS);

    const components = [...codes].sort().map((code) => {
      const opening = round2(creditPos(openingRows, code));
      const movement = round2(creditPos(movementRows, code));
      const profitAlloc = code === RETAINED_EARNINGS ? profit : 0;
      const closing = round2(opening + movement + profitAlloc);
      return { account_code: code, account_name: nameOf(code), opening, movements: movement, profit: profitAlloc, closing };
    });
    const totals = components.reduce((a, c) => ({
      opening: round2(a.opening + c.opening), movements: round2(a.movements + c.movements),
      profit: round2(a.profit + c.profit), closing: round2(a.closing + c.closing),
    }), { opening: 0, movements: 0, profit: 0, closing: 0 });

    const bs = await this.ledger.balanceSheet(to, ledger);
    const bsEquity = round2(bs.equity + bs.net_income);
    return {
      from, to, ledger: ledger ?? 'LEADING', retained_earnings_account: RETAINED_EARNINGS,
      profit_for_period: profit, components, totals,
      // Self-check that the roll-forward ties to the balance sheet's equity section (opening+moves+profit).
      ties_to_balance_sheet: Math.abs(totals.closing - bsEquity) < 0.01,
      balance_sheet_equity: bsEquity,
    };
  }

  // ───────────────────── Note schedules (per-note account mapping + comparative + policy text) ─────────────
  async noteSchedules(code: string, params: { asOf?: string; from?: string; priorAsOf?: string; priorFrom?: string; ledger?: string | null; basis?: 'bs' | 'pl' }) {
    const def = await this.getDefinition(code);
    if (def.statement_type !== 'notes') {
      throw new BadRequestException({ code: 'FS_NOT_NOTES', message: `statement_type must be 'notes' (got ${def.statement_type})`, messageTh: "ต้องเป็นประเภท 'notes'" });
    }
    const ledger = params.ledger ?? null;
    const basis = params.basis ?? 'bs';
    if (!params.asOf) throw new BadRequestException({ code: 'FS_ASOF_REQUIRED', message: 'as_of is required', messageTh: 'ต้องระบุ as_of' });
    const isPl = basis === 'pl';
    const cur = await this.ledger.perAccountNet(params.asOf, isPl ? (params.from ?? null) : null, ledger);
    let prior: NetRow[] | null = null;
    if (params.priorAsOf) prior = await this.ledger.perAccountNet(params.priorAsOf, isPl ? (params.priorFrom ?? null) : null, ledger);
    const priorMap = new Map((prior ?? []).map((r) => [r.account_code, r.net]));

    const defs = (def.config as FsNotesConfig).notes ?? [];
    const notes = defs.map((nd) => {
      const g: FsGroup = { key: nd.number, label: nd.title, normalSide: nd.normalSide, accounts: nd.accounts, prefixes: nd.prefixes, types: nd.types };
      const sign = nd.normalSide === 'credit' ? -1 : 1;
      const lines = cur.filter((r) => this.matches(g, r)).map((r) => {
        const current = round2(sign * r.net);
        const priorVal: number | null = prior ? round2(sign * (priorMap.get(r.account_code) ?? 0)) : null;
        return { account_code: r.account_code, account_name: r.account_name, current, prior: priorVal };
      });
      const total = round2(lines.reduce((a: number, l) => a + l.current, 0));
      const priorTotal: number | null = prior ? round2(lines.reduce((a: number, l) => a + (l.prior ?? 0), 0)) : null;
      return {
        number: nd.number, title: nd.title, title_th: nd.titleTh ?? null,
        policy_text: nd.policyText ?? null, policy_text_th: nd.policyTextTh ?? null,
        lines, total, prior_total: priorTotal,
      };
    });
    return { code: def.code, name: def.name, as_of: params.asOf, basis, comparative: !!prior, ledger: ledger ?? 'LEADING', notes };
  }

  // ───────────────────── DBD e-Filing export (Thai งบการเงิน — XBRL / S-form) ─────────────────────
  // The annual FS packaged for the Department of Business Development e-Filing: current + prior year, the
  // standard S-form concepts (assets/liabilities/equity/revenue/expenses/net profit), emitted as structured
  // facts + a minimal XBRL instance. Reads the primary statements (balanceSheet / incomeStatement) — a pure
  // presentation over the audited GL, so it always ties (Assets == Liabilities + Equity, incl. net profit).
  async dbdExport(params: { fiscalYear: number; ledger?: string | null; taxpayerName?: string; taxpayerId?: string }) {
    const fy = params.fiscalYear;
    if (!fy || fy < 2000 || fy > 3000) throw new BadRequestException({ code: 'FS_BAD_FISCAL_YEAR', message: 'fiscal_year required (YYYY)', messageTh: 'ต้องระบุปีบัญชี (พ.ศ./ค.ศ.)' });
    const ledger = params.ledger ?? null;
    const yStart = `${fy}-01-01`, yEnd = `${fy}-12-31`;
    const pStart = `${fy - 1}-01-01`, pEnd = `${fy - 1}-12-31`;
    const bsC = await this.ledger.balanceSheet(yEnd, ledger);
    const bsP = await this.ledger.balanceSheet(pEnd, ledger);
    const isC = await this.ledger.incomeStatement(yStart, yEnd, undefined, ledger, ['CLOSE']);
    const isP = await this.ledger.incomeStatement(pStart, pEnd, undefined, ledger, ['CLOSE']);

    // Post-result equity (as filed): equity incl. the year's net profit (retained earnings after close).
    const equityC = round2(bsC.equity + bsC.net_income);
    const equityP = round2(bsP.equity + bsP.net_income);
    const facts = [
      { concept: 'TotalAssets', label: 'สินทรัพย์รวม', context: 'instant', current: round2(bsC.assets), prior: round2(bsP.assets) },
      { concept: 'TotalLiabilities', label: 'หนี้สินรวม', context: 'instant', current: round2(bsC.liabilities), prior: round2(bsP.liabilities) },
      { concept: 'TotalEquity', label: 'ส่วนของผู้ถือหุ้นรวม', context: 'instant', current: equityC, prior: equityP },
      { concept: 'Revenue', label: 'รายได้รวม', context: 'duration', current: round2(isC.revenue), prior: round2(isP.revenue) },
      { concept: 'Expenses', label: 'ค่าใช้จ่ายรวม', context: 'duration', current: round2(isC.expense), prior: round2(isP.expense) },
      { concept: 'NetProfit', label: 'กำไร (ขาดทุน) สุทธิ', context: 'duration', current: round2(isC.net_income), prior: round2(isP.net_income) },
    ];
    const balanced = Math.abs(round2(bsC.assets) - round2(bsC.liabilities + equityC)) < 0.01;
    const taxpayer = params.taxpayerName ?? 'ผู้ประกอบการ';
    const taxpayerId = params.taxpayerId ?? '';
    const xml = this.buildXbrl(fy, taxpayer, taxpayerId, facts);
    return {
      format: 'DBD-XBRL', form: 'S-form', fiscal_year: fy, ledger: ledger ?? 'LEADING',
      taxpayer_name: taxpayer, taxpayer_id: taxpayerId,
      contexts: {
        current: { period: { start: yStart, end: yEnd }, instant: yEnd },
        prior: { period: { start: pStart, end: pEnd }, instant: pEnd },
      },
      facts, balanced, xml,
    };
  }

  private xmlEsc(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  private buildXbrl(fy: number, taxpayer: string, taxpayerId: string, facts: { concept: string; context: string; current: number; prior: number }[]): string {
    const lines: string[] = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push('<xbrl xmlns="http://www.xbrl.org/2003/instance" xmlns:dbd="http://www.dbd.go.th/xbrl/sform">');
    lines.push(`  <context id="CUR_INSTANT"><entity><identifier scheme="http://www.dbd.go.th">${this.xmlEsc(taxpayerId)}</identifier></entity><period><instant>${fy}-12-31</instant></period></context>`);
    lines.push(`  <context id="CUR_DURATION"><entity><identifier scheme="http://www.dbd.go.th">${this.xmlEsc(taxpayerId)}</identifier></entity><period><startDate>${fy}-01-01</startDate><endDate>${fy}-12-31</endDate></period></context>`);
    lines.push(`  <context id="PRIOR_INSTANT"><entity><identifier scheme="http://www.dbd.go.th">${this.xmlEsc(taxpayerId)}</identifier></entity><period><instant>${fy - 1}-12-31</instant></period></context>`);
    lines.push(`  <context id="PRIOR_DURATION"><entity><identifier scheme="http://www.dbd.go.th">${this.xmlEsc(taxpayerId)}</identifier></entity><period><startDate>${fy - 1}-01-01</startDate><endDate>${fy - 1}-12-31</endDate></period></context>`);
    lines.push('  <unit id="THB"><measure>iso4217:THB</measure></unit>');
    for (const f of facts) {
      const curCtx = f.context === 'instant' ? 'CUR_INSTANT' : 'CUR_DURATION';
      const priorCtx = f.context === 'instant' ? 'PRIOR_INSTANT' : 'PRIOR_DURATION';
      lines.push(`  <dbd:${f.concept} contextRef="${curCtx}" unitRef="THB" decimals="2">${f.current.toFixed(2)}</dbd:${f.concept}>`);
      lines.push(`  <dbd:${f.concept} contextRef="${priorCtx}" unitRef="THB" decimals="2">${f.prior.toFixed(2)}</dbd:${f.concept}>`);
    }
    lines.push('</xbrl>');
    return lines.join('\n');
  }
}
