// Conservative mapper: vision-extracted invoice lines → 3-way-match line input (EXP-10 line-level round).
// Vision lines carry only free text (no internal item_id), so a line becomes match input ONLY on an
// unambiguous identity signal against the mapped PO's own lines:
//   • normalized description equality (same normalization as the vendor matcher), or
//   • the PO line's item_id appearing as a whole token in the description.
// ALL-OR-NOTHING: if any line fails to map uniquely (or lacks qty/price), the whole set is rejected and
// the caller falls back to today's header-level match — the mapper can only ESCALATE precision, never
// degrade the existing verdict path. Pure + exported for unit tests.

export interface VisionLine { description: string | null; qty: number | null; unit_price: number | null; amount: number | null }
export interface PoLineRef { item_id: string; item_description: string | null }
export interface MappedMatchLine { item_id: string; qty: number; unit_price: number }

const normText = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9ก-๙]/g, '');
const tokens = (s: string | null | undefined) => (s ?? '').toUpperCase().split(/[^A-Z0-9ก-๙]+/).filter(Boolean);

export function mapVisionLinesToPo(lines: VisionLine[] | null | undefined, poLines: PoLineRef[]): MappedMatchLine[] | undefined {
  if (!Array.isArray(lines) || lines.length === 0 || poLines.length === 0) return undefined;
  const mapped: MappedMatchLine[] = [];
  const claimed = new Set<string>();
  for (const l of lines) {
    const qty = l.qty ?? null;
    const price = l.unit_price ?? null;
    if (qty == null || !(qty > 0) || price == null || !(price >= 0)) return undefined;
    const dNorm = normText(l.description);
    const dTokens = new Set(tokens(l.description));
    const hits = poLines.filter((p) =>
      (dNorm && normText(p.item_description) === dNorm) || dTokens.has(p.item_id.toUpperCase()));
    if (hits.length !== 1) return undefined; // ambiguous or unidentified → whole set falls back
    const target = hits[0]!;
    if (claimed.has(target.item_id)) return undefined; // two vision lines claiming one PO line
    claimed.add(target.item_id);
    mapped.push({ item_id: target.item_id, qty, unit_price: price });
  }
  return mapped;
}
