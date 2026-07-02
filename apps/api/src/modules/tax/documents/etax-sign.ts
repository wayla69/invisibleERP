// ETDA e-Tax Invoice — XAdES-BES enveloped signature over the UBL 2.1 instance document (etax-xml.ts).
//
// The RD/ETDA requires e-Tax invoices to carry a digital signature (ขมธอ.21-2562 / XAdES) made with a
// CA-issued certificate. This module produces a self-contained enveloped <ds:Signature> (XML-DSig +
// XAdES SignedProperties: SigningTime + SigningCertificate digest) and appends it inside the <Invoice>.
//
// Cert/key come from env (PEM, raw or base64) — see getSigningMaterial(). When no cert is configured the
// caller submits the unsigned instance document (back-compat with the mock/sandbox flow).
//
// ⚠️ Canonicalization is a deterministic byte-serialization of the exact strings we emit — sign and
// verify here are self-consistent. Full interop with the RD validator additionally needs certified
// Exclusive XML C14N (xml-exc-c14n) over the parsed DOM; that is layered in with the production cert +
// HSM. This is the signing scaffold, not a substitute for the accredited signing appliance.
import { createSign, createVerify, createHash, X509Certificate } from 'node:crypto';

export interface SigningMaterial {
  keyPem: string;
  certPem: string;
}

const DS = 'http://www.w3.org/2000/09/xmldsig#';
const XADES = 'http://uri.etsi.org/01903/v1.3.2#';
const C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const SIGNED_PROPS_TYPE = 'http://uri.etsi.org/01903#SignedProperties';

const sha256b64 = (s: string | Buffer): string => createHash('sha256').update(s).digest('base64');

// Strip PEM armour + whitespace → base64 DER (one line), for <ds:X509Certificate> and cert digest.
function certDerBase64(certPem: string): string {
  return certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
}

// Read a PEM value from env: prefer the raw PEM (newlines may be encoded as \n), fall back to base64.
function readPem(raw: string | undefined, b64: string | undefined): string | null {
  if (raw && raw.includes('-----BEGIN')) return raw.replace(/\\n/g, '\n');
  if (b64 && b64.trim()) {
    try {
      const s = Buffer.from(b64.trim(), 'base64').toString('utf8');
      if (s.includes('-----BEGIN')) return s;
    } catch {
      /* not valid base64 — fall through */
    }
  }
  return null;
}

// Signing key + certificate from the environment, or null when e-Tax signing is not configured.
//   ETAX_SIGNING_KEY_PEM / ETAX_SIGNING_KEY_PEM_B64   — RSA private key (PEM)
//   ETAX_SIGNING_CERT_PEM / ETAX_SIGNING_CERT_PEM_B64 — X.509 certificate (PEM)
export function getSigningMaterial(env: NodeJS.ProcessEnv = process.env): SigningMaterial | null {
  const keyPem = readPem(env.ETAX_SIGNING_KEY_PEM, env.ETAX_SIGNING_KEY_PEM_B64);
  const certPem = readPem(env.ETAX_SIGNING_CERT_PEM, env.ETAX_SIGNING_CERT_PEM_B64);
  if (!keyPem || !certPem) return null;
  return { keyPem, certPem };
}

function signedPropertiesXml(propsId: string, certPem: string, signingTime: string): string {
  const cert = new X509Certificate(certPem);
  const certDigest = sha256b64(Buffer.from(certDerBase64(certPem), 'base64'));
  return [
    `<xades:SignedProperties Id="${propsId}">`,
    `<xades:SignedSignatureProperties>`,
    `<xades:SigningTime>${signingTime}</xades:SigningTime>`,
    `<xades:SigningCertificate>`,
    `<xades:Cert>`,
    `<xades:CertDigest>`,
    `<ds:DigestMethod Algorithm="${SHA256}"/>`,
    `<ds:DigestValue>${certDigest}</ds:DigestValue>`,
    `</xades:CertDigest>`,
    `<xades:IssuerSerial>`,
    `<ds:X509IssuerName>${escapeXml(cert.issuer.replace(/\n/g, ', '))}</ds:X509IssuerName>`,
    `<ds:X509SerialNumber>${serialDecimal(cert.serialNumber)}</ds:X509SerialNumber>`,
    `</xades:IssuerSerial>`,
    `</xades:Cert>`,
    `</xades:SigningCertificate>`,
    `</xades:SignedSignatureProperties>`,
    `</xades:SignedProperties>`,
  ].join('');
}

function signedInfoXml(docDigest: string, propsDigest: string, propsId: string): string {
  return [
    `<ds:SignedInfo>`,
    `<ds:CanonicalizationMethod Algorithm="${C14N}"/>`,
    `<ds:SignatureMethod Algorithm="${RSA_SHA256}"/>`,
    `<ds:Reference URI="">`,
    `<ds:Transforms><ds:Transform Algorithm="${ENVELOPED}"/></ds:Transforms>`,
    `<ds:DigestMethod Algorithm="${SHA256}"/>`,
    `<ds:DigestValue>${docDigest}</ds:DigestValue>`,
    `</ds:Reference>`,
    `<ds:Reference URI="#${propsId}" Type="${SIGNED_PROPS_TYPE}">`,
    `<ds:DigestMethod Algorithm="${SHA256}"/>`,
    `<ds:DigestValue>${propsDigest}</ds:DigestValue>`,
    `</ds:Reference>`,
    `</ds:SignedInfo>`,
  ].join('');
}

// Append an enveloped XAdES signature inside the <Invoice> root. Returns the signed document.
export function signEtaxXml(
  xml: string,
  material: SigningMaterial,
  opts?: { signingTime?: string; signatureId?: string },
): string {
  const close = '</Invoice>';
  const at = xml.lastIndexOf(close);
  if (at < 0) throw new Error('signEtaxXml: document is not a UBL <Invoice> (no </Invoice>)');

  const sigId = opts?.signatureId ?? 'sig-etax';
  const propsId = `${sigId}-signedprops`;
  const signingTime = opts?.signingTime ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Enveloped reference: digest is over the document with the signature removed → the original xml.
  const docDigest = sha256b64(xml);
  const signedProps = signedPropertiesXml(propsId, material.certPem, signingTime);
  const propsDigest = sha256b64(signedProps);
  const signedInfo = signedInfoXml(docDigest, propsDigest, propsId);

  const signatureValue = createSign('RSA-SHA256').update(signedInfo).sign(material.keyPem).toString('base64');

  const signature = [
    `<ds:Signature xmlns:ds="${DS}" xmlns:xades="${XADES}" Id="${sigId}">`,
    signedInfo,
    `<ds:SignatureValue>${signatureValue}</ds:SignatureValue>`,
    `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certDerBase64(material.certPem)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`,
    `<ds:Object><xades:QualifyingProperties Target="#${sigId}">${signedProps}</xades:QualifyingProperties></ds:Object>`,
    `</ds:Signature>`,
  ].join('');

  return xml.slice(0, at) + signature + '\n' + close;
}

export interface VerifyResult {
  valid: boolean;
  docDigestOk: boolean;
  signatureOk: boolean;
  propsDigestOk: boolean;
  reason?: string;
}

// Verify a signed e-Tax document. Uses the embedded X509Certificate unless a certPem override is given.
export function verifyEtaxSignature(signedXml: string, certPemOverride?: string): VerifyResult {
  const fail = (reason: string): VerifyResult => ({ valid: false, docDigestOk: false, signatureOk: false, propsDigestOk: false, reason });
  const sigMatch = signedXml.match(/<ds:Signature\b[\s\S]*?<\/ds:Signature>/);
  if (!sigMatch) return fail('no <ds:Signature> element');
  const signature = sigMatch[0];

  // Strip the signature (and the single newline we inserted before </Invoice>) → recover the original doc.
  const recovered = signedXml.replace(signature + '\n', '');
  const docDigestOk = extractTag(signature, 'ds:DigestValue') === sha256b64(recovered);

  const signedInfo = extractElement(signature, 'ds:SignedInfo');
  const signedProps = extractElement(signature, 'xades:SignedProperties');
  const sigValue = extractTag(signature, 'ds:SignatureValue');
  if (!signedInfo || !sigValue) return fail('malformed signature (missing SignedInfo/SignatureValue)');

  // Second reference digests the SignedProperties.
  const propsDigests = [...signature.matchAll(/<ds:DigestValue>([^<]*)<\/ds:DigestValue>/g)].map((m) => m[1]);
  const propsDigestOk = !!signedProps && propsDigests.includes(sha256b64(signedProps));

  let certPem = certPemOverride;
  if (!certPem) {
    const der = extractTag(signature, 'ds:X509Certificate');
    if (!der) return fail('no certificate to verify against');
    certPem = `-----BEGIN CERTIFICATE-----\n${(der.match(/.{1,64}/g) ?? [der]).join('\n')}\n-----END CERTIFICATE-----\n`;
  }

  let signatureOk = false;
  try {
    const pub = new X509Certificate(certPem).publicKey;
    signatureOk = createVerify('RSA-SHA256').update(signedInfo).verify(pub, Buffer.from(sigValue, 'base64'));
  } catch (e) {
    return fail(`verify error: ${(e as Error).message}`);
  }

  return { valid: docDigestOk && signatureOk && propsDigestOk, docDigestOk, signatureOk, propsDigestOk };
}

// ── small XML helpers (the documents are emitted by us, so exact-substring extraction is sufficient) ──
function extractElement(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`);
  const m = xml.match(re);
  return m ? m[0] : null;
}
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`);
  const m = xml.match(re);
  return m ? m[1]! : null;
}
function escapeXml(v: string): string {
  return v.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string));
}
// node returns the serial as hex; RD/X509SerialNumber expects the decimal integer.
function serialDecimal(hex: string): string {
  try {
    return BigInt(`0x${hex}`).toString(10);
  } catch {
    return hex;
  }
}
