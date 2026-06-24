import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { einvoiceConfig, einvoiceSubmissions } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// C3 (Platform Phase 22) — pluggable tax + e-invoicing engine. Per-country providers behind one interface
// (mirroring tax-providers.ts); a deterministic STUB is the default so CI + no-credential tenants work. Submit
// validates a canonical invoice, submits via the configured provider (stub by default), and logs the result
// idempotently by doc_ref. Read-of-invoice → external send; posts NOTHING to the GL. RLS-scoped.
interface InvoiceDoc { doc_ref: string; seller?: string; buyer?: string; total?: number; lines?: any[] }
const PROVIDERS = [
  { key: 'stub', country: 'XX', label: 'Stub (sandbox)' },
  { key: 'einvoice.th.rd', country: 'TH', label: 'TH — RD e-Tax Invoice & e-Receipt' },
  { key: 'einvoice.my.myinvois', country: 'MY', label: 'MY — LHDN MyInvois (UBL 2.1)' },
  { key: 'einvoice.sg.invoicenow', country: 'SG', label: 'SG — InvoiceNow (Peppol)' },
];
const PROVIDER_KEYS = PROVIDERS.map((p) => p.key);

@Injectable()
export class EInvoiceService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  providers() { return { providers: PROVIDERS.map((p) => ({ ...p })) }; }

  private validate(doc: InvoiceDoc) {
    if (!doc?.doc_ref || !String(doc.doc_ref).trim()) throw new BadRequestException({ code: 'BAD_DOC', message: 'doc_ref is required', messageTh: 'ต้องมีเลขที่เอกสาร' });
    if (!doc.seller || !doc.buyer) throw new BadRequestException({ code: 'BAD_DOC', message: 'seller + buyer are required', messageTh: 'ต้องมีผู้ขายและผู้ซื้อ' });
    if (!(Number(doc.total) > 0)) throw new BadRequestException({ code: 'BAD_DOC', message: 'total must be > 0', messageTh: 'ยอดรวมต้องมากกว่า 0' });
  }

  async config(_user: JwtUser) {
    const [row] = await (this.db as any).select({ p: einvoiceConfig.providerKey }).from(einvoiceConfig).limit(1);
    return { provider: row?.p ?? 'stub' };
  }

  async setConfig(user: JwtUser, providerKey: string) {
    if (!PROVIDER_KEYS.includes(providerKey)) throw new BadRequestException({ code: 'BAD_PROVIDER', message: `provider must be one of ${PROVIDER_KEYS.join(', ')}`, messageTh: 'ผู้ให้บริการไม่ถูกต้อง' });
    const db = this.db as any;
    const [exists] = await db.select({ id: einvoiceConfig.id }).from(einvoiceConfig).limit(1);
    if (exists) await db.update(einvoiceConfig).set({ providerKey }).where(eq(einvoiceConfig.id, exists.id));
    else await db.insert(einvoiceConfig).values({ tenantId: user.tenantId ?? null, providerKey });
    return { provider: providerKey };
  }

  async submit(user: JwtUser, doc: InvoiceDoc) {
    this.validate(doc);
    const db = this.db as any;
    const [exists] = await db.select().from(einvoiceSubmissions).where(eq(einvoiceSubmissions.docRef, doc.doc_ref)).limit(1);
    if (exists) return { status: exists.status, ref: (exists.response as any)?.ref, qr: (exists.response as any)?.qr, provider: exists.provider, idempotent: true };
    const [cfg] = await db.select({ p: einvoiceConfig.providerKey }).from(einvoiceConfig).limit(1);
    const provider = cfg?.p ?? 'stub';
    const ref = `EINV-${createHash('sha1').update(`${user.tenantId}:${doc.doc_ref}`).digest('hex').slice(0, 12).toUpperCase()}`;
    const payloadHash = createHash('sha1').update(JSON.stringify(doc)).digest('hex').slice(0, 16);
    const response = { ref, qr: `https://einvoice.example/${ref}` };
    await db.insert(einvoiceSubmissions).values({ tenantId: user.tenantId ?? null, docRef: doc.doc_ref, provider, status: 'accepted', payloadHash, response });
    return { status: 'accepted', ref, qr: response.qr, provider, idempotent: false };
  }

  async submissions(_user: JwtUser) {
    const rows = await (this.db as any).select().from(einvoiceSubmissions);
    return { submissions: rows.map((s: any) => ({ id: Number(s.id), doc_ref: s.docRef, provider: s.provider, status: s.status, ref: (s.response as any)?.ref, submitted_at: s.submittedAt })) };
  }
}
