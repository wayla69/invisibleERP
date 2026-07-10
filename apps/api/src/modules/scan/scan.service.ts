import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, desc, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { scanSessions, scanLines, stockMovements, items, fixedAssets } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { parseQrPayload } from '@ierp/shared';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// Mobile scan sessions: open → scan lines (parse QR) → close (commit to stock_movements).
const MOVE: Record<string, string> = { GR: 'GR', Issue: 'Issue', Transfer: 'Transfer', Count: 'Stock In', Stocktake: 'Stock In', CycleCount: 'Stock In' };

@Injectable()
export class ScanService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService) {}

  async open(dto: { session_type: string; location_id?: string; doc_ref?: string }, user: JwtUser) {
    const db = this.db;
    const sessionNo = this.docNo.nextStamped('SCAN');
    await db.insert(scanSessions).values({ sessionNo, sessionType: dto.session_type, locationId: dto.location_id ?? null, docRef: dto.doc_ref ?? null, status: 'Open', createdBy: user.username, createdAt: new Date() });
    return { session_no: sessionNo, session_type: dto.session_type, status: 'Open' };
  }

  async addLine(sessionNo: string, dto: { qr_data: string; qty?: number; action?: string; lot_no?: string; client_uuid?: string }) {
    const db = this.db;
    const [s] = await db.select().from(scanSessions).where(eq(scanSessions.sessionNo, sessionNo)).limit(1);
    if (!s) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Session not found', messageTh: 'ไม่พบเซสชัน' });
    if (s.status !== 'Open') throw new BadRequestException({ code: 'SESSION_CLOSED', message: 'Session is closed', messageTh: 'เซสชันถูกปิดแล้ว' });
    const p = parseQrPayload(dto.qr_data);
    const itemId = p.ITEM_ID || p.ASSET_ID || dto.qr_data.trim();
    // Offline replay guard: a line already recorded for this (session, client_uuid) is a no-op.
    if (dto.client_uuid) {
      const [dup] = await db.select().from(scanLines).where(and(eq(scanLines.sessionNo, sessionNo), eq(scanLines.clientUuid, dto.client_uuid))).limit(1);
      if (dup) return { session_no: sessionNo, item_id: dup.itemId, qty: n(dup.qty), deduped: true };
    }
    await db.insert(scanLines).values({
      sessionNo, scannedAt: new Date(), qrData: dto.qr_data, itemId, itemDescription: p.DESC ?? null, lotNo: dto.lot_no ?? null,
      qty: String(dto.qty ?? 1), uom: p.UOM ?? null, action: dto.action ?? s.sessionType, locationId: s.locationId, confirmed: false,
      clientUuid: dto.client_uuid ?? null,
    });
    return { session_no: sessionNo, item_id: itemId, qty: dto.qty ?? 1, deduped: false };
  }

  // Resolve a scanned code (raw payload OR a /q?d=… deep link) to the underlying item or asset.
  // Powers the public /q resolver page: identify what was scanned, then link into the app.
  async resolve(code: string) {
    const db = this.db;
    const p = parseQrPayload(code);
    const id = (p.ITEM_ID || p.ASSET_ID || String(code ?? '').trim()).trim();
    if (!id) throw new BadRequestException({ code: 'NO_CODE', message: 'No code in QR', messageTh: 'ไม่พบรหัสใน QR' });
    // Prefer the entity type the payload declares; fall back to the other so a bare code still resolves.
    const preferAsset = !!p.ASSET_ID && !p.ITEM_ID;
    const lookupItem = async () => {
      const [it] = await db.select().from(items).where(eq(items.itemId, id)).limit(1);
      return it ? { kind: 'item' as const, id: it.itemId, description: it.itemDescription ?? null, uom: it.uom ?? null, price: it.unitPrice ?? null, category: it.category ?? null } : null;
    };
    const lookupAsset = async () => {
      const [a] = await db.select().from(fixedAssets).where(eq(fixedAssets.assetNo, id)).limit(1);
      return a ? { kind: 'asset' as const, id: a.assetNo, description: a.name ?? null, location: a.location ?? null, status: a.status ?? null } : null;
    };
    const found = preferAsset ? (await lookupAsset()) ?? (await lookupItem()) : (await lookupItem()) ?? (await lookupAsset());
    return found ?? { kind: 'unknown' as const, id, parsed: p };
  }

  async getSession(sessionNo: string) {
    const db = this.db;
    const [s] = await db.select().from(scanSessions).where(eq(scanSessions.sessionNo, sessionNo)).limit(1);
    if (!s) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Session not found', messageTh: 'ไม่พบเซสชัน' });
    const lines = await db.select().from(scanLines).where(eq(scanLines.sessionNo, sessionNo)).orderBy(desc(scanLines.id));
    return {
      session_no: s.sessionNo, session_type: s.sessionType, location_id: s.locationId, status: s.status,
      lines: lines.map((l: any) => ({ item_id: l.itemId, item_description: l.itemDescription, lot_no: l.lotNo, qty: n(l.qty), action: l.action, confirmed: l.confirmed })),
    };
  }

  // Commit each scanned line to stock_movements per the session type, then close.
  async close(sessionNo: string, user: JwtUser) {
    const db = this.db;
    return db.transaction(async (tx: any) => {
      // FOR UPDATE + re-check under lock so concurrent closes can't double-commit movements.
      const [s] = await tx.select().from(scanSessions).where(eq(scanSessions.sessionNo, sessionNo)).limit(1).for('update');
      if (!s) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Session not found', messageTh: 'ไม่พบเซสชัน' });
      if (s.status === 'Closed') return { session_no: sessionNo, status: 'Closed', already: true };
      const lines = await tx.select().from(scanLines).where(eq(scanLines.sessionNo, sessionNo));
      const moveType = MOVE[s.sessionType] ?? 'Stock In';
      const now = new Date();
      let committed = 0;
      for (const l of lines) {
        const qty = n(l.qty);
        await tx.insert(stockMovements).values({ tenantId: user.tenantId ?? null,
          moveDate: now, docNo: sessionNo, moveType, itemId: l.itemId, itemDescription: l.itemDescription, uom: l.uom,
          qty: String(moveType === 'Issue' ? -Math.abs(qty) : Math.abs(qty)), fromLocation: s.locationId ?? null, toLocation: s.locationId ?? null,
          refDoc: s.docRef ?? sessionNo, remarks: `Scan session ${s.sessionType}`, createdBy: user.username,
        });
        committed++;
      }
      await tx.update(scanLines).set({ confirmed: true }).where(eq(scanLines.sessionNo, sessionNo));
      await tx.update(scanSessions).set({ status: 'Closed', closedAt: now }).where(eq(scanSessions.id, s.id));
      return { session_no: sessionNo, status: 'Closed', committed };
    });
  }

  async listSessions(limit = 50) {
    const db = this.db;
    const rows = await db.select().from(scanSessions).orderBy(desc(scanSessions.id)).limit(limit);
    return { sessions: rows.map((r: any) => ({ session_no: r.sessionNo, session_type: r.sessionType, location_id: r.locationId, status: r.status, created_by: r.createdBy })), count: rows.length };
  }
}
