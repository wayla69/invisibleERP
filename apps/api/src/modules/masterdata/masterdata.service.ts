import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { MASTER_REGISTRY, findEntity, type MdEntity, type MdType } from './master-registry';

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

  private entOrThrow(key: string): MdEntity {
    const e = findEntity(key);
    if (!e) throw new BadRequestException({ code: 'BAD_ENTITY', message: `Unknown entity: ${key}`, messageTh: 'ไม่รู้จักประเภทข้อมูลนี้' });
    return e;
  }

  // ── Export current rows as header-keyed objects ──────────────────────────
  async exportRows(key: string): Promise<{ headers: string[]; rows: any[] }> {
    const e = this.entOrThrow(key);
    const db = this.db as any;
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
        o[c.prop] = castIn(raw[c.header], c.type);
      }
      if (e.tenantScoped && 'tenantId' in e.table) o.tenantId = user.tenantId ?? null;
      if (e.key === 'assets') {
        o.netBookValue = fx(o.acquireCost ?? 0, 4); // NOT NULL, no GL here (bulk register load)
        if (o.status == null) o.status = 'active';
      }
      values.push(o);
    });

    const db = this.db as any;
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
        if (cell == null || String(cell).trim() === '') { o[c.prop] = null; continue; }
        const s = String(cell).trim();
        if (c.type === 'num' || c.type === 'int') {
          if (!Number.isFinite(Number(s))) { errors.push({ row: rowNo, column: c.header, code: 'BAD_NUMBER', message: `'${c.header}' must be a number (got "${s}")`, messageTh: `'${c.header}' ต้องเป็นตัวเลข` }); rowBad = true; continue; }
          o[c.prop] = c.type === 'int' ? Math.trunc(Number(s)) : fx(Number(s), 4);
        } else if (c.type === 'date') {
          const d = new Date(s);
          if (isNaN(d.getTime())) { errors.push({ row: rowNo, column: c.header, code: 'BAD_DATE', message: `'${c.header}' is not a valid date (got "${s}")`, messageTh: `'${c.header}' รูปแบบวันที่ไม่ถูกต้อง` }); rowBad = true; continue; }
          o[c.prop] = d.toISOString().slice(0, 10);
        } else if (c.type === 'bool') {
          o[c.prop] = ['1', 'true', 'yes', 'y', 't'].includes(s.toLowerCase());
        } else o[c.prop] = s;
      }
      const k = String(raw[keyHeader] ?? '').trim();
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
    const db = this.db as any;
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

function castIn(v: unknown, t: MdType): any {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).trim();
  if (t === 'num') return fx(Number(s), 4);
  if (t === 'int') return Math.trunc(Number(s));
  if (t === 'bool') return ['1', 'true', 'yes', 'y', 't'].includes(s.toLowerCase());
  if (t === 'date') {
    const d = new Date(s);
    return isNaN(d.getTime()) ? s.slice(0, 10) : d.toISOString().slice(0, 10);
  }
  return s;
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
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => {
      const o: Record<string, string> = {};
      headers.forEach((h, i) => (o[h] = (r[i] ?? '').trim()));
      return o;
    });
}
