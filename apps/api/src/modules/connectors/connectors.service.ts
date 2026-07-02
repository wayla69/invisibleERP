import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { connectors, connectorSyncs, externalIdMap } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// D2 (Platform Phase 24) — connector framework. Register a connector, then sync: a STUB transport produces a
// deterministic canonical batch (CI-safe; real adapters swap in OAuth + REST behind the same shape), deduped
// idempotently via external_id_map, with every run logged. Pulled records are returned for review — the
// framework never auto-posts to AR/AP/GL. RLS-scoped.
const CATALOG = [
  { type: 'line', label: 'LINE (Messaging / Login)', capabilities: ['customers'] },
  { type: 'shopee', label: 'Shopee Open Platform', capabilities: ['orders', 'catalog'] },
  { type: 'bank_csv', label: 'Bank statement import (CSV / camt / OFX)', capabilities: ['statements'] },
];
const TYPES = CATALOG.map((c) => c.type);

@Injectable()
export class ConnectorsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  catalog() { return { connectors: CATALOG.map((c) => ({ ...c })) }; }

  async list(_user: JwtUser) {
    const rows = await this.db.select().from(connectors);
    return { connectors: rows.map((c: any) => ({ id: Number(c.id), type: c.type, label: c.label, status: c.status })) };
  }

  async register(user: JwtUser, type: string, label?: string, config?: any) {
    if (!TYPES.includes(type)) throw new BadRequestException({ code: 'BAD_CONNECTOR', message: `type must be one of ${TYPES.join(', ')}`, messageTh: 'ประเภทตัวเชื่อมต่อไม่ถูกต้อง' });
    const [row] = await this.db.insert(connectors).values({ tenantId: user.tenantId ?? null, type, label: label ?? CATALOG.find((c) => c.type === type)!.label, config: config ?? {}, createdBy: user.username }).returning({ id: connectors.id });
    return { id: Number(row!.id), type };
  }

  // Stub transport: deterministic canonical fixtures per type (bank_csv parses the posted statement text).
  private fixtures(type: string, body: any): { canonicalType: string; externalId: string; summary: string }[] {
    if (type === 'shopee') return [
      { canonicalType: 'order', externalId: 'SP-1001', summary: 'Shopee order SP-1001 — 2 items, ฿450' },
      { canonicalType: 'order', externalId: 'SP-1002', summary: 'Shopee order SP-1002 — 1 item, ฿120' },
    ];
    if (type === 'line') return [
      { canonicalType: 'customer', externalId: 'LINE-U1', summary: 'LINE follower U1' },
    ];
    if (type === 'bank_csv') {
      const csv = String(body?.csv ?? '');
      return csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const fp = createHash('sha1').update(l).digest('hex').slice(0, 12);
        return { canonicalType: 'statement_line', externalId: `BANK-${fp}`, summary: l.slice(0, 80) };
      });
    }
    return [];
  }

  async sync(user: JwtUser, id: number, body: any) {
    const db = this.db;
    const [conn] = await db.select().from(connectors).where(eq(connectors.id, id)).limit(1);
    if (!conn) throw new NotFoundException({ code: 'CONNECTOR_NOT_FOUND', message: 'connector not found', messageTh: 'ไม่พบตัวเชื่อมต่อ' });
    const batch = this.fixtures(conn.type, body);
    let created = 0;
    const records: any[] = [];
    for (const rec of batch) {
      const [seen] = await db.select({ id: externalIdMap.id }).from(externalIdMap).where(and(eq(externalIdMap.connectorType, conn.type), eq(externalIdMap.canonicalType, rec.canonicalType), eq(externalIdMap.externalId, rec.externalId))).limit(1);
      if (!seen) { await db.insert(externalIdMap).values({ tenantId: user.tenantId ?? null, connectorType: conn.type, canonicalType: rec.canonicalType, externalId: rec.externalId, localRef: null }); created++; }
      records.push({ ...rec, is_new: !seen });
    }
    await db.insert(connectorSyncs).values({ tenantId: user.tenantId ?? null, connectorId: id, status: 'ok', pulled: batch.length, createdCount: created, detail: `pulled ${batch.length}, new ${created}` });
    return { pulled: batch.length, created, duplicates: batch.length - created, records };
  }

  async syncs(_user: JwtUser, id: number) {
    const rows = await this.db.select().from(connectorSyncs).where(eq(connectorSyncs.connectorId, id)).orderBy(desc(connectorSyncs.ranAt));
    return { syncs: rows.map((s: any) => ({ id: Number(s.id), status: s.status, pulled: Number(s.pulled), created: Number(s.createdCount), detail: s.detail, ran_at: s.ranAt })) };
  }
}
