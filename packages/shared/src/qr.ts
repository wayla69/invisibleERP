// Universal QR payload — shared between the label generator (api) and the
// scan-to-fill inputs (web). Ported from the legacy ERPPOS format:
//   ITEM_ID:P001|DESC:..|UOM:..|PRICE:..|CAT:..   (assets use ASSET_ID:..)
//
// Two carriers are supported so the SAME code works with any reader:
//   • raw text  — `ITEM_ID:P001|…` (hardware wedge scanner, or the in-app camera scanner)
//   • deep link — `https://<host>/q?d=<url-encoded raw payload>` (a phone's *native* camera
//                 opens the URL → the `/q` resolver page). `parseQrPayload` transparently
//                 unwraps the `d`/`code`/`payload` query param, so downstream parsing is identical.

export interface QrPayload {
  ITEM_ID?: string;
  ASSET_ID?: string;
  DESC?: string;
  UOM?: string;
  PRICE?: string;
  CAT?: string;
  LOC?: string;
  [k: string]: string | undefined;
}

/** If `text` is a deep-link URL carrying the payload in a `d`/`code`/`payload` query param,
 *  return the decoded raw payload; otherwise return the text unchanged. Works for absolute
 *  and relative URLs (matches on the query, so no URL base is required). */
export function unwrapQrUrl(text: string | null | undefined): string {
  const s = String(text ?? '').trim();
  if (!s) return '';
  const m = /[?&#](?:d|code|payload)=([^&#]+)/i.exec(s);
  const g = m?.[1];
  if (g) {
    try {
      return decodeURIComponent(g.replace(/\+/g, ' ')).trim();
    } catch {
      return g.trim();
    }
  }
  return s;
}

/** Parse `KEY:val|KEY:val` (unwrapping a deep-link URL first). A bare code with no
 *  delimiters is treated as an Item ID. */
export function parseQrPayload(text: string | null | undefined): QrPayload {
  const out: QrPayload = {};
  const s = unwrapQrUrl(text);
  if (!s) return out;
  if (s.includes('|') || s.includes(':')) {
    for (const part of s.split('|')) {
      const i = part.indexOf(':');
      if (i > 0) out[part.slice(0, i).trim().toUpperCase()] = part.slice(i + 1).trim();
    }
  }
  if (out.ITEM_ID == null && out.ASSET_ID == null && s && !s.includes(':')) out.ITEM_ID = s;
  return out;
}

/** Resolve a scanned code to its best single identifier — the Item ID, else the Asset ID,
 *  else a bare delimiter-less code. Used by scan-to-fill inputs so an `ASSET_ID:`-prefixed
 *  (or bare) tag isn't silently dropped. */
export function scanCodeId(text: string | null | undefined): string | undefined {
  const p = parseQrPayload(text);
  const id = (p.ITEM_ID || p.ASSET_ID || '').trim();
  return id || undefined;
}

/** Strip trailing '/' with a linear scan (a `/\/+$/` regex is a polynomial-ReDoS sink on
 *  uncontrolled input — CodeQL js/polynomial-redos). */
export function stripTrailingSlashes(s: string | null | undefined): string {
  const str = String(s ?? '');
  let end = str.length;
  while (end > 0 && str.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return str.slice(0, end);
}

/** Build the deep-link URL that a printed QR encodes when a web base URL is configured:
 *  `<base>/q?d=<url-encoded payload>`. With no base, callers encode the raw payload instead. */
export function qrLink(base: string, payload: string): string {
  return `${stripTrailingSlashes(base)}/q?d=${encodeURIComponent(payload)}`;
}

export function buildItemQrPayload(p: {
  itemId: string;
  desc?: string;
  uom?: string;
  price?: string | number;
  cat?: string;
}): string {
  return [
    `ITEM_ID:${p.itemId}`,
    `DESC:${(p.desc ?? '').slice(0, 30)}`,
    `UOM:${p.uom ?? ''}`,
    `PRICE:${p.price ?? ''}`,
    `CAT:${p.cat ?? ''}`,
  ].join('|');
}

export function buildAssetQrPayload(p: {
  assetNo: string;
  name?: string;
  loc?: string;
  cat?: string;
}): string {
  return [
    `ASSET_ID:${p.assetNo}`,
    `DESC:${(p.name ?? '').slice(0, 30)}`,
    `LOC:${p.loc ?? ''}`,
    `CAT:${p.cat ?? ''}`,
  ].join('|');
}
