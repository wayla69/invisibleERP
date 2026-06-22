import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { etaxSubmissions } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// RD/ETDA e-Tax Invoice & e-Receipt submission via a service provider.
// 'mock' acks immediately (CI + when no SP configured). Real SPs (INET/Frank/…) call out over HTTPS
// with signed XML (etax-xml already exists) — drop in via submitToProvider once creds exist.
@Injectable()
export class EtaxService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private submitToProvider(provider: string, docNo: string): { status: string; providerRef: string; rd: any } {
    if (provider === 'mock') return { status: 'Accepted', providerRef: `mock-${docNo}`, rd: { code: '0', message: 'accepted (sandbox)' } };
    // INET / Frank / Leceipt etc. need a configured endpoint + cert.
    throw new BadRequestException({ code: 'ETAX_PROVIDER_NOT_CONFIGURED', message: `e-Tax provider ${provider} not configured`, messageTh: 'ยังไม่ได้ตั้งค่าผู้ให้บริการ e-Tax' });
  }

  async submit(docNo: string, provider: string | undefined, user: JwtUser) {
    const db = this.db as any;
    const prov = provider ?? 'mock';
    const [existing] = await db.select().from(etaxSubmissions).where(and(eq(etaxSubmissions.docNo, docNo), eq(etaxSubmissions.status, 'Accepted'))).limit(1);
    if (existing) return { doc_no: docNo, status: 'Accepted', provider_ref: existing.providerRef, idempotent: true };
    const res = this.submitToProvider(prov, docNo);
    await db.insert(etaxSubmissions).values({ tenantId: user.tenantId ?? null, docNo, provider: prov, status: res.status, providerRef: res.providerRef, rdResponse: res.rd, submittedBy: user.username, submittedAt: new Date() });
    return { doc_no: docNo, status: res.status, provider_ref: res.providerRef, provider: prov };
  }

  async status(docNo: string) {
    const db = this.db as any;
    const [s] = await db.select().from(etaxSubmissions).where(eq(etaxSubmissions.docNo, docNo)).orderBy(desc(etaxSubmissions.id)).limit(1);
    if (!s) return { doc_no: docNo, status: 'NotSubmitted' };
    return { doc_no: docNo, status: s.status, provider: s.provider, provider_ref: s.providerRef, submitted_at: s.submittedAt, rd_response: s.rdResponse };
  }

  async list(limit = 100) {
    const db = this.db as any;
    const rows = await db.select().from(etaxSubmissions).orderBy(desc(etaxSubmissions.id)).limit(limit);
    return { submissions: rows.map((r: any) => ({ doc_no: r.docNo, provider: r.provider, status: r.status, provider_ref: r.providerRef, submitted_at: r.submittedAt })), count: rows.length };
  }
}
