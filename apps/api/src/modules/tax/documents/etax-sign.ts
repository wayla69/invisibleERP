// ETDA e-Tax Invoice — XAdES-BES enveloped signature over the UBL 2.1 instance document (etax-xml.ts).
//
// The RD/ETDA requires e-Tax invoices to carry a digital signature (ขมธอ.21-2562 / XAdES) made with a
// CA-issued certificate. This module produces a self-contained enveloped <ds:Signature> (XML-DSig +
// XAdES SignedProperties: SigningTime + SigningCertificate digest) and appends it inside the <Invoice>.
//
// Cert/key come from env (PEM, raw or base64) — see getSigningMaterial(). When no cert is configured the
// caller submits the unsigned instance document (back-compat with the mock/sandbox flow).
//
// Canonicalization is real W3C Exclusive XML Canonicalization (xml-exc-c14n, via xml-crypto's
// ExclusiveCanonicalization over a parsed @xmldom/xmldom DOM) — every digest (the enveloped document
// reference, the XAdES SignedProperties reference, and the SignedInfo that gets RSA-signed) is computed
// over the CANONICAL form, matching what a spec-compliant verifier (RD / an accredited validator) re-derives
// from the signed document, not over our own emitted byte string. Each digested fragment (SignedProperties,
// SignedInfo) declares its own xmlns bindings so it canonicalizes identically whether processed standalone
// (as here) or in place inside the final embedded <ds:Signature> — Exclusive C14N renders "visibly utilized"
// namespaces per-node regardless of ancestor context, which is exactly the property that makes this safe.
//
// What this does NOT provide: a real CA-issued certificate. getSigningMaterial() reads whatever PEM is
// configured via env — plugging in an accredited CA's issued cert/key there is a business/legal step (apply
// with a Thai NRCA-accredited CA, e.g. Thai Digital ID), not something this code can generate. Until a real
// cert is configured, getSigningMaterial() returns null and callers submit the unsigned instance document.
import { createSign, createVerify, createHash, X509Certificate } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { ExclusiveCanonicalization } from 'xml-crypto';

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

// Real Exclusive XML Canonicalization (W3C xml-exc-c14n) of an XML fragment string. The fragment must be a
// well-formed, self-contained document (its own root, with every namespace prefix it uses declared on
// itself) — true for every fragment we canonicalize here (see the file header note on why that's safe).
function canonicalize(xml: string): string {
  const errors: string[] = [];
  const doc = new DOMParser({
    errorHandler: (level: string, msg: string) => { if (level !== 'warning') errors.push(`${level}: ${msg}`); },
  }).parseFromString(xml, 'text/xml');
  if (errors.length || !doc?.documentElement) {
    throw new Error(`canonicalize: XML parse failed — ${errors.join('; ') || 'no document element'}`);
  }
  return new ExclusiveCanonicalization().process(doc.documentElement, {});
}

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

// xmlns:xades/xmlns:ds are declared here (redundant with the outer <ds:Signature> once embedded) so this
// fragment is self-contained and canonicalizes identically whether processed standalone (for the digest) or
// in place inside the final document — Exclusive C14N renders visibly-utilized namespaces per node.
function signedPropertiesXml(propsId: string, certPem: string, signingTime: string): string {
  const cert = new X509Certificate(certPem);
  const certDigest = sha256b64(Buffer.from(certDerBase64(certPem), 'base64'));
  return [
    `<xades:SignedProperties xmlns:xades="${XADES}" xmlns:ds="${DS}" Id="${propsId}">`,
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

// xmlns:ds declared on the root for the same standalone-canonicalization reason as signedPropertiesXml
// above. The enveloped reference chains TWO transforms — enveloped-signature (conceptually: drop the
// ds:Signature descendant) THEN exc-c14n — so the digested octets are the canonical form of the document
// minus the signature, matching what a verifier re-derives (a bare enveloped transform alone yields a
// node-set, not octets, which is under-specified for digesting without an explicit final canonicalization).
function signedInfoXml(docDigest: string, propsDigest: string, propsId: string): string {
  return [
    `<ds:SignedInfo xmlns:ds="${DS}">`,
    `<ds:CanonicalizationMethod Algorithm="${C14N}"/>`,
    `<ds:SignatureMethod Algorithm="${RSA_SHA256}"/>`,
    `<ds:Reference URI="">`,
    `<ds:Transforms><ds:Transform Algorithm="${ENVELOPED}"/><ds:Transform Algorithm="${C14N}"/></ds:Transforms>`,
    `<ds:DigestMethod Algorithm="${SHA256}"/>`,
    `<ds:DigestValue>${docDigest}</ds:DigestValue>`,
    `</ds:Reference>`,
    `<ds:Reference URI="#${propsId}" Type="${SIGNED_PROPS_TYPE}">`,
    `<ds:Transforms><ds:Transform Algorithm="${C14N}"/></ds:Transforms>`,
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

  // Enveloped reference: digest is over the CANONICAL form of the document with the signature removed —
  // at signing time that's simply the original (unsigned) xml, since no signature exists yet.
  const docDigest = sha256b64(canonicalize(xml));
  const signedProps = signedPropertiesXml(propsId, material.certPem, signingTime);
  const propsDigest = sha256b64(canonicalize(signedProps));
  const signedInfo = signedInfoXml(docDigest, propsDigest, propsId);

  // Per XML-DSig, SignedInfo is signed in its CANONICAL form (its own CanonicalizationMethod, exc-c14n) —
  // not the raw string we happened to emit it as.
  const signatureValue = createSign('RSA-SHA256').update(canonicalize(signedInfo)).sign(material.keyPem).toString('base64');

  const signature = [
    `<ds:Signature xmlns:ds="${DS}" xmlns:xades="${XADES}" Id="${sigId}">`,
    signedInfo,
    `<ds:SignatureValue>${signatureValue}</ds:SignatureValue>`,
    `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certDerBase64(material.certPem)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`,
    `<ds:Object><xades:QualifyingProperties Target="#${sigId}">${signedProps}</xades:QualifyingProperties></ds:Object>`,
    `</ds:Signature>`,
  ].join('');

  // No whitespace of our own between the signature and </Invoice>: a spec-compliant enveloped-signature
  // transform removes ONLY the <ds:Signature> element node from the parsed tree, leaving surrounding
  // whitespace exactly as it was — inserting our own extra separator here would leave a stray text node
  // behind after that removal, which would canonicalize differently than the pre-signing document we
  // digested above (this was a real interop bug: confirmed by an independent xml-crypto SignedXml
  // cross-check rejecting the signature before this fix, and accepting it after).
  return xml.slice(0, at) + signature + close;
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

  // Strip ONLY the signature substring (no extra whitespace was inserted around it — see signEtaxXml) →
  // recover the original doc, then re-derive the enveloped reference's digest the same way signing did:
  // canonicalize, then hash.
  const recovered = signedXml.replace(signature, '');

  const signedInfo = extractElement(signature, 'ds:SignedInfo');
  const signedProps = extractElement(signature, 'xades:SignedProperties');
  const sigValue = extractTag(signature, 'ds:SignatureValue');
  if (!signedInfo || !sigValue) return fail('malformed signature (missing SignedInfo/SignatureValue)');

  let docDigestOk = false, propsDigestOk = false, signatureOk = false;
  try {
    docDigestOk = extractTag(signature, 'ds:DigestValue') === sha256b64(canonicalize(recovered));

    // Second reference digests the SignedProperties.
    const propsDigests = [...signature.matchAll(/<ds:DigestValue>([^<]*)<\/ds:DigestValue>/g)].map((m) => m[1]);
    propsDigestOk = !!signedProps && propsDigests.includes(sha256b64(canonicalize(signedProps)));

    let certPem = certPemOverride;
    if (!certPem) {
      const der = extractTag(signature, 'ds:X509Certificate');
      if (!der) return fail('no certificate to verify against');
      certPem = `-----BEGIN CERTIFICATE-----\n${(der.match(/.{1,64}/g) ?? [der]).join('\n')}\n-----END CERTIFICATE-----\n`;
    }
    const pub = new X509Certificate(certPem).publicKey;
    signatureOk = createVerify('RSA-SHA256').update(canonicalize(signedInfo)).verify(pub, Buffer.from(sigValue, 'base64'));
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
