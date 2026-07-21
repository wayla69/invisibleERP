// Thai bank-transfer slip mini-QR parsing (slip-OCR pre-fill, docs/36 wave C UX).
// Every Thai banking-app slip carries a small QR whose payload follows the Bank-of-Thailand
// "Slip Verify" EMVCo-style TLV convention: 2-digit tag, 2-digit length, value — with the
// bank's TRANSACTION REFERENCE (the exact string the god verify queue checks against the bank
// statement) inside. Decoding it beats OCR: the reference is exact or absent, never misread.
// Bank apps differ in which tag carries the reference and some nest one TLV level down, so the
// parser collects candidates from BOTH levels and picks the most reference-shaped value.
// Pure + dependency-free: shared between the web claim form (client-side decode) and API tests.

export interface TlvField { tag: string; value: string }

/** Parse one level of 2-digit-tag / 2-digit-length TLV. Returns [] when the string is not TLV. */
export function parseTlv(payload: string): TlvField[] {
  const fields: TlvField[] = [];
  let i = 0;
  const s = String(payload ?? '');
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(s.slice(i + 2, i + 4)) || !Number.isInteger(len)) return [];
    const value = s.slice(i + 4, i + 4 + len);
    if (value.length !== len) return []; // truncated ⇒ not a (complete) TLV payload
    fields.push({ tag, value });
    i += 4 + len;
  }
  return i === s.length && fields.length > 0 ? fields : [];
}

const REF_SHAPE = /^[A-Za-z0-9]{10,40}$/;

/**
 * Extract the transfer reference from a decoded slip-QR payload.
 * Strategy: TLV-parse the top level and one nested level; among all values matching the
 * reference shape (10–40 alphanumerics — long enough to skip version/bank-id fields, and a
 * mixed-digit-letter value outranks digits-only), pick the best candidate. A payload that is
 * not TLV at all but IS itself reference-shaped is returned as-is (some apps encode the bare ref).
 */
export function slipTransferRef(payload: string): string | null {
  const raw = String(payload ?? '').trim();
  if (!raw) return null;
  const top = parseTlv(raw);
  if (top.length === 0) return REF_SHAPE.test(raw) ? raw : null;
  const candidates: string[] = [];
  for (const f of top) {
    const nested = parseTlv(f.value);
    if (nested.length > 0) {
      // A container that parses as TLV contributes its SUB-values only — the container string
      // itself is structure, not a reference (it would otherwise out-length the real ref).
      for (const sub of nested) if (REF_SHAPE.test(sub.value)) candidates.push(sub.value);
    } else if (REF_SHAPE.test(f.value)) {
      candidates.push(f.value);
    }
  }
  if (!candidates.length) return null;
  // Mixed alphanumeric beats digits-only (real transRefs mix both; digits-only 10+ runs are often
  // amounts/phone-length ids); longer beats shorter within the same class.
  const score = (v: string) => (/[A-Za-z]/.test(v) && /\d/.test(v) ? 100 : 0) + v.length;
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0] ?? null;
}
