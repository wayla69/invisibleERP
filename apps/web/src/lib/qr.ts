// Parse a scanned universal QR payload (ITEM_ID:..|DESC:..|UOM:..) for scan-to-fill.
// Mirrors @ierp/shared parseQrPayload; kept local so web has no extra workspace dep.
// A scanned code arrives as either the raw payload (hardware wedge / in-app camera scanner)
// or a deep-link URL `…/q?d=<encoded payload>` (a phone's native camera) — unwrapQrUrl handles both.
export interface QrPayload { ITEM_ID?: string; ASSET_ID?: string; DESC?: string; UOM?: string; LOC?: string; CAT?: string; PRICE?: string; [k: string]: string | undefined }

/** If `text` carries the payload in a `d`/`code`/`payload` query param, return the decoded raw payload. */
export function unwrapQrUrl(text: string | null | undefined): string {
  const s = String(text ?? '').trim();
  if (!s) return '';
  const m = /[?&#](?:d|code|payload)=([^&#]+)/i.exec(s);
  const g = m?.[1];
  if (g) {
    try { return decodeURIComponent(g.replace(/\+/g, ' ')).trim(); } catch { return g.trim(); }
  }
  return s;
}

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

/** Best single identifier for a scanned code: Item ID, else Asset ID, else a bare code.
 *  Prevents an `ASSET_ID:`-prefixed (or bare) tag from being silently dropped by scan-to-fill. */
export function scanCodeId(text: string | null | undefined): string | undefined {
  const p = parseQrPayload(text);
  const id = (p.ITEM_ID || p.ASSET_ID || '').trim();
  return id || undefined;
}
