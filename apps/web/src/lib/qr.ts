// Parse a scanned universal QR payload (ITEM_ID:..|DESC:..|UOM:..) for scan-to-fill.
// Mirrors @ierp/shared parseQrPayload; kept local so web has no extra workspace dep.
export interface QrPayload { ITEM_ID?: string; ASSET_ID?: string; DESC?: string; UOM?: string; [k: string]: string | undefined }

export function parseQrPayload(text: string | null | undefined): QrPayload {
  const out: QrPayload = {};
  if (!text) return out;
  const s = String(text).trim();
  if (s.includes('|') || s.includes(':')) {
    for (const part of s.split('|')) {
      const i = part.indexOf(':');
      if (i > 0) out[part.slice(0, i).trim().toUpperCase()] = part.slice(i + 1).trim();
    }
  }
  if (out.ITEM_ID == null && out.ASSET_ID == null && s && !s.includes(':')) out.ITEM_ID = s;
  return out;
}
