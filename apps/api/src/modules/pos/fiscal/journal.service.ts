import { Inject, Injectable } from '@nestjs/common';
import { eq, desc, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { posJournal } from '../../../database/schema';
import type { JwtUser } from '../../../common/decorators';

export interface JournalEntry { doc_type: string; doc_no?: string; action?: string; payload: Record<string, any> }

// Append-only, hash-chained electronic journal. Each row's hash binds the previous hash + its own
// content, so altering or deleting any past row breaks every later hash → tamper-evident (RD requirement).
@Injectable()
export class JournalService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async append(e: JournalEntry, user: JwtUser) {
    const db = this.db as any;
    const tid = user.tenantId ?? null;
    return db.transaction(async (tx: any) => {
      // serialize per tenant: lock the latest row (FOR UPDATE) so concurrent appends can't fork the chain
      const [last] = await tx.select().from(posJournal).where(tid == null ? isNull(posJournal.tenantId) : eq(posJournal.tenantId, tid)).orderBy(desc(posJournal.seq)).limit(1).for('update');
      const seq = (last?.seq ?? 0) + 1;
      const prevHash = last?.hash ?? null;
      const hash = hashEntry(prevHash, seq, e);
      await tx.insert(posJournal).values({ tenantId: user.tenantId ?? null, seq, docType: e.doc_type, docNo: e.doc_no ?? null, action: e.action ?? null, payload: e.payload, prevHash, hash, createdBy: user.username });
      return { seq, hash, prev_hash: prevHash };
    });
  }

  async list(limit = 100) {
    const db = this.db as any;
    const rows = await db.select().from(posJournal).orderBy(desc(posJournal.seq)).limit(limit);
    return { entries: rows.map((r: any) => ({ seq: r.seq, doc_type: r.docType, doc_no: r.docNo, action: r.action, payload: r.payload, prev_hash: r.prevHash, hash: r.hash, created_by: r.createdBy, created_at: r.createdAt })), count: rows.length };
  }

  // Recompute the whole chain and report the first seq where it breaks (tamper / gap).
  async verify() {
    const db = this.db as any;
    const rows = await db.select().from(posJournal).orderBy(posJournal.seq);
    let prevHash: string | null = null;
    let expectedSeq = 1;
    for (const r of rows) {
      if (r.seq !== expectedSeq) return { ok: false, broken_at: r.seq, reason: 'sequence gap' };
      const expect = hashEntry(prevHash, r.seq, { doc_type: r.docType, doc_no: r.docNo ?? undefined, action: r.action ?? undefined, payload: r.payload });
      if (r.prevHash !== prevHash) return { ok: false, broken_at: r.seq, reason: 'prev_hash mismatch' };
      if (r.hash !== expect) return { ok: false, broken_at: r.seq, reason: 'hash mismatch' };
      prevHash = r.hash;
      expectedSeq++;
    }
    return { ok: true, length: rows.length };
  }
}

function stableStringify(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}
function hashEntry(prevHash: string | null, seq: number, e: JournalEntry): string {
  return createHash('sha256').update(`${prevHash ?? ''}|${seq}|${e.doc_type}|${e.doc_no ?? ''}|${stableStringify(e.payload)}`).digest('hex');
}
