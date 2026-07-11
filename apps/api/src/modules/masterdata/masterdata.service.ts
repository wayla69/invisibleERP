import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { and, eq, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { masterdataImportBatches } from '../../database/schema';
import { fx } from '../../database/queries';
import { DocNumberService } from '../../common/doc-number.service';
import type { JwtUser } from '../../common/decorators';
import { MASTER_REGISTRY, findEntity, type MdEntity, type MdCol, type MdType } from './master-registry';
import { Optional } from '@nestjs/common';
import { PostingService } from '../ledger/posting.service';

const HEADER_FILL = 'FF1E3A5F';
const HEADER_FONT = 'FFFFFFFF';

@Injectable()
export class MasterDataService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    // docs/43 PR-8: a posting_rules import routes EVERY row through the GL-24 pipeline (validate
    // fail-closed → PendingApproval → distinct approver). @Optional so hand-constructed harness
    // instances still build; without it the posting_rules import is refused (fail-closed).
    @Optional() private readonly posting?: PostingService,
  ) {}

  // GL-11: canonical chart-of-accounts bulk IO is platform-Admin only (the universe is shared).
  private assertAccountsImportAllowed(e: MdEntity, user: JwtUser) {
    if (e.key === 'accounts' && user.role !== 'Admin') {
      throw new ForbiddenException({
        code: 'COA_ADMIN_ONLY',
        message: 'Canonical Chart-of-Accounts bulk import is restricted to the platform administrator (HQ)',
        messageTh: 'การนำเข้าผังบัญชีกลางสงวนไว้สำหรับผู้ดูแลระบบ (สำนักงานใหญ่) เท่านั้น',
      });
    }
  }

  // docs/43 PR-8: posting_rules rows NEVER hit the table directly — each row goes through
  // PostingService.upsertRule (GL-24: registry/tier/side/account validation fail-closed; lands
  // PendingApproval; audited; cache-busted). Returns per-row errors; honors skipErrors.
  private async importPostingRules(rows: Record<string, any>[], user: JwtUser, skipErrors: boolean) {
    if (!this.posting) throw new BadRequestException({ code: 'POSTING_RULES_IO_UNAVAILABLE', message: 'Posting-rule import unavailable', messageTh: 'ระบบนำเข้ากฎการลงบัญชีไม่พร้อมใช้งาน' });
    const errors: ImportError[] = [];
    let imported = 0;
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i]!;
      const dto = {
        eventType: String(raw['Event_Type'] ?? '').trim(),
        legOrder: Math.trunc(Number(raw['Leg_Order'] ?? 1)) || 1,
        role: String(raw['Role'] ?? '').trim(),
        side: String(raw['Side'] ?? '').trim().toUpperCase() as 'DR' | 'CR',
        accountCode: String(raw['Account_Code'] ?? '').trim(),
      };
      try {
        await this.posting.upsertRule(dto, user);
        imported++;
      } catch (err: any) {
        const body = err?.response ?? {};
        errors.push({ row: i + 1, code: body.code ?? 'RULE_INVALID', message: body.message ?? String(err?.message ?? err), messageTh: body.messageTh });
        if (!skipErrors) {
          return { entity: 'posting_rules', mode: 'append' as const, status: 'invalid' as const, total: rows.length, imported: 0, skipped: rows.length, errors,
            message: 'Import aborted on the first invalid rule (no rules written); fix the file or re-run with skip_errors' };
        }
      }
    }
    return {
      entity: 'posting_rules', mode: 'append' as const, status: 'PendingApproval' as const, pending: true,
      total: rows.length, imported, skipped: rows.length - imported, errors,
      message: `ทุกกฎที่นำเข้า (${imported}) รอการอนุมัติจากผู้ใช้อื่นตาม GL-24 — a DIFFERENT user must approve each imported rule before it takes effect`,
    };
  }

  // Financially-sensitive headers (audit G5/G7/G8) actually SET by this batch — a non-empty value in any row
  // for a column flagged `sensitive` in the registry. If any are touched, the import is staged for approval.
  private sensitiveTouched(e: MdEntity, rows: Record<string, any>[]): string[] {
    const sens = e.cols.filter((c) => c.sensitive).map((c) => c.header);
    if (!sens.length) return [];
    const hit = new Set<string>();
    for (const raw of rows) for (const h of sens) { const v = raw[h]; if (v != null && String(v).trim() !== '') hit.add(h); }
    return sens.filter((h) => hit.has(h));
  }

  // Stage a sensitive import batch (maker; NO write to the entity table until a distinct user approves it).
  private async stageImportBatch(e: MdEntity, mode: 'append' | 'replace', rows: Record<string, any>[], user: JwtUser, sensitiveFields: string[]) {
    const reqNo = await this.docNo.nextDaily('MDI');
    await this.db.insert(masterdataImportBatches).values({
      tenantId: user.tenantId ?? null, reqNo, entityKey: e.key, mode, rows: JSON.stringify(rows),
      rowCount: rows.length, sensitiveFields: sensitiveFields.join(','), status: 'PendingApproval', requestedBy: user.username,
    });
    return {
      entity: e.key, mode, status: 'PendingApproval' as const, pending: true, req_no: reqNo,
      sensitive_fields: sensitiveFields, row_count: rows.length,
      message: `Import sets financially-sensitive field(s) [${sensitiveFields.join(', ')}] — staged for independent approval`,
    };
  }

  entities() {
    return {
      entities: MASTER_REGISTRY.map((e) => ({
        key: e.key, label_en: e.labelEn, label_th: e.labelTh,
        required: e.required, columns: e.cols.map((c) => c.header), allow_replace: e.allowReplace,
      })),
    };
  }

  // Resolve the header-keyed import rows from whichever body shape the client sent: pre-parsed `rows`, raw
  // `csv` text, or a base64-encoded `.xlsx` workbook (so a user can round-trip the exact template/export
  // file without a Save-As-CSV step). All three converge on the same validate/import pipeline below.
  async rowsFromInput(input: { format?: 'rows' | 'csv' | 'xlsx'; csv?: string; xlsx?: string; rows?: Record<string, any>[] }): Promise<Record<string, any>[]> {
    if (input.format === 'xlsx') return parseXlsx(Buffer.from(input.xlsx ?? '', 'base64'));
    if (input.format === 'csv') return parseCsv(input.csv ?? '');
    return input.rows ?? [];
  }

  private entOrThrow(key: string): MdEntity {
    const e = findEntity(key);
    if (!e) throw new BadRequestException({ code: 'BAD_ENTITY', message: `Unknown entity: ${key}`, messageTh: 'ไม่รู้จักประเภทข้อมูลนี้' });
    return e;
  }

  // ── Export current rows as header-keyed objects ──────────────────────────
  async exportRows(key: string): Promise<{ headers: string[]; rows: any[] }> {
    const e = this.entOrThrow(key);
    const db = this.db;
    const data = await db.select().from(e.table);
    const headers = e.cols.map((c) => c.header);
    const rows = data.map((r: any) => {
      const o: Record<string, any> = {};
      for (const c of e.cols) o[c.header] = castOut(r[c.prop], c.type);
      return o;
    });
    return { headers, rows };
  }

  async exportCsv(key: string): Promise<string> {
    const { headers, rows } = await this.exportRows(key);
    const esc = (v: any) => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
    return '﻿' + lines.join('\r\n') + '\r\n'; // BOM for Excel/Thai
  }

  async exportXlsx(key: string): Promise<Buffer> {
    const e = this.entOrThrow(key);
    const { headers, rows } = await this.exportRows(key);
    return this.buildXlsx(e, headers, rows);
  }

  async templateXlsx(key: string): Promise<Buffer> {
    const e = this.entOrThrow(key);
    return this.buildXlsx(e, e.cols.map((c) => c.header), []);
  }

  private async buildXlsx(e: MdEntity, headers: string[], rows: any[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Invisible ERP';
    const ws = wb.addWorksheet(e.labelEn.slice(0, 28).replace(/[\\/?*[\]]/g, '-'));
    ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.min(Math.max(h.length + 4, 12), 40) }));
    for (const r of rows) ws.addRow(r);
    const req = new Set(e.required);
    ws.getRow(1).eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: req.has(String(cell.value)) ? HEADER_FILL : 'FF0D9488' } };
      cell.font = { color: { argb: HEADER_FONT }, bold: true };
      cell.alignment = { horizontal: 'center', wrapText: true };
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  // ── Import (append = onConflictDoNothing, replace = wipe-then-insert) ─────
  async importRows(key: string, mode: 'append' | 'replace', rows: Record<string, any>[], user: JwtUser) {
    const e = this.entOrThrow(key);
    if (mode === 'replace' && !e.allowReplace) {
      throw new BadRequestException({ code: 'REPLACE_FORBIDDEN', message: `Replace not allowed for ${key}`, messageTh: 'ไม่อนุญาตให้แทนที่ทั้งหมดสำหรับข้อมูลนี้' });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException({ code: 'NO_ROWS', message: 'No rows to import', messageTh: 'ไม่มีข้อมูลให้นำเข้า' });
    }
    const provided = new Set(Object.keys(rows[0] ?? {}));
    const missing = e.required.filter((h) => !provided.has(h));
    if (missing.length) {
      throw new BadRequestException({ code: 'MISSING_COLUMNS', message: `Missing required columns: ${missing.join(', ')}`, messageTh: `ขาดคอลัมน์ที่จำเป็น: ${missing.join(', ')}` });
    }

    // Build & validate insert payloads before touching the DB.
    const values: any[] = [];
    rows.forEach((raw, i) => {
      for (const h of e.required) {
        const v = raw[h];
        if (v == null || String(v).trim() === '') {
          throw new BadRequestException({ code: 'REQUIRED_EMPTY', message: `Row ${i + 1}: '${h}' is required`, messageTh: `แถวที่ ${i + 1}: ต้องระบุ '${h}'` });
        }
      }
      const o: Record<string, any> = {};
      for (const c of e.cols) {
        if (raw[c.header] === undefined) continue;
        const r = coerceCell(c, raw[c.header]);
        if (!r.ok) throw new BadRequestException({ code: r.code, message: `Row ${i + 1}: ${r.message}`, messageTh: `แถวที่ ${i + 1}: ${r.messageTh}` });
        o[c.prop] = r.value;
      }
      if (e.tenantScoped && 'tenantId' in e.table) o.tenantId = user.tenantId ?? null;
      if (e.key === 'assets') {
        o.netBookValue = fx(o.acquireCost ?? 0, 4); // NOT NULL, no GL here (bulk register load)
        if (o.status == null) o.status = 'active';
      }
      if (e.key === 'accounts') {
        // pgEnum casing + defaults (GL-11): Type normalized Asset/Liability/Equity/Revenue/Expense;
        // normal balance defaults by type like the COA manage API.
        const t = String(o.type ?? '').trim();
        const match = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'].find((x) => x.toLowerCase() === t.toLowerCase());
        if (!match) throw new BadRequestException({ code: 'BAD_ENUM', message: `Row ${i + 1}: 'Type' must be one of Asset/Liability/Equity/Revenue/Expense (got "${t}")`, messageTh: `แถวที่ ${i + 1}: ประเภทบัญชีไม่ถูกต้อง` });
        o.type = match;
        if (o.normalBalance == null) o.normalBalance = ['Liability', 'Equity', 'Revenue'].includes(match) ? 'C' : 'D';
      }
      values.push(o);
    });

    this.assertAccountsImportAllowed(e, user);
    if (e.key === 'posting_rules') return this.importPostingRules(rows, user, false);
    // Maker-checker (audit G5/G7/G8): a batch that sets a financially-sensitive field is staged for approval.
    const sensitive = this.sensitiveTouched(e, rows);
    if (sensitive.length) return this.stageImportBatch(e, mode, rows, user, sensitive);

    const db = this.db;
    let count = 0;
    await db.transaction(async (tx: any) => {
      if (mode === 'replace') await tx.delete(e.table); // RLS scopes tenant tables to caller
      for (const v of values) {
        if (mode === 'replace') await tx.insert(e.table).values(v);
        else await tx.insert(e.table).values(v).onConflictDoNothing();
        count++;
      }
    });
    return { entity: key, mode, imported: count };
  }

  // ── Validated import (Phase 7): dry-run preview + per-row error reporting ───
  // Validates every row (required, type-coercion, in-file duplicate) and accumulates errors instead of
  // throwing on the first one. `validateReport` is a pure dry-run; `importChecked` commits (optionally
  // skipping bad rows) and reports already-existing rows it skipped.
  private validateCore(e: MdEntity, mode: 'append' | 'replace', rows: Record<string, any>[], user: JwtUser) {
    const errors: ImportError[] = [];
    const prepared: { rowNo: number; value: any }[] = [];
    if (mode === 'replace' && !e.allowReplace) errors.push({ row: 0, code: 'REPLACE_FORBIDDEN', message: `Replace not allowed for ${e.key}`, messageTh: 'ไม่อนุญาตให้แทนที่ทั้งหมดสำหรับข้อมูลนี้' });
    if (!Array.isArray(rows) || rows.length === 0) {
      errors.push({ row: 0, code: 'NO_ROWS', message: 'No rows to import', messageTh: 'ไม่มีข้อมูลให้นำเข้า' });
      return { total: 0, valid: 0, invalid: 0, errors, prepared };
    }
    const provided = new Set(Object.keys(rows[0] ?? {}));
    const missing = e.required.filter((h) => !provided.has(h));
    if (missing.length) errors.push({ row: 0, code: 'MISSING_COLUMNS', message: `Missing required columns: ${missing.join(', ')}`, messageTh: `ขาดคอลัมน์ที่จำเป็น: ${missing.join(', ')}` });

    const keyHeader = e.required[0];
    const seen = new Map<string, number>();
    const badRows = new Set<number>();
    rows.forEach((raw, i) => {
      const rowNo = i + 1;
      if (missing.length) { badRows.add(rowNo); return; } // can't validate rows without their key columns
      let rowBad = false;
      for (const h of e.required) {
        const v = raw[h];
        if (v == null || String(v).trim() === '') { errors.push({ row: rowNo, column: h, code: 'REQUIRED_EMPTY', message: `'${h}' is required`, messageTh: `ต้องระบุ '${h}'` }); rowBad = true; }
      }
      const o: Record<string, any> = {};
      for (const c of e.cols) {
        const cell = raw[c.header];
        if (cell === undefined) continue;
        const r = coerceCell(c, cell);
        if (!r.ok) { errors.push({ row: rowNo, column: c.header, code: r.code, message: r.message, messageTh: r.messageTh }); rowBad = true; continue; }
        o[c.prop] = r.value;
      }
      const k = String(raw[keyHeader!] ?? '').trim();
      if (k) {
        if (seen.has(k)) { errors.push({ row: rowNo, column: keyHeader, code: 'DUP_IN_FILE', message: `Duplicate ${keyHeader} "${k}" (first seen at row ${seen.get(k)})`, messageTh: `${keyHeader} ซ้ำในไฟล์` }); rowBad = true; }
        else seen.set(k, rowNo);
      }
      if (e.tenantScoped && 'tenantId' in e.table) o.tenantId = user.tenantId ?? null;
      if (e.key === 'assets') { o.netBookValue = fx(o.acquireCost ?? 0, 4); if (o.status == null) o.status = 'active'; }
      if (e.key === 'accounts') {
        const t = String(o.type ?? '').trim();
        const match = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'].find((x) => x.toLowerCase() === t.toLowerCase());
        if (!match) { errors.push({ row: rowNo, column: 'Type', code: 'BAD_ENUM', message: `'Type' must be one of Asset/Liability/Equity/Revenue/Expense (got "${t}")`, messageTh: 'ประเภทบัญชีไม่ถูกต้อง' }); rowBad = true; }
        else { o.type = match; if (o.normalBalance == null) o.normalBalance = ['Liability', 'Equity', 'Revenue'].includes(match) ? 'C' : 'D'; }
      }
      if (rowBad) badRows.add(rowNo); else prepared.push({ rowNo, value: o });
    });
    const invalid = badRows.size;
    return { total: rows.length, valid: rows.length - invalid, invalid, errors, prepared };
  }

  validateReport(key: string, mode: 'append' | 'replace', rows: Record<string, any>[], user: JwtUser) {
    const e = this.entOrThrow(key);
    const v = this.validateCore(e, mode, rows, user);
    return { entity: key, mode, total: v.total, valid: v.valid, invalid: v.invalid, errors: v.errors };
  }

  async importChecked(key: string, mode: 'append' | 'replace', rows: Record<string, any>[], user: JwtUser, skipErrors: boolean) {
    const e = this.entOrThrow(key);
    this.assertAccountsImportAllowed(e, user);
    if (e.key === 'posting_rules') return this.importPostingRules(rows, user, skipErrors);
    // Maker-checker (audit G5/G7/G8): if the batch sets a financially-sensitive field, validate it (so a
    // broken batch is rejected up-front, not staged) then STAGE it for a distinct approver instead of committing.
    const sensitive = this.sensitiveTouched(e, rows);
    if (sensitive.length) {
      const v = this.validateCore(e, mode, rows, user);
      const blocking = v.errors.some((x) => x.row === 0);
      if (blocking || (v.invalid > 0 && !skipErrors)) {
        return { entity: key, mode, status: 'invalid' as const, total: v.total, imported: 0, skipped: v.total, errors: v.errors };
      }
      return this.stageImportBatch(e, mode, rows, user, sensitive);
    }
    return this.commitChecked(e, mode, rows, user, skipErrors);
  }

  // The actual validated commit (shared by the non-sensitive importChecked path and an APPROVED staged batch).
  private async commitChecked(e: MdEntity, mode: 'append' | 'replace', rows: Record<string, any>[], user: JwtUser, skipErrors: boolean) {
    const key = e.key;
    const v = this.validateCore(e, mode, rows, user);
    const blocking = v.errors.some((x) => x.row === 0); // entity/columns/replace problems can't be skipped
    if (blocking || (v.invalid > 0 && !skipErrors)) {
      return { entity: key, mode, status: 'invalid' as const, total: v.total, imported: 0, skipped: v.total, errors: v.errors };
    }
    const db = this.db;
    let imported = 0;
    const extra: ImportError[] = [];
    await db.transaction(async (tx: any) => {
      if (mode === 'replace') await tx.delete(e.table); // RLS scopes tenant tables to caller
      for (const p of v.prepared) {
        if (mode === 'replace') { await tx.insert(e.table).values(p.value); imported++; }
        else {
          const ins = await tx.insert(e.table).values(p.value).onConflictDoNothing().returning();
          if (ins.length) imported++;
          else extra.push({ row: p.rowNo, column: e.required[0], code: 'EXISTS', message: 'already exists — skipped', messageTh: 'มีอยู่แล้ว — ข้ามไป' });
        }
      }
    });
    const allErrors = [...v.errors, ...extra];
    const status: 'partial' | 'success' = allErrors.length ? 'partial' : 'success';
    return { entity: key, mode, status, total: v.total, imported, skipped: v.total - imported, errors: allErrors };
  }

  // ── Sensitive-import maker-checker: queue / approve / reject (audit G5/G7/G8) ──
  async listPendingBatches(status?: string) {
    const rows = await this.db.select().from(masterdataImportBatches)
      .where(status ? eq(masterdataImportBatches.status, status) : eq(masterdataImportBatches.status, 'PendingApproval'))
      .orderBy(desc(masterdataImportBatches.id)).limit(200);
    return {
      batches: rows.map((r: any) => ({
        req_no: r.reqNo, entity: r.entityKey, mode: r.mode, row_count: r.rowCount,
        sensitive_fields: (r.sensitiveFields ?? '').split(',').filter(Boolean), status: r.status,
        requested_by: r.requestedBy, requested_at: r.requestedAt, approved_by: r.approvedBy, approved_at: r.approvedAt, reject_reason: r.rejectReason,
      })),
      count: rows.length,
    };
  }

  private async pendingBatch(reqNo: string) {
    const [b] = await this.db.select().from(masterdataImportBatches).where(and(eq(masterdataImportBatches.reqNo, reqNo), eq(masterdataImportBatches.status, 'PendingApproval'))).limit(1);
    if (!b) throw new NotFoundException({ code: 'NOT_PENDING', message: `No import batch pending approval for ${reqNo}`, messageTh: 'ไม่มีชุดข้อมูลนำเข้าที่รออนุมัติ' });
    return b;
  }

  // Approve a staged sensitive import — a DIFFERENT user than the requester (self-approval → 403 SOD_VIOLATION)
  // commits it. The rows are re-applied in the requesting user's tenant context so they land in the right tenant.
  async approveBatch(reqNo: string, user: JwtUser) {
    const b = await this.pendingBatch(reqNo);
    if (b.requestedBy && b.requestedBy === user.username) throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve an import you requested', messageTh: 'ผู้ขอนำเข้าอนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)' });
    const e = this.entOrThrow(b.entityKey);
    const rows = JSON.parse(b.rows) as Record<string, any>[];
    const asRequester = { username: b.requestedBy ?? user.username, tenantId: b.tenantId ?? null } as JwtUser;
    const result = await this.commitChecked(e, b.mode as 'append' | 'replace', rows, asRequester, true);
    await this.db.update(masterdataImportBatches).set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date(), result: JSON.stringify(result) }).where(eq(masterdataImportBatches.id, Number(b.id)));
    return { req_no: reqNo, status: 'Approved' as const, approved_by: user.username, requested_by: b.requestedBy, entity: e.key, mode: b.mode, result };
  }

  async rejectBatch(reqNo: string, user: JwtUser, reason?: string) {
    const b = await this.pendingBatch(reqNo);
    await this.db.update(masterdataImportBatches).set({ status: 'Rejected', approvedBy: user.username, approvedAt: new Date(), rejectReason: reason ?? null }).where(eq(masterdataImportBatches.id, Number(b.id)));
    return { req_no: reqNo, status: 'Rejected', rejected_by: user.username };
  }
}

export interface ImportError { row: number; column?: string; code: string; message: string; messageTh: string }

function castOut(v: unknown, t: MdType): any {
  if (v == null) return '';
  if (t === 'num') return Number(v);
  if (t === 'int') return parseInt(String(v), 10);
  if (t === 'bool') return v === true || v === 't' || v === 'true' || v === 1 || v === '1';
  return String(v);
}

type CoerceOk = { ok: true; value: any };
type CoerceErr = { ok: false; code: string; message: string; messageTh: string };
// Single source of truth for turning one import cell into a typed insert value. Honors `def` (blank cell →
// column default, so a NOT-NULL column isn't handed an explicit null) and `enumVals` (case-insensitive
// match, stored lower-cased). Used by both the validated path (accumulates errors) and the plain path (throws).
function coerceCell(c: MdCol, cell: unknown): CoerceOk | CoerceErr {
  if (cell == null || String(cell).trim() === '') return { ok: true, value: c.def !== undefined ? c.def : null };
  const s = String(cell).trim();
  if (c.enumVals) {
    const v = s.toLowerCase();
    if (!c.enumVals.includes(v)) return { ok: false, code: 'BAD_ENUM', message: `'${c.header}' must be one of ${c.enumVals.join(' / ')} (got "${s}")`, messageTh: `'${c.header}' ต้องเป็นค่า ${c.enumVals.join(' / ')}` };
    return { ok: true, value: v };
  }
  if (c.type === 'num' || c.type === 'int') {
    if (!Number.isFinite(Number(s))) return { ok: false, code: 'BAD_NUMBER', message: `'${c.header}' must be a number (got "${s}")`, messageTh: `'${c.header}' ต้องเป็นตัวเลข` };
    return { ok: true, value: c.type === 'int' ? Math.trunc(Number(s)) : fx(Number(s), 4) };
  }
  if (c.type === 'date') {
    const d = new Date(s);
    if (isNaN(d.getTime())) return { ok: false, code: 'BAD_DATE', message: `'${c.header}' is not a valid date (got "${s}")`, messageTh: `'${c.header}' รูปแบบวันที่ไม่ถูกต้อง` };
    return { ok: true, value: d.toISOString().slice(0, 10) };
  }
  if (c.type === 'bool') return { ok: true, value: ['1', 'true', 'yes', 'y', 't'].includes(s.toLowerCase()) };
  return { ok: true, value: s };
}

// Flatten one ExcelJS cell value to a trimmed string, mirroring how `parseCsv` yields plain strings (the
// import coercer re-types from there). Handles the shapes ExcelJS emits: primitives, Date, formula
// ({ result }), hyperlink ({ text }), and rich text ({ richText:[…] }).
function xlsxCellText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const o = v as Record<string, any>;
    if ('text' in o) return String(o.text ?? '');
    if ('result' in o) return String(o.result ?? '');
    if (Array.isArray(o.richText)) return o.richText.map((t: any) => t.text).join('');
    return '';
  }
  return String(v);
}

// Parse a `.xlsx` workbook (first worksheet) into header-keyed rows, matching `parseCsv`'s output so both
// import formats share the downstream pipeline. Row 1 is the header; blank rows are dropped. Columns are read
// by position (not eachCell) so an empty middle cell doesn't shift later values onto the wrong header.
export async function parseXlsx(buf: Buffer): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook();
  // exceljs's bundled @types/node types `load(buffer: Buffer<ArrayBuffer>)`, while ours is the newer generic
  // `Buffer<ArrayBufferLike>` — cast to exceljs's exact declared param type to bridge the cross-package
  // generic mismatch (no `any`, so it stays clear of the ts-debt ratchet).
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers: string[] = []; // 1-based to align with ExcelJS column numbers
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { headers[col] = xlsxCellText(cell.value).trim(); });
  const out: Record<string, string>[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const o: Record<string, string> = {};
    let any = false;
    for (let c = 1; c < headers.length; c++) {
      const h = headers[c];
      if (!h) continue;
      const val = xlsxCellText(row.getCell(c).value).trim();
      o[h] = val;
      if (val !== '') any = true;
    }
    if (any) out.push(o);
  }
  return out;
}

// Minimal RFC4180-ish CSV parser (handles quotes, commas, CRLF). Returns header-keyed rows.
export function parseCsv(text: string): Record<string, string>[] {
  const t = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQ) {
      if (ch === '"') {
        if (t[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch === '\r') { /* skip */ }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0]!.map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => {
      const o: Record<string, string> = {};
      headers.forEach((h, i) => (o[h] = (r[i] ?? '').trim()));
      return o;
    });
}
