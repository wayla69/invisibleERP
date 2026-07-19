// Thai address standardization (master-data audit Phase 7). A canonical reference of Thailand's 77 provinces
// (จังหวัด) with Thai + English names, plus normalisation/validation helpers, so an address's province is
// stored in ONE canonical form instead of the free-text variance that wrecks dedup, reporting and shipping
// integrations ("กรุงเทพ" / "กรุงเทพฯ" / "กทม" / "Bangkok" all collapse to "กรุงเทพมหานคร"). This is the
// authoritative province list; sub-district/tambon-level validation would need a ~7,000-row dataset and is
// intentionally out of scope here — province canonicalisation + postal-format validation is the high-value,
// low-risk core (mirrors how Oracle anchors on a validated region reference).
import { nameSimilarity, normalizeKey } from './text-similarity';
import { THAI_SUBDISTRICTS_TSV } from './thai-subdistricts.data';

export interface Province { th: string; en: string }

// ── Subdistrict (tambon/khwaeng) reference — postal-code-driven address autofill ──────────────────
// A full Thailand administrative dataset (province → district → subdistrict + postal code) parsed once,
// lazily, from the AUTO-GENERATED tab-separated data module. It powers the address forms' "type a postal
// code → pick the matching เขต/แขวง" dropdown (one postal code usually maps to several subdistricts).
export interface Subdistrict {
  postalCode: string;
  provinceTh: string; provinceEn: string;
  districtTh: string; districtEn: string;
  subdistrictTh: string; subdistrictEn: string;
}

let _rows: Subdistrict[] | null = null;
let _byPostal: Map<string, Subdistrict[]> | null = null;

function rows(): Subdistrict[] {
  if (_rows) return _rows;
  const out: Subdistrict[] = [];
  for (const line of THAI_SUBDISTRICTS_TSV.split('\n')) {
    if (!line) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    out.push({
      postalCode: f[0]!, provinceTh: f[1]!, provinceEn: f[2]!,
      districtTh: f[3]!, districtEn: f[4]!, subdistrictTh: f[5]!, subdistrictEn: f[6]!,
    });
  }
  _rows = out;
  return out;
}

function byPostal(): Map<string, Subdistrict[]> {
  if (_byPostal) return _byPostal;
  const m = new Map<string, Subdistrict[]>();
  for (const r of rows()) {
    const bucket = m.get(r.postalCode);
    if (bucket) bucket.push(r);
    else m.set(r.postalCode, [r]);
  }
  _byPostal = m;
  return m;
}

/** All subdistricts (with their district + province) that share a five-digit postal code. Empty if none. */
export function lookupPostalCode(code: string | null | undefined): Subdistrict[] {
  const c = (code ?? '').trim();
  if (!/^\d{5}$/.test(c)) return [];
  return byPostal().get(c) ?? [];
}

/** Distinct provinces present in the subdistrict dataset (Thai + English), sorted by Thai name. */
export function subdistrictProvinces(): Province[] {
  const seen = new Map<string, Province>();
  for (const r of rows()) if (!seen.has(r.provinceTh)) seen.set(r.provinceTh, { th: r.provinceTh, en: r.provinceEn });
  return [...seen.values()].sort((a, b) => a.th.localeCompare(b.th, 'th'));
}

/** Distinct districts (อำเภอ/เขต) of a province, by canonical Thai province name. */
export function districtsOfProvince(provinceTh: string): { th: string; en: string }[] {
  const seen = new Map<string, { th: string; en: string }>();
  for (const r of rows()) if (r.provinceTh === provinceTh && !seen.has(r.districtTh)) seen.set(r.districtTh, { th: r.districtTh, en: r.districtEn });
  return [...seen.values()].sort((a, b) => a.th.localeCompare(b.th, 'th'));
}

/** Subdistricts (ตำบล/แขวง) of a district within a province, each carrying its postal code. */
export function subdistrictsOfDistrict(provinceTh: string, districtTh: string): { th: string; en: string; postalCode: string }[] {
  return rows()
    .filter((r) => r.provinceTh === provinceTh && r.districtTh === districtTh)
    .map((r) => ({ th: r.subdistrictTh, en: r.subdistrictEn, postalCode: r.postalCode }))
    .sort((a, b) => a.th.localeCompare(b.th, 'th'));
}

// 77 provinces (19 central · 7 east · 20 northeast · 17 north · 14 south). Bangkok is the special
// administrative area กรุงเทพมหานคร.
export const TH_PROVINCES: Province[] = [
  { th: 'กรุงเทพมหานคร', en: 'Bangkok' }, { th: 'สมุทรปราการ', en: 'Samut Prakan' }, { th: 'นนทบุรี', en: 'Nonthaburi' },
  { th: 'ปทุมธานี', en: 'Pathum Thani' }, { th: 'พระนครศรีอยุธยา', en: 'Phra Nakhon Si Ayutthaya' }, { th: 'อ่างทอง', en: 'Ang Thong' },
  { th: 'ลพบุรี', en: 'Lopburi' }, { th: 'สิงห์บุรี', en: 'Sing Buri' }, { th: 'ชัยนาท', en: 'Chai Nat' }, { th: 'สระบุรี', en: 'Saraburi' },
  { th: 'นครนายก', en: 'Nakhon Nayok' }, { th: 'สมุทรสาคร', en: 'Samut Sakhon' }, { th: 'สมุทรสงคราม', en: 'Samut Songkhram' },
  { th: 'นครปฐม', en: 'Nakhon Pathom' }, { th: 'สุพรรณบุรี', en: 'Suphan Buri' }, { th: 'กาญจนบุรี', en: 'Kanchanaburi' },
  { th: 'ราชบุรี', en: 'Ratchaburi' }, { th: 'เพชรบุรี', en: 'Phetchaburi' }, { th: 'ประจวบคีรีขันธ์', en: 'Prachuap Khiri Khan' },
  { th: 'ฉะเชิงเทรา', en: 'Chachoengsao' }, { th: 'ปราจีนบุรี', en: 'Prachin Buri' }, { th: 'สระแก้ว', en: 'Sa Kaeo' },
  { th: 'ชลบุรี', en: 'Chon Buri' }, { th: 'ระยอง', en: 'Rayong' }, { th: 'จันทบุรี', en: 'Chanthaburi' }, { th: 'ตราด', en: 'Trat' },
  { th: 'นครราชสีมา', en: 'Nakhon Ratchasima' }, { th: 'บุรีรัมย์', en: 'Buriram' }, { th: 'สุรินทร์', en: 'Surin' },
  { th: 'ศรีสะเกษ', en: 'Sisaket' }, { th: 'อุบลราชธานี', en: 'Ubon Ratchathani' }, { th: 'ยโสธร', en: 'Yasothon' },
  { th: 'ชัยภูมิ', en: 'Chaiyaphum' }, { th: 'อำนาจเจริญ', en: 'Amnat Charoen' }, { th: 'หนองบัวลำภู', en: 'Nong Bua Lamphu' },
  { th: 'ขอนแก่น', en: 'Khon Kaen' }, { th: 'อุดรธานี', en: 'Udon Thani' }, { th: 'เลย', en: 'Loei' }, { th: 'หนองคาย', en: 'Nong Khai' },
  { th: 'มหาสารคาม', en: 'Maha Sarakham' }, { th: 'ร้อยเอ็ด', en: 'Roi Et' }, { th: 'กาฬสินธุ์', en: 'Kalasin' },
  { th: 'สกลนคร', en: 'Sakon Nakhon' }, { th: 'นครพนม', en: 'Nakhon Phanom' }, { th: 'มุกดาหาร', en: 'Mukdahan' }, { th: 'บึงกาฬ', en: 'Bueng Kan' },
  { th: 'เชียงใหม่', en: 'Chiang Mai' }, { th: 'ลำพูน', en: 'Lamphun' }, { th: 'ลำปาง', en: 'Lampang' }, { th: 'อุตรดิตถ์', en: 'Uttaradit' },
  { th: 'แพร่', en: 'Phrae' }, { th: 'น่าน', en: 'Nan' }, { th: 'พะเยา', en: 'Phayao' }, { th: 'เชียงราย', en: 'Chiang Rai' },
  { th: 'แม่ฮ่องสอน', en: 'Mae Hong Son' }, { th: 'นครสวรรค์', en: 'Nakhon Sawan' }, { th: 'อุทัยธานี', en: 'Uthai Thani' },
  { th: 'กำแพงเพชร', en: 'Kamphaeng Phet' }, { th: 'ตาก', en: 'Tak' }, { th: 'สุโขทัย', en: 'Sukhothai' }, { th: 'พิษณุโลก', en: 'Phitsanulok' },
  { th: 'พิจิตร', en: 'Phichit' }, { th: 'เพชรบูรณ์', en: 'Phetchabun' }, { th: 'นครศรีธรรมราช', en: 'Nakhon Si Thammarat' },
  { th: 'กระบี่', en: 'Krabi' }, { th: 'พังงา', en: 'Phang Nga' }, { th: 'ภูเก็ต', en: 'Phuket' }, { th: 'สุราษฎร์ธานี', en: 'Surat Thani' },
  { th: 'ระนอง', en: 'Ranong' }, { th: 'ชุมพร', en: 'Chumphon' }, { th: 'สงขลา', en: 'Songkhla' }, { th: 'สตูล', en: 'Satun' },
  { th: 'ตรัง', en: 'Trang' }, { th: 'พัทลุง', en: 'Phatthalung' }, { th: 'ปัตตานี', en: 'Pattani' }, { th: 'ยะลา', en: 'Yala' },
  { th: 'นราธิวาส', en: 'Narathiwat' },
];

// Common Thai variants that don't match a name outright (esp. Bangkok).
const ALIASES: Record<string, string> = {
  'กรุงเทพ': 'กรุงเทพมหานคร', 'กรุงเทพฯ': 'กรุงเทพมหานคร', 'กทม': 'กรุงเทพมหานคร', 'กทม.': 'กรุงเทพมหานคร', 'bkk': 'กรุงเทพมหานคร',
};

/** A Thai postal code is exactly five digits. */
export function isValidPostalCode(code: string): boolean {
  return /^\d{5}$/.test(code);
}

/**
 * Canonicalise a free-text province to its official Thai name, or return null if unrecognised (caller keeps
 * the original + can flag it). Matches on Thai name, English name, known aliases, then a fuzzy fallback so
 * minor spelling/spacing differences still resolve.
 */
export function normalizeProvince(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim().replace(/^จังหวัด\s*/, '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const key = normalizeKey(raw);
  if (ALIASES[raw]) return ALIASES[raw];
  if (ALIASES[key]) return ALIASES[key];
  for (const p of TH_PROVINCES) {
    if (raw === p.th || key === normalizeKey(p.en)) return p.th;
  }
  let best: { th: string; score: number } | null = null;
  for (const p of TH_PROVINCES) {
    const score = Math.max(nameSimilarity(raw, p.th), nameSimilarity(raw, p.en));
    if (!best || score > best.score) best = { th: p.th, score };
  }
  return best && best.score >= 0.8 ? best.th : null;
}
