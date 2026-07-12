import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, or, desc, ilike, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { kbArticles, kbDeflections } from '../../database/schema/service-kb';
import { docCountersTenant } from '../../database/schema/system';
import type { JwtUser } from '../../common/decorators';

// SVC-6 — Service Cloud: Knowledge Base + Case Deflection (SVC-06 control). A governed KB publish lifecycle
// (draft → published → archived) where an article is published only by a DIFFERENT user than its author
// (maker-checker — no unreviewed knowledge reaches customers), plus a case-deflection log so self-service
// effectiveness (deflection rate) is measurable. Distinct from the SVC-4/5 case surface; no GL post.
@Injectable()
export class ServiceKbService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async nextArticleNo(tenantId: number) {
    const r = await this.db.insert(docCountersTenant)
      .values({ docType: 'KB', tenantId, period: 'all', n: 1 })
      .onConflictDoUpdate({
        target: [docCountersTenant.docType, docCountersTenant.tenantId, docCountersTenant.period],
        set: { n: sql`${docCountersTenant.n} + 1` },
      }).returning({ n: docCountersTenant.n });
    return `KB-${String(Number(r[0]!.n)).padStart(5, '0')}`;
  }

  private async load(user: JwtUser, id: number) {
    const conds = [eq(kbArticles.id, id)];
    if (user.tenantId != null) conds.push(eq(kbArticles.tenantId, user.tenantId));
    const [a] = await this.db.select().from(kbArticles).where(and(...conds)).limit(1);
    if (!a) throw new NotFoundException({ code: 'ARTICLE_NOT_FOUND', message: 'Article not found', messageTh: 'ไม่พบบทความ' });
    return a;
  }

  // ── Authoring ──────────────────────────────────────────────────────────────
  async listArticles(user: JwtUser, status?: string) {
    const conds = [];
    if (user.tenantId != null) conds.push(eq(kbArticles.tenantId, user.tenantId));
    if (status && status !== 'all') conds.push(eq(kbArticles.status, status));
    const rows = await this.db.select().from(kbArticles).where(conds.length ? and(...conds) : undefined).orderBy(desc(kbArticles.id)).limit(500);
    return { articles: rows.map(fmt), count: rows.length };
  }

  async getArticle(user: JwtUser, id: number) { return fmt(await this.load(user, id)); }

  async createArticle(user: JwtUser, dto: { title: string; body: string; category?: string; tags?: string }) {
    const articleNo = await this.nextArticleNo(user.tenantId!);
    const [row] = await this.db.insert(kbArticles).values({
      tenantId: user.tenantId ?? null, articleNo, title: dto.title.trim(), body: dto.body,
      category: dto.category ?? null, tags: dto.tags ?? null, status: 'draft',
      author: user.username, createdBy: user.username,
    }).returning();
    return fmt(row!);
  }

  // Edit is only allowed while the article is a draft (published content is immutable — re-draft via a new
  // version if needed; keeps the reviewed-then-published guarantee intact).
  async updateArticle(user: JwtUser, id: number, dto: { title?: string; body?: string; category?: string; tags?: string }) {
    const a = await this.load(user, id);
    if (a.status !== 'draft') throw new BadRequestException({ code: 'ARTICLE_NOT_DRAFT', message: `Article ${a.articleNo} is not a draft (status=${a.status})`, messageTh: `บทความ ${a.articleNo} ไม่ใช่ฉบับร่าง` });
    const [row] = await this.db.update(kbArticles).set({
      title: dto.title?.trim() ?? a.title, body: dto.body ?? a.body,
      category: dto.category ?? a.category, tags: dto.tags ?? a.tags, updatedAt: new Date(),
    }).where(eq(kbArticles.id, a.id)).returning();
    return fmt(row!);
  }

  // SVC-06 control: publish a draft — the publisher MUST differ from the author (maker-checker), so no one
  // publishes their own unreviewed article. draft → published only.
  async publishArticle(user: JwtUser, id: number) {
    const a = await this.load(user, id);
    if (a.status !== 'draft') throw new BadRequestException({ code: 'ARTICLE_NOT_DRAFT', message: `Article ${a.articleNo} is not a draft (status=${a.status})`, messageTh: `บทความ ${a.articleNo} ไม่ใช่ฉบับร่าง` });
    if (a.author && a.author === user.username) throw new ForbiddenException({ code: 'SOD_SELF_PUBLISH', message: 'The publisher must differ from the article author', messageTh: 'ผู้เผยแพร่ต้องไม่ใช่ผู้เขียนบทความ' });
    const [row] = await this.db.update(kbArticles).set({ status: 'published', publishedBy: user.username, publishedAt: new Date(), updatedAt: new Date() }).where(eq(kbArticles.id, a.id)).returning();
    return fmt(row!);
  }

  async archiveArticle(user: JwtUser, id: number) {
    const a = await this.load(user, id);
    if (a.status !== 'published') throw new BadRequestException({ code: 'ARTICLE_NOT_PUBLISHED', message: `Article ${a.articleNo} is not published (status=${a.status})`, messageTh: `บทความ ${a.articleNo} ยังไม่ได้เผยแพร่` });
    const [row] = await this.db.update(kbArticles).set({ status: 'archived', updatedAt: new Date() }).where(eq(kbArticles.id, a.id)).returning();
    return fmt(row!);
  }

  // ── Self-service: search PUBLISHED articles (the case-deflection surface). Increments views on the hits. ──
  async search(user: JwtUser, q: string) {
    const term = (q ?? '').trim();
    const conds = [eq(kbArticles.status, 'published')];
    if (user.tenantId != null) conds.push(eq(kbArticles.tenantId, user.tenantId));
    if (term) {
      const like = `%${term}%`;
      conds.push(or(ilike(kbArticles.title, like), ilike(kbArticles.body, like), ilike(kbArticles.tags, like))!);
    }
    const rows = await this.db.select().from(kbArticles).where(and(...conds)).orderBy(desc(kbArticles.views)).limit(20);
    if (rows.length) {
      const ids = rows.map((r) => Number(r.id));
      await this.db.update(kbArticles).set({ views: sql`${kbArticles.views} + 1` }).where(inArray(kbArticles.id, ids));
    }
    return { results: rows.map(fmt), count: rows.length };
  }

  // Feedback signal on a published article — helpful / not_helpful counters (the deflection-quality signal).
  async feedback(user: JwtUser, id: number, dto: { helpful: boolean }) {
    const a = await this.load(user, id);
    if (a.status !== 'published') throw new BadRequestException({ code: 'ARTICLE_NOT_PUBLISHED', message: `Article ${a.articleNo} is not published`, messageTh: `บทความ ${a.articleNo} ยังไม่ได้เผยแพร่` });
    const [row] = await this.db.update(kbArticles)
      .set(dto.helpful ? { helpful: sql`${kbArticles.helpful} + 1` } : { notHelpful: sql`${kbArticles.notHelpful} + 1` })
      .where(eq(kbArticles.id, a.id)).returning();
    return fmt(row!);
  }

  // ── Deflection log + detective stats ────────────────────────────────────────
  // Record a KB-assisted interaction: deflected=true → customer self-served (no case); false → a case was
  // opened despite the article (case_id set).
  async logDeflection(user: JwtUser, dto: { query?: string; article_id?: number; deflected: boolean; case_id?: number }) {
    const [row] = await this.db.insert(kbDeflections).values({
      tenantId: user.tenantId ?? null, query: dto.query ?? null, articleId: dto.article_id ?? null,
      deflected: dto.deflected === true, caseId: dto.case_id ?? null, createdBy: user.username,
    }).returning();
    return { id: Number(row!.id), deflected: row!.deflected === true };
  }

  // Detective read: the deflection rate + top articles — the population a service manager reads to gauge
  // self-service effectiveness.
  async deflectionStats(user: JwtUser) {
    const conds = [];
    if (user.tenantId != null) conds.push(eq(kbDeflections.tenantId, user.tenantId));
    const rows = await this.db.select().from(kbDeflections).where(conds.length ? and(...conds) : undefined);
    const total = rows.length;
    const deflected = rows.filter((r) => r.deflected === true).length;
    const topConds = [eq(kbArticles.status, 'published')];
    if (user.tenantId != null) topConds.push(eq(kbArticles.tenantId, user.tenantId));
    const top = await this.db.select().from(kbArticles).where(and(...topConds)).orderBy(desc(kbArticles.views)).limit(5);
    return {
      total_interactions: total, deflected, opened: total - deflected,
      deflection_rate: total ? Math.round((deflected / total) * 1000) / 1000 : 0,
      top_articles: top.map((a) => ({ article_no: a.articleNo, title: a.title, views: Number(a.views), helpful: Number(a.helpful), not_helpful: Number(a.notHelpful) })),
    };
  }
}

function fmt(a: typeof kbArticles.$inferSelect) {
  return {
    id: Number(a.id), article_no: a.articleNo, title: a.title, body: a.body, category: a.category, tags: a.tags,
    status: a.status, author: a.author, published_by: a.publishedBy, published_at: a.publishedAt,
    views: Number(a.views), helpful: Number(a.helpful), not_helpful: Number(a.notHelpful),
    created_by: a.createdBy, created_at: a.createdAt, updated_at: a.updatedAt,
  };
}
