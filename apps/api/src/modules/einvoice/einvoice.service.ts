import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { einvoiceConfig, einvoiceSubmissions } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// C2 — pluggable tax + e-invoicing engine. Per-country providers behind one interface
// (mirroring tax-providers.ts); a deterministic STUB is the default so CI + no-credential tenants work. Submit
// validates a canonical invoice, PREPARES the country-appropriate document (payload + hash), delivers it via
// the configured provider's TRANSPORT, and logs the result idempotently by doc_ref. Posts NOTHING to the GL.
// RLS-scoped.
//
// HONESTY CONTRACT (do not regress): a real tax-authority filing only happens when a provider's transport is
// actually wired (credentials + endpoint, which live OUTSIDE the repo). Until then an EXTERNAL provider
// (RD / MyInvois / Peppol) records the submission as **`pending`** — the document is prepared and hashed but
// NOT transmitted — and NEVER a false `accepted` with a fabricated QR. Only the sandbox `stub` provider
// "accepts" locally, and it is explicitly flagged `sandbox:true` so it can't be mistaken for a real filing.
interface InvoiceDoc { doc_ref: string; seller?: string; buyer?: string; total?: number; currency?: string; lines?: any[] }

// The pluggable delivery leg. A real transport POSTs the prepared payload to the authority and returns its
// acknowledgement; a wired implementation would live behind this shape (keyed by provider). Result:
//  • accepted — the authority (or sandbox) acknowledged the filing (externalRef/qr may be set).
//  • pending  — no live transport for this provider yet; document prepared + hashed, awaiting transmission.
//  • rejected — the authority refused the document (detail carries the reason).
type SubmitStatus = 'accepted' | 'pending' | 'rejected';
interface TransportResult { status: SubmitStatus; externalRef?: string | null; qr?: string | null; sandbox?: boolean; detail: string }
// Shape of the JSON persisted in einvoice_submissions.response (typed so reads stay strongly typed).
interface StoredResponse { ref?: string; external_ref?: string | null; qr?: string | null; sandbox?: boolean; detail?: string | null }
interface EInvoiceTransport { deliver(doc: InvoiceDoc, payloadHash: string, internalRef: string): Promise<TransportResult> | TransportResult }

// Sandbox transport — the only one that acknowledges without a real authority. Clearly flagged so a caller
// (or an auditor reading the submissions log) can never confuse it with a genuine RD/LHDN/IRAS filing.
const SANDBOX_TRANSPORT: EInvoiceTransport = {
  deliver: (_doc, _hash, ref) => ({ status: 'accepted', externalRef: ref, qr: null, sandbox: true, detail: 'sandbox acknowledgement — not a real tax filing' }),
};
// Unconfigured external transport — fail-closed. A real provider selected but no live transport wired: the
// document is prepared and hashed (evidence it was built), but recorded `pending`, never `accepted`.
function unconfiguredTransport(provider: string): EInvoiceTransport {
  return { deliver: () => ({ status: 'pending', externalRef: null, qr: null, sandbox: false, detail: `${provider} transport not configured — document prepared and hashed, awaiting transmission to the tax authority` }) };
}
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

  // Resolve the delivery transport for a provider. Sandbox 'stub' acknowledges locally; every real provider
  // is fail-closed to `pending` until a genuine authority transport (credentials + endpoint) is wired here.
  private transportFor(provider: string): EInvoiceTransport {
    if (provider === 'stub') return SANDBOX_TRANSPORT;
    return unconfiguredTransport(provider);
  }

  async submit(user: JwtUser, doc: InvoiceDoc) {
    this.validate(doc);
    const db = this.db;
    const [exists] = await db.select().from(einvoiceSubmissions).where(eq(einvoiceSubmissions.docRef, doc.doc_ref)).limit(1);
    if (exists) { const er = (exists.response ?? {}) as StoredResponse; return { status: exists.status, ref: er.ref, qr: er.qr ?? null, external_ref: er.external_ref ?? null, sandbox: er.sandbox ?? false, detail: er.detail ?? null, provider: exists.provider, idempotent: true }; }
    const [cfg] = await db.select({ p: einvoiceConfig.providerKey }).from(einvoiceConfig).limit(1);
    const provider = cfg?.p ?? 'stub';
    const ref = `EINV-${createHash('sha1').update(`${user.tenantId}:${doc.doc_ref}`).digest('hex').slice(0, 12).toUpperCase()}`;
    // Prepare a country-appropriate document (MY → MyInvois UBL 2.1; SG → Peppol BIS3; others → JSON) and
    // hash it — this is real, provider-shaped work and stands as evidence the document was built, regardless
    // of whether a live transport then transmits it.
    let payloadSource: string;
    if (provider === 'einvoice.my.myinvois') payloadSource = buildMyInvoisXml(doc);
    else if (provider === 'einvoice.sg.invoicenow') payloadSource = buildSgPeppolXml(doc);
    else payloadSource = JSON.stringify(doc);
    const payloadHash = createHash('sha1').update(payloadSource).digest('hex').slice(0, 16);
    // Deliver via the provider's transport. Only a wired real transport (or the sandbox) can yield `accepted`;
    // an external provider with no transport records `pending` — the document is prepared, not transmitted.
    const result = await this.transportFor(provider).deliver(doc, payloadHash, ref);
    const response = { ref, external_ref: result.externalRef ?? null, qr: result.qr ?? null, sandbox: result.sandbox ?? false, detail: result.detail };
    await db.insert(einvoiceSubmissions).values({ tenantId: user.tenantId ?? null, docRef: doc.doc_ref, provider, status: result.status, payloadHash, response });
    return { status: result.status, ref, external_ref: result.externalRef ?? null, qr: result.qr ?? null, sandbox: result.sandbox ?? false, detail: result.detail, provider, idempotent: false };
  }

  async submissions(_user: JwtUser) {
    const rows = await this.db.select().from(einvoiceSubmissions);
    return { submissions: rows.map((row) => { const r = (row.response ?? {}) as StoredResponse; return { id: Number(row.id), doc_ref: row.docRef, provider: row.provider, status: row.status, ref: r.ref, sandbox: r.sandbox ?? false, detail: r.detail ?? null, submitted_at: row.submittedAt }; }) };
  }
}
