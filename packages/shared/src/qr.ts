// Universal QR payload — shared between the label generator (api) and the
// scan-to-fill inputs (web). Ported from the legacy ERPPOS format:
//   ITEM_ID:P001|DESC:..|UOM:..|PRICE:..|CAT:..   (assets use ASSET_ID:..)

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

/** Parse `KEY:val|KEY:val`. A bare code with no delimiters is treated as an Item ID. */
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
