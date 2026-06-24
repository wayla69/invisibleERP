/**
 * C2b — e-Tax Invoice XAdES signing. Build the UBL 2.1 document, append an enveloped XAdES signature
 * with a (runtime-generated, self-signed) certificate, and prove the signature verifies and is
 * tamper-evident. Pure crypto — no DB/Nest needed.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover etax-sign
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEtaxInvoiceXml } from '../../../apps/api/dist/modules/tax-docs/etax-xml';
import { getSigningMaterial, signEtaxXml, verifyEtaxSignature } from '../../../apps/api/dist/modules/tax-docs/etax-sign';

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

function selfSignedPem(): { keyPem: string; certPem: string } {
  const dir = mkdtempSync(join(tmpdir(), 'etax-sign-'));
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=eTax Test Signer/O=Oshinei ERP/C=TH'], { stdio: 'ignore' });
  return { keyPem: readFileSync(key, 'utf8'), certPem: readFileSync(cert, 'utf8') };
}

const SAMPLE = {
  doc_no: 'TIV-202606-0042', type: 'full', issue_date: '2026-06-24', currency: 'THB',
  seller: { name: 'บริษัท ทดสอบ จำกัด', tax_id: '0105551234567', branch_code: '00000', address: '1 ถนนสุขุมวิท กรุงเทพฯ' },
  buyer: { name: 'ลูกค้า A&B', tax_id: '0992001234567', branch_code: '00000', address: '99 พระราม 9' },
  subtotal: 300, discount: 0, vat_rate: 0.07, vat_amount: 21, grand_total: 321,
  lines: [
    { line_no: 1, description: 'ค่าบริการ <ที่ปรึกษา>', qty: 1, uom: 'EA', unit_price: 200, amount: 200 },
    { line_no: 2, description: 'สินค้าตัวอย่าง', qty: 2, uom: 'EA', unit_price: 50, amount: 100 },
  ],
};

function main() {
  let openssl = true;
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { openssl = false; }
  if (!openssl) { console.error('openssl not available — cannot generate a test certificate'); process.exit(1); }

  const { keyPem, certPem } = selfSignedPem();
  const xml = buildEtaxInvoiceXml(SAMPLE as never);

  // ── 1. getSigningMaterial reads env (raw PEM + base64), null when unset ──
  const saved = { k: process.env.ETAX_SIGNING_KEY_PEM, c: process.env.ETAX_SIGNING_CERT_PEM, kb: process.env.ETAX_SIGNING_KEY_PEM_B64, cb: process.env.ETAX_SIGNING_CERT_PEM_B64 };
  delete process.env.ETAX_SIGNING_KEY_PEM; delete process.env.ETAX_SIGNING_CERT_PEM; delete process.env.ETAX_SIGNING_KEY_PEM_B64; delete process.env.ETAX_SIGNING_CERT_PEM_B64;
  ok('getSigningMaterial → null when no cert configured', getSigningMaterial() === null);
  process.env.ETAX_SIGNING_KEY_PEM = keyPem;
  process.env.ETAX_SIGNING_CERT_PEM_B64 = Buffer.from(certPem, 'utf8').toString('base64');
  const mat = getSigningMaterial();
  ok('getSigningMaterial → material from raw key PEM + base64 cert', !!mat && mat.keyPem.includes('PRIVATE KEY') && mat.certPem.includes('CERTIFICATE'));
  Object.assign(process.env, { ETAX_SIGNING_KEY_PEM: saved.k, ETAX_SIGNING_CERT_PEM: saved.c, ETAX_SIGNING_KEY_PEM_B64: saved.kb, ETAX_SIGNING_CERT_PEM_B64: saved.cb });

  // ── 2. signing appends an enveloped XAdES signature inside <Invoice> ──
  const signed = signEtaxXml(xml, { keyPem, certPem }, { signingTime: '2026-06-24T03:15:00Z' });
  ok('signed doc still a well-formed <Invoice> with <ds:Signature> before </Invoice>',
    signed.startsWith('<?xml') && signed.trimEnd().endsWith('</Invoice>') && signed.includes('<ds:Signature ') && signed.indexOf('<ds:Signature ') < signed.lastIndexOf('</Invoice>'),
    `head=${signed.slice(0, 14)}`);

  // ── 3. XAdES SignedProperties present (SigningTime + SigningCertificate digest) + embedded cert ──
  ok('XAdES QualifyingProperties: SigningTime + SigningCertificate + embedded X509Certificate',
    signed.includes('<xades:QualifyingProperties') && signed.includes('<xades:SigningTime>2026-06-24T03:15:00Z</xades:SigningTime>') &&
    signed.includes('<xades:SigningCertificate>') && signed.includes('<xades:CertDigest>') && /<ds:X509Certificate>[A-Za-z0-9+/=]+<\/ds:X509Certificate>/.test(signed));

  // ── 4. SignedInfo references the document (enveloped) + the SignedProperties ──
  ok('SignedInfo: enveloped doc reference + SignedProperties reference (RSA-SHA256)',
    signed.includes('Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"') &&
    signed.includes('Type="http://uri.etsi.org/01903#SignedProperties"') &&
    signed.includes('Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"'));

  // ── 5. signature verifies (digest + RSA + props), using the embedded cert ──
  const v = verifyEtaxSignature(signed);
  ok('verify (embedded cert) → valid: docDigestOk + signatureOk + propsDigestOk', v.valid && v.docDigestOk && v.signatureOk && v.propsDigestOk, JSON.stringify(v));

  // ── 6. verifies against an explicitly-supplied cert too ──
  ok('verify with supplied cert PEM → valid', verifyEtaxSignature(signed, certPem).valid);

  // ── 7. tamper the BODY (change an amount) → digest mismatch, invalid ──
  const tamperedBody = signed.replace('>321.00<', '>999.00<');
  const vb = verifyEtaxSignature(tamperedBody);
  ok('tampered amount → docDigestOk=false, invalid (tamper-evident)', tamperedBody !== signed && !vb.docDigestOk && !vb.valid, JSON.stringify(vb));

  // ── 8. tamper the SIGNATURE VALUE → signature mismatch, invalid ──
  const sv = signed.match(/<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/)![1];
  const flipped = sv[0] === 'A' ? 'B' + sv.slice(1) : 'A' + sv.slice(1);
  const tamperedSig = signed.replace(sv, flipped);
  const vs = verifyEtaxSignature(tamperedSig);
  ok('tampered SignatureValue → signatureOk=false, invalid', !vs.signatureOk && !vs.valid, JSON.stringify({ signatureOk: vs.signatureOk }));

  // ── 9. wrong cert (a different key pair) → signature does not verify ──
  const other = selfSignedPem();
  ok('verify with a DIFFERENT cert → signatureOk=false', !verifyEtaxSignature(signed, other.certPem).signatureOk);

  console.log('\n── C2b — e-Tax XAdES signing (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} e-Tax signing checks failed` : `\n✅ All ${checks.length} e-Tax signing checks passed`);
  process.exit(failed ? 1 : 0);
}
main();
