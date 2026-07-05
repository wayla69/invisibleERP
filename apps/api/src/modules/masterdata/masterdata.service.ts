import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { MASTER_REGISTRY, findEntity, type MdEntity, type MdCol, type MdType } from './master-registry';

const HEADER_FILL = 'FF1E3A5F';
const HEADER_FONT = 'FFFFFFFF';

@Injectable()
export class MasterDataService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

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
      values.push(o);
    });

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
