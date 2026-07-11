import { describe, it, expect, beforeAll } from 'vitest';
import { ThaiTaxProvider, ZeroTaxProvider } from '../src/modules/tax/tax-providers';
import { TaxService } from '../src/modules/tax/tax.service';
import { round2, getCurrency, isSupportedCurrency } from '../src/modules/tax/money';
import { DocNumberService } from '../src/common/doc-number.service';
import { buildPromptPayPayload, crc16ccitt, isValidPromptPayTarget } from '../src/modules/payments/promptpay-qr';
import { socialSecurity, annualPit, computePayslip } from '../src/modules/payroll/payroll-calc';
import { buildEtaxInvoiceXml } from '../src/modules/tax/documents/etax-xml';
import { EtaxEmailService, ETAX_TIMESTAMP_EMAIL } from '../src/modules/tax/documents/etax-email.service';
import { hmacSha256Hex, verifyWebhookSignature, verifyWebhookWithTimestamp } from '../src/common/crypto';
import { hitRateLimit } from '../src/common/rate-limit-store';
import { verifyInboundWebhook } from '../src/common/webhook-auth';
import { resolvePermissions, expandPermissions, detectSodConflicts, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

describe('e-Tax by Email composer (ETDA, no CA)', () => {
  // Stub TaxDocsPdfService — a plain unit test has no Chromium, and the point of this suite is the message
  // composition (recipients/subject/attachment), not PDF rendering itself (that's covered by pdf-render /
  // etax-email cutover harnesses). renderToPdf resolves null so compose() takes its HTML-fallback path.
  const fakePdf = {
    fullTaxInvoiceHtml: (inv: any) => `<html>ใบกำกับภาษี ${inv.doc_no}</html>`,
    abbreviatedTaxInvoiceHtml: (inv: any) => `<html>ใบกำกับภาษีอย่างย่อ ${inv.doc_no}</html>`,
    creditDebitNoteHtml: (inv: any) => `<html>${inv.doc_no}</html>`,
    renderToPdf: async () => null,
  } as unknown as import('../src/modules/tax/documents/tax-docs-pdf.service').TaxDocsPdfService;

  const svc = new EtaxEmailService(null as never, null as never, fakePdf, null as never);
  const inv = {
    doc_no: 'TIV-202606-0009', issue_date: '2026-06-22', currency: 'THB',
    seller: { name: 'ร้านโอชิเนอิ', tax_id: '0105551234567', address: 'กทม.' },
    buyer: { name: 'ลูกค้า' }, subtotal: 100, vat_rate: 0.07, vat_amount: 7, grand_total: 107,
    lines: [{ line_no: 1, description: 'อาหาร', amount: 100 }],
  };
  let msg: Awaited<ReturnType<typeof svc.compose>>;
  beforeAll(async () => { msg = await svc.compose(inv as never, 'shop@oshinei.co.th', 'buyer@example.com'); });

  it('CC goes to the ETDA time-stamp mailbox', () => expect(msg.cc).toBe(ETAX_TIMESTAMP_EMAIL));
  it('from seller → to buyer', () => { expect(msg.from).toBe('shop@oshinei.co.th'); expect(msg.to).toBe('buyer@example.com'); });
  it('subject carries the doc no', () => expect(msg.subject).toContain('TIV-202606-0009'));
  it('attaches the readable tax-invoice document, not the raw e-Tax XML (ETDA time-stamps the PDF/HTML, not the XML)', () => {
    expect(msg.attachments?.[0].filename).toBe('TIV-202606-0009.html');
    expect(String(msg.attachments?.[0].content)).toContain('TIV-202606-0009');
  });
});

describe('e-Tax Invoice XML (ETDA / UBL 2.1)', () => {
  const inv = {
    doc_no: 'TIV-202606-0001', type: 'full', issue_date: '2026-06-22', currency: 'THB',
    seller: { name: 'ร้าน A & B', tax_id: '0105551234567', branch_code: '00000', address: '1 ถนนสุข กทม.' },
    buyer: { name: 'ลูกค้า', tax_id: '0992001234567', branch_code: '00000', address: '2 ถนนดี' },
    subtotal: 100, vat_rate: 0.07, vat_amount: 7, grand_total: 107,
    lines: [{ line_no: 1, description: 'สินค้า <X>', qty: 2, uom: 'EA', unit_price: 50, amount: 100 }],
  };
  const xml = buildEtaxInvoiceXml(inv as never);
  it('declares XML + UBL Invoice root', () => {
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('<Invoice ');
    expect(xml).toContain('<cbc:UBLVersionID>2.1</cbc:UBLVersionID>');
  });
  it('carries doc id, dates, type 388, currency', () => {
    expect(xml).toContain('<cbc:ID>TIV-202606-0001</cbc:ID>');
    expect(xml).toContain('<cbc:IssueDate>2026-06-22</cbc:IssueDate>');
    expect(xml).toContain('>388</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cbc:DocumentCurrencyCode>THB</cbc:DocumentCurrencyCode>');
  });
  it('seller + buyer tax ids via PartyTaxScheme', () => {
    expect(xml).toContain('<cbc:CompanyID>0105551234567</cbc:CompanyID>');
    expect(xml).toContain('<cbc:CompanyID>0992001234567</cbc:CompanyID>');
  });
  it('tax total: 7% percent, taxable 100.00, tax 7.00; payable 107.00', () => {
    expect(xml).toContain('<cbc:Percent>7.00</cbc:Percent>');
    expect(xml).toContain('<cbc:TaxableAmount currencyID="THB">100.00</cbc:TaxableAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="THB">107.00</cbc:PayableAmount>');
  });
  it('line item + XML-escapes special chars', () => {
    expect(xml).toContain('<cac:InvoiceLine>');
    expect(xml).toContain('สินค้า &lt;X&gt;');     // < > escaped
    expect(xml).toContain('ร้าน A &amp; B');        // & escaped
    expect(xml).not.toContain('<X>');               // raw angle brackets must not leak
  });
});

describe('Payroll — Thai social security + PIT (ภ.ง.ด.1)', () => {
  it('SSO 5% capped at 750 (base ceiling 15,000)', () => {
    expect(socialSecurity(30000)).toEqual({ employee: 750, employer: 750 }); // capped
    expect(socialSecurity(10000)).toEqual({ employee: 500, employer: 500 }); // 5%
    expect(socialSecurity(12000)).toEqual({ employee: 600, employer: 600 });
    expect(socialSecurity(0)).toEqual({ employee: 0, employer: 0 });
    expect(socialSecurity(30000, false)).toEqual({ employee: 0, employer: 0 }); // not eligible
  });
  it('progressive annual PIT', () => {
    expect(annualPit(100000)).toBe(0);                 // under 150k
    expect(annualPit(191000)).toBe(2050);              // (191000-150000)*5%
    expect(annualPit(400000)).toBe(7500 + 10000);      // 150k@0 +150k@5%(7500) +100k@10%(10000) = 17500
  });
  it('payslip: 30,000 salary → SSO 750, WHT 170.83, net 29,079.17', () => {
    const s = computePayslip(30000);
    expect(s.gross).toBe(30000);
    expect(s.sso_employee).toBe(750);
    expect(s.sso_employer).toBe(750);
    expect(s.wht).toBe(170.83);                        // annual taxable 191k → 2050/12
    expect(s.net).toBe(29079.17);                      // 30000 - 750 - 170.83
  });
  it('payslip: low earner (12,000) → no WHT', () => {
    const s = computePayslip(12000);
    expect(s.sso_employee).toBe(600);
    expect(s.wht).toBe(0);                             // taxable below 150k
    expect(s.net).toBe(11400);                        // 12000 - 600
  });
});

describe('tax providers', () => {
  it('Thai VAT 7% on 100 = 7', () => {
    const r = new ThaiTaxProvider().calc({ net: 100 });
    expect(r.rate).toBe(0.07);
    expect(r.tax).toBe(7);
    expect(r.label).toContain('7');
  });
  it('Zero provider = 0', () => {
    expect(new ZeroTaxProvider().calc({ net: 999 }).tax).toBe(0);
  });
});

describe('TaxService (pluggable, no hard-coded VAT)', () => {
  const svc = new TaxService();
  it('resolves TH → VAT 7', () => expect(svc.calcTax({ net: 200, country: 'TH' }).tax).toBe(14));
  it('unknown country → zero (extensible registry)', () => expect(svc.calcTax({ net: 200, country: 'ZZ' }).tax).toBe(0));
});

describe('money / ISO-4217', () => {
  it('round2', () => expect(round2(1.239)).toBe(1.24));
  it('JPY has 0 minor units', () => expect(getCurrency('JPY').decimals).toBe(0));
  it('THB supported', () => expect(isSupportedCurrency('THB')).toBe(true));
});

describe('PromptPay QR (EMVCo)', () => {
  it('CRC16-CCITT standard check "123456789" → 29B1', () => expect(crc16ccitt('123456789')).toBe('29B1'));
  it('dynamic QR: header, AID, mobile-formatted, THB, amount, country, valid CRC', () => {
    const qr = buildPromptPayPayload('0801234567', 125.5);
    expect(qr.startsWith('000201')).toBe(true);     // payload format indicator
    expect(qr).toContain('010212');                 // dynamic (amount present)
    expect(qr).toContain('A000000677010111');       // PromptPay AID
    expect(qr).toContain('0066801234567');          // mobile → 0066 + number
    expect(qr).toContain('5303764');                // THB
    expect(qr).toContain('5406125.50');             // amount
    expect(qr).toContain('5802TH');                 // country
    expect(qr.slice(-4)).toBe(crc16ccitt(qr.slice(0, -4))); // CRC self-consistent
  });
  it('static QR (national ID, no amount): point-of-init 11, no amount tag', () => {
    const qr = buildPromptPayPayload('1234567890123');
    expect(qr).toContain('010211');                 // static
    expect(qr).not.toContain('5406');               // no amount tag
    expect(qr).toContain('02131234567890123');      // national-id sub-tag 02 + len 13
    expect(qr.slice(-4)).toBe(crc16ccitt(qr.slice(0, -4)));
  });
  it('target validation', () => {
    expect(isValidPromptPayTarget('0801234567')).toBe(true);
    expect(isValidPromptPayTarget('1234567890123')).toBe(true);
    expect(isValidPromptPayTarget('123')).toBe(false);
  });
});

describe('PSP webhook signature (C4 — HMAC-SHA256 over raw body)', () => {
  const secret = 'whsec_test_123';
  const body = Buffer.from(JSON.stringify({ provider: 'mock', provider_ref: 'r1', status: 'Captured' }));
  const sig = hmacSha256Hex(secret, body);
  it('accepts a correct bare-hex signature', () => expect(verifyWebhookSignature(secret, body, sig)).toBe(true));
  it('accepts the `sha256=` prefixed form', () => expect(verifyWebhookSignature(secret, body, `sha256=${sig}`)).toBe(true));
  it('rejects a tampered body', () => expect(verifyWebhookSignature(secret, Buffer.concat([body, Buffer.from('x')]), sig)).toBe(false));
  it('rejects a wrong secret', () => expect(verifyWebhookSignature('whsec_other', body, sig)).toBe(false));
  it('rejects a missing/garbage signature', () => {
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'not-hex!!')).toBe(false);
  });

  // security review L-1 — replay window via a signed timestamp.
  it('accepts a fresh timestamped signature and rejects a stale one (replay)', () => {
    const now = Math.floor(Date.now() / 1000);
    const tsSig = (ts: number) => hmacSha256Hex(secret, Buffer.concat([Buffer.from(`${ts}.`), body]));
    // fresh
    expect(verifyWebhookWithTimestamp(secret, body, tsSig(now), now, 300)).toBe('ok');
    // stale (10 min old, tolerance 5 min) → refused even though the signature is valid for that timestamp
    const old = now - 600;
    expect(verifyWebhookWithTimestamp(secret, body, tsSig(old), old, 300)).toBe('stale');
    // an attacker who freshens the timestamp but keeps the old signature fails the HMAC
    expect(verifyWebhookWithTimestamp(secret, body, tsSig(old), now, 300)).toBe('bad');
    // no timestamp → body-only back-compat path still works
    expect(verifyWebhookWithTimestamp(secret, body, sig, undefined, 300)).toBe('ok');
    expect(verifyWebhookWithTimestamp(secret, body, 'bad', undefined, 300)).toBe('bad');
  });
});

describe('Shared rate-limit store — in-memory fixed window (L-8, no Redis configured)', () => {
  it('allows up to max in a window, then limits; a fresh window resets', async () => {
    const key = `k-${Math.random()}`;
    const max = 3, win = 60_000, t0 = 1_000_000;
    // 3 hits within budget
    expect((await hitRateLimit(key, max, win, t0)).limited).toBe(false);
    expect((await hitRateLimit(key, max, win, t0 + 1)).limited).toBe(false);
    expect((await hitRateLimit(key, max, win, t0 + 2)).limited).toBe(false);
    // 4th in the same window → limited, with a positive retry-after
    const over = await hitRateLimit(key, max, win, t0 + 3);
    expect(over.limited).toBe(true);
    expect(over.retryAfter).toBeGreaterThan(0);
    // next window → reset
    expect((await hitRateLimit(key, max, win, t0 + win + 1)).limited).toBe(false);
  });
  it('keys are independent', async () => {
    const a = `a-${Math.random()}`, b = `b-${Math.random()}`, t = 2_000_000;
    await hitRateLimit(a, 1, 60_000, t);
    expect((await hitRateLimit(a, 1, 60_000, t + 1)).limited).toBe(true);  // a exhausted
    expect((await hitRateLimit(b, 1, 60_000, t + 1)).limited).toBe(false); // b independent
  });
});

describe('Inbound webhook auth — additive HMAC over static secret (L-2)', () => {
  const body = Buffer.from(JSON.stringify({ ext_event_id: 'e1', ext_order_id: 'o1', store_ref: 's1' }));
  it('static-secret fallback: matches / mismatches / unconfigured', () => {
    expect(verifyInboundWebhook({ staticSecret: 'sek', providedSecret: 'sek' })).toBe('ok');
    expect(verifyInboundWebhook({ staticSecret: 'sek', providedSecret: 'nope' })).toBe('bad');
    expect(verifyInboundWebhook({ staticSecret: 'sek', providedSecret: undefined })).toBe('bad');
    expect(verifyInboundWebhook({})).toBe('unconfigured');
  });
  it('HMAC takes precedence when configured — a valid static secret alone no longer passes', () => {
    const hmacSecret = 'whmac_1';
    const sig = hmacSha256Hex(hmacSecret, body);
    expect(verifyInboundWebhook({ rawBody: body, hmacSecret, signature: sig, staticSecret: 'sek', providedSecret: 'sek' })).toBe('ok');
    // right static secret but NO/!bad HMAC signature → rejected (the whole point: a leaked static secret can't forge a body)
    expect(verifyInboundWebhook({ rawBody: body, hmacSecret, signature: undefined, staticSecret: 'sek', providedSecret: 'sek' })).toBe('bad');
    // tampered body under the same signature → bad
    expect(verifyInboundWebhook({ rawBody: Buffer.concat([body, Buffer.from('x')]), hmacSecret, signature: sig })).toBe('bad');
  });
  it('HMAC + timestamp gives a replay window', () => {
    const hmacSecret = 'whmac_2';
    const now = Math.floor(Date.now() / 1000);
    const tsSig = (ts: number) => hmacSha256Hex(hmacSecret, Buffer.concat([Buffer.from(`${ts}.`), body]));
    expect(verifyInboundWebhook({ rawBody: body, hmacSecret, signature: tsSig(now), timestamp: now, toleranceSec: 300 })).toBe('ok');
    expect(verifyInboundWebhook({ rawBody: body, hmacSecret, signature: tsSig(now - 600), timestamp: now - 600, toleranceSec: 300 })).toBe('stale');
  });
});

describe('RBAC sub-permission expansion (backward compatibility)', () => {
  it("'pos' implies pos_sell / pos_refund / pos_till", () => {
    const e = expandPermissions(['pos']);
    expect(e).toContain('pos_sell'); expect(e).toContain('pos_refund'); expect(e).toContain('pos_till');
    expect(e).toContain('pos'); // coarse retained → legacy @Permissions('pos') still passes
  });
  it("'exec' implies gl_post / gl_close / recon_prep, 'masterdata' implies md_vendor", () => {
    const e = expandPermissions(['exec', 'masterdata']);
    for (const p of ['gl_post', 'gl_close', 'recon_prep', 'fin_report', 'md_vendor', 'md_item', 'md_config']) expect(e).toContain(p);
  });
  it('resolvePermissions expands role defaults (Sales has both pos and pos_sell)', () => {
    const p = resolvePermissions('Sales');
    expect(p).toContain('pos'); expect(p).toContain('pos_sell'); expect(p).toContain('gl_close');
  });
});

describe('Segregation of Duties — conflict detection (ITGC-AC-09)', () => {
  // Current (as-is) role design — documented conflict counts from the SoD matrix. Procurement was
  // remediated to a SoD-clean buying role (no longer bundles pay/approve/vendor-master) → 0 conflicts,
  // dropping the non-admin total from 18 to 14; Planner then remediated 2026-06-26 → 8.
  it('current roles produce the documented conflicts (total 8 non-admin)', () => {
    const c = (r: keyof typeof DEFAULT_ROLE_PERMISSIONS) => detectSodConflicts(DEFAULT_ROLE_PERMISSIONS[r]).length;
    expect(c('Sales')).toBe(7);
    expect(c('Procurement')).toBe(0);
    expect(c('Planner')).toBe(0);
    expect(c('Warehouse')).toBe(1);
    expect(c('Customer')).toBe(0);
    expect(c('Sales') + c('Procurement') + c('Planner') + c('Warehouse') + c('Customer')).toBe(8);
  });
  it('Admin is the inherent superuser (violates all 22 rules)', () => {
    expect(detectSodConflicts(resolvePermissions('Admin')).length).toBe(22);
  });
  it('shipped single-duty role DEFAULTS are SoD-clean (the redesign in action)', () => {
    const NEW = ['Cashier', 'PosSupervisor', 'ArClerk', 'ApClerk', 'Buyer', 'WarehouseOperator',
      'InventoryController', 'StockCounter', 'GlAccountant', 'FinancialController',
      'MasterDataAdmin', 'PricingManager', 'CreditManager', 'ReturnsClerk', 'AccessAdmin', 'ExecutiveViewer'] as const;
    for (const r of NEW) {
      expect({ r, n: detectSodConflicts(DEFAULT_ROLE_PERMISSIONS[r]).length }).toEqual({ r, n: 0 });
    }
  });
  it('proposed single-duty roles are SoD-clean (0 conflicts each)', () => {
    const TO_BE: Record<string, string[]> = {
      Cashier: ['pos_sell'],
      'POS Supervisor': ['pos_refund', 'pos_till'],
      'AR Clerk': ['ar', 'order_mgt', 'claim_mgt', 'delivery'],
      'AP Clerk': ['creditors'],
      Buyer: ['procurement'],
      'Warehouse Operator': ['wh_receive', 'wh_custody', 'lots', 'locations', 'mobile', 'images'],
      'Inventory Controller': ['wh_adjust'],
      'Stock Counter': ['wh_count'],
      'GL Accountant': ['gl_post', 'recon_prep', 'fin_report'],
      'Financial Controller': ['gl_close', 'approvals', 'fin_report'],
      'Master Data Admin': ['md_vendor', 'md_item', 'md_config', 'bom_master'],
      'Pricing Manager': ['pricelist', 'promos'],
      'CRM/Credit Manager': ['crm'],
      'Returns Clerk': ['returns'],
      'Access Administrator': ['users'],
      'Executive (read)': ['fin_report', 'dashboard', 'planner', 'marketing'],
      Customer: ['order_cust', 'cust_pos', 'cust_dash', 'loyalty', 'track'],
    };
    for (const [role, perms] of Object.entries(TO_BE)) {
      expect({ role, n: detectSodConflicts(perms as never).length }).toEqual({ role, n: 0 });
    }
  });
});

describe('DocNumberService formats', () => {
  const d = new DocNumberService(undefined as never);
  it('sales order SO-YYYYMMDD-HHMM', () => expect(d.nextSalesOrder(new Date('2026-06-21T09:30:00'))).toMatch(/^SO-\d{8}-\d{4}$/));
  it('tenant-stamped SALE-prefix', () => expect(d.nextTenantStamped('SALE', 'Oshinei')).toMatch(/^SALE-OSHI-\d{14}$/));
});
