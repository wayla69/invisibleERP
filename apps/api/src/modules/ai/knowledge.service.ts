import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { kbDocuments, kbChunks } from '../../database/schema';
import { EmbedderService, cosine } from './embedder';
import type { JwtUser } from '../../common/decorators';

export interface Citation { doc_id: number; title: string; source: string | null; ord: number; content: string; score: number }

// Phase D2 — RAG over the tenant's own policies/SOPs/contracts. Ingest chunks + embeds; search does
// in-service cosine over the tenant's chunks (RLS-scoped); ask() implements cite-or-refuse so the
// assistant answers ONLY from retrieved content (or declines) — no hallucinated policy.
@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly embedder: EmbedderService,
  ) {}

  private get minScore() { return Number(process.env.KB_MIN_SCORE ?? 0.15); }

  // Split into ~maxWords chunks, preferring paragraph boundaries.
  private chunk(text: string, maxWords = 80): string[] {
    const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const out: string[] = [];
    for (const p of paras) {
      const words = p.split(/\s+/);
      if (words.length <= maxWords) { out.push(p); continue; }
      for (let i = 0; i < words.length; i += maxWords) out.push(words.slice(i, i + maxWords).join(' '));
    }
    return out.length ? out : [text.trim()];
  }

  async ingest(dto: { title: string; source?: string; content: string }, user: JwtUser) {
    if (!dto.content?.trim()) throw new BadRequestException({ code: 'BAD_PAYLOAD', message: 'content required', messageTh: 'ต้องมีเนื้อหา' });
    const db = this.db as any;
    const [doc] = await db.insert(kbDocuments).values({ tenantId: user.tenantId ?? null, title: dto.title, source: dto.source ?? null, createdBy: user.username }).returning({ id: kbDocuments.id });
    const chunks = this.chunk(dto.content);
    const rows = [] as any[];
    for (let i = 0; i < chunks.length; i++) {
      const emb = await this.embedder.embed(chunks[i]);
      rows.push({ tenantId: user.tenantId ?? null, docId: Number(doc.id), ord: i, content: chunks[i], embedding: emb.vector, embedProvider: emb.provider });
    }
    if (rows.length) await db.insert(kbChunks).values(rows);
    return { doc_id: Number(doc.id), title: dto.title, chunks: rows.length };
  }

  async search(query: string, k: number, _user: JwtUser): Promise<{ results: Citation[]; provider: string }> {
    const db = this.db as any;
    // Embed the query, then compare ONLY against chunks in the same embedding space (docs/24 R4-1) —
    // cross-space cosine is noise. Chunks embedded by another provider stay invisible until re-embedded
    // (POST /api/ai/kb/reembed) — degraded coverage, never wrong scores.
    const q = await this.embedder.embed(query);
    const docs = await db.select().from(kbDocuments);
    const titleById = new Map<number, any>(docs.map((d: any) => [Number(d.id), d] as [number, any]));
    const chunks = await db.select().from(kbChunks).where(eq(kbChunks.embedProvider, q.provider));
    const scored: Citation[] = chunks.map((c: any) => {
      const d = titleById.get(Number(c.docId));
      return { doc_id: Number(c.docId), title: d?.title ?? '', source: d?.source ?? null, ord: c.ord, content: c.content, score: Math.round(cosine(q.vector, c.embedding as number[]) * 1000) / 1000 };
    });
    scored.sort((a, b) => b.score - a.score);
    return { results: scored.slice(0, Math.max(1, k)), provider: q.provider };
  }

  // Re-embed every chunk with the CURRENT provider (docs/24 R4-1) — the migration path after switching
  // EMBED_PROVIDER (e.g. local → voyage). Idempotent; RLS scopes to the caller's tenant.
  async reembedAll(_user: JwtUser) {
    const db = this.db as any;
    const chunks = await db.select().from(kbChunks);
    let updated = 0;
    for (const c of chunks) {
      const emb = await this.embedder.embed(String(c.content));
      if (emb.provider === c.embedProvider) continue; // already in the current space
      await db.update(kbChunks).set({ embedding: emb.vector, embedProvider: emb.provider }).where(eq(kbChunks.id, Number(c.id)));
      updated++;
    }
    return { reembedded: updated, provider: this.embedder.provider, total: chunks.length };
  }

  // cite-or-refuse: return citations only when the best match clears the threshold; otherwise refuse.
  async ask(query: string, user: JwtUser) {
    const { results } = await this.search(query, 4, user);
    const top = results[0];
    if (!top || top.score < this.minScore) {
      return { refused: true, answer: 'ไม่พบข้อมูลที่เกี่ยวข้องในฐานความรู้ (ตอบไม่ได้หากไม่มีแหล่งอ้างอิง)', citations: [] as Citation[] };
    }
    const cites = results.filter((r) => r.score >= this.minScore);
    return { refused: false, citations: cites, context: cites.map((c) => `[${c.title}#${c.ord}] ${c.content}`).join('\n\n') };
  }
}
