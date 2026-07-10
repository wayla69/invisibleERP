import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { einvoiceConfig, einvoiceSubmissions } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// C2 — pluggable tax + e-invoicing engine. Per-country providers behind one interface
// (mirroring tax-providers.ts); a deterministic STUB is the default so CI + no-credential tenants work. Submit
// validates a canonical invoice, submits via the configured provider (stub by default), and logs the result
// idempotently by doc_ref. Read-of-invoice → external send; posts NOTHING to the GL. RLS-scoped.
interface InvoiceDoc { doc_ref: string; seller?: string; buyer?: string; total?: number; currency?: string; lines?: any[] }
const PROVIDERS = [
  { key: 'stub', country: 'XX', label: 'Stub (sandbox)' },
  { key: 'einvoice.th.rd', country: 'TH', label: 'TH — RD e-Tax Invoice & e-Receipt' },
  { key: 'einvoice.my.myinvois', country: 'MY', label: 'MY — LHDN MyInvois (UBL 2.1)' },
  { key: 'einvoice.sg.invoicenow', country: 'SG', label: 'SG — InvoiceNow (Peppol BIS3)' },
];

// MY — LHDN MyInvois UBL 2.1 document stub (C2). Real submission requires LHDN API credentials.
function buildMyInvoisXml(doc: InvoiceDoc): string {
  const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cur = doc.currency ?? 'MYR';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>urn:www.mygov.my:einvoice:customization</cbc:CustomizationID>
  <cbc:ID>${esc(doc.doc_ref)}</cbc:ID>
  <cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${esc(cur)}</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party><cac:PartyName><cbc:Name>${esc(doc.seller)}</cbc:Name></cac:PartyName></cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party><cac:PartyName><cbc:Name>${esc(doc.buyer)}</cbc:Name></cac:PartyName></cac:Party>
  </cac:AccountingCustomerParty>
  <cac:LegalMonetaryTotal>
    <cbc:PayableAmount currencyID="${esc(cur)}">${Number(doc.total ?? 0).toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
</Invoice>`;
}

// SG — InvoiceNow Peppol BIS Billing 3.0 document stub (C2). Real submission requires Peppol AP credentials.
function buildSgPeppolXml(doc: InvoiceDoc): string {
  const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cur = doc.currency ?? 'SGD';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${esc(doc.doc_ref)}</cbc:ID>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${esc(cur)}</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party><cac:PartyName><cbc:Name>${esc(doc.seller)}</cbc:Name></cac:PartyName></cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party><cac:PartyName><cbc:Name>${esc(doc.buyer)}</cbc:Name></cac:PartyName></cac:Party>
  </cac:AccountingCustomerParty>
  <cac:LegalMonetaryTotal>
    <cbc:PayableAmount currencyID="${esc(cur)}">${Number(doc.total ?? 0).toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
</Invoice>`;
}
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
    const [row] = await this.db.select({ p: einvoiceConfig.providerKey }).from(einvoiceConfig).limit(1);
    return { provider: row?.p ?? 'stub' };
  }

  async setConfig(user: JwtUser, providerKey: string) {
    if (!PROVIDER_KEYS.includes(providerKey)) throw new BadRequestException({ code: 'BAD_PROVIDER', message: `provider must be one of ${PROVIDER_KEYS.join(', ')}`, messageTh: 'ผู้ให้บริการไม่ถูกต้อง' });
    const db = this.db;
    const [exists] = await db.select({ id: einvoiceConfig.id }).from(einvoiceConfig).limit(1);
    if (exists) await db.update(einvoiceConfig).set({ providerKey }).where(eq(einvoiceConfig.id, exists.id));
    else await db.insert(einvoiceConfig).values({ tenantId: user.tenantId ?? null, providerKey });
    return { provider: providerKey };
  }

  async submit(user: JwtUser, doc: InvoiceDoc) {
    this.validate(doc);
    const db = this.db;
    const [exists] = await db.select().from(einvoiceSubmissions).where(eq(einvoiceSubmissions.docRef, doc.doc_ref)).limit(1);
    if (exists) return { status: exists.status, ref: (exists.response as { ref?: string; qr?: string } | null)?.ref, qr: (exists.response as { ref?: string; qr?: string } | null)?.qr, provider: exists.provider, idempotent: true };
    const [cfg] = await db.select({ p: einvoiceConfig.providerKey }).from(einvoiceConfig).limit(1);
    const provider = cfg?.p ?? 'stub';
    const ref = `EINV-${createHash('sha1').update(`${user.tenantId}:${doc.doc_ref}`).digest('hex').slice(0, 12).toUpperCase()}`;
    // Build a country-appropriate document for payload hashing (MY → MyInvois UBL 2.1; SG → Peppol BIS3; others → JSON).
    let payloadSource: string;
    if (provider === 'einvoice.my.myinvois') payloadSource = buildMyInvoisXml(doc);
    else if (provider === 'einvoice.sg.invoicenow') payloadSource = buildSgPeppolXml(doc);
    else payloadSource = JSON.stringify(doc);
    const payloadHash = createHash('sha1').update(payloadSource).digest('hex').slice(0, 16);
    const response = { ref, qr: `https://einvoice.example/${ref}` };
    await db.insert(einvoiceSubmissions).values({ tenantId: user.tenantId ?? null, docRef: doc.doc_ref, provider, status: 'accepted', payloadHash, response });
    return { status: 'accepted', ref, qr: response.qr, provider, idempotent: false };
  }

  async submissions(_user: JwtUser) {
    const rows = await this.db.select().from(einvoiceSubmissions);
    return { submissions: rows.map((s: any) => ({ id: Number(s.id), doc_ref: s.docRef, provider: s.provider, status: s.status, ref: (s.response as { ref?: string } | null)?.ref, submitted_at: s.submittedAt })) };
  }
}
