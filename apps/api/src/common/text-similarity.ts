// Master-data duplicate detection (master-data audit Phase 5 — DQM). App-side fuzzy matching: pg_trgm is
// NOT enabled in this deployment (no CREATE EXTENSION in any migration, and the PGlite control harness does
// not bundle it), so name similarity is computed in application code. Master-data volumes are thousands of
// rows per tenant, so an O(n²) in-memory pass is fine — this is not a hot path. Dice coefficient over
// character trigrams (the same shape pg_trgm's similarity() uses), with a NFKC-normalised, punctuation- and
// legal-suffix-stripped key so "บริษัท เอ จำกัด" and "เอ Co., Ltd." collapse toward each other.

// Common company/legal suffixes (TH + EN) stripped before comparison so they don't inflate similarity for
// two unrelated companies (both ending "จำกัด") nor deflate it for the same company written two ways.
const LEGAL_SUFFIXES = [
  'บริษัท', 'จำกัด', 'มหาชน', 'หจก', 'ห้างหุ้นส่วนจำกัด', 'ห้างหุ้นส่วนสามัญ',
  'company', 'limited', 'ltd', 'co', 'inc', 'incorporated', 'corp', 'corporation', 'plc', 'llc', 'llp', 'pcl',
];

export function normalizeName(s: string | null | undefined): string {
  let n = (s ?? '').toLowerCase().normalize('NFKC');
  // Drop punctuation, KEEPING combining marks (\p{M}) — Thai vowels/tone marks (◌ิ ◌ำ ◌ั …) are Mark,
  // not Letter, so without \p{M} 'บริษัท' shredded to 'บร ษ ท', the Thai legal-suffix strip never matched,
  // and Thai-vs-English variants of the same company scored ~0.2 instead of 1 (found by the 2.4 unit suite).
  n = n.replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ');
  n = n.replace(/\s+/g, ' ').trim();
  for (const suf of LEGAL_SUFFIXES) {
    // NFKC-normalize the suffix too: the input's สระอำ (U+0E33) decomposes to ◌ํ+า under NFKC, so a
    // composed 'จำกัด' constant would never match the normalized text (2.4 unit-suite finding).
    n = n.replace(new RegExp(`(^|\\s)${suf.toLowerCase().normalize('NFKC')}(\\s|$)`, 'g'), ' ');
  }
  return n.replace(/\s+/g, ' ').trim();
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const g = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) g.add(padded.slice(i, i + 3));
  return g;
}

/** Dice-coefficient trigram similarity in [0,1] over normalised names. 1 = identical after normalisation. */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ga = trigrams(na), gb = trigrams(nb);
  let inter = 0;
  for (const t of ga) if (gb.has(t)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

/** A cheap exact-key normaliser for phone/email/tax-id equality signals (strip spaces/dashes, lowercase). */
export function normalizeKey(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[\s\-().]/g, '').trim();
}
