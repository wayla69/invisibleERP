// Governed bank master (master-data audit Phase 9). A canonical reference of Thai banks (BOT bank codes +
// Thai/English names) so a vendor's payee bank_name is chosen/normalised to one canonical value instead of
// free-typed ("กสิกร" / "KBANK" / "Kasikorn" → "ธนาคารกสิกรไทย"). Mirrors the province reference (Phase 7).
import { nameSimilarity, normalizeKey } from './text-similarity';

export interface Bank { code: string; th: string; en: string; alias?: string[] }

export const TH_BANKS: Bank[] = [
  { code: '002', th: 'ธนาคารกรุงเทพ', en: 'Bangkok Bank', alias: ['bbl'] },
  { code: '004', th: 'ธนาคารกสิกรไทย', en: 'Kasikornbank', alias: ['kbank', 'kasikorn'] },
  { code: '006', th: 'ธนาคารกรุงไทย', en: 'Krung Thai Bank', alias: ['ktb'] },
  { code: '011', th: 'ธนาคารทหารไทยธนชาต', en: 'TMBThanachart Bank', alias: ['ttb', 'tmb', 'thanachart'] },
  { code: '014', th: 'ธนาคารไทยพาณิชย์', en: 'Siam Commercial Bank', alias: ['scb'] },
  { code: '025', th: 'ธนาคารกรุงศรีอยุธยา', en: 'Bank of Ayudhya', alias: ['bay', 'krungsri'] },
  { code: '069', th: 'ธนาคารเกียรตินาคินภัทร', en: 'Kiatnakin Phatra Bank', alias: ['kkp'] },
  { code: '022', th: 'ธนาคารซีไอเอ็มบีไทย', en: 'CIMB Thai Bank', alias: ['cimb', 'cimbt'] },
  { code: '067', th: 'ธนาคารทิสโก้', en: 'TISCO Bank', alias: ['tisco'] },
  { code: '024', th: 'ธนาคารยูโอบี', en: 'United Overseas Bank (Thai)', alias: ['uob', 'uobt'] },
  { code: '071', th: 'ธนาคารไทยเครดิต', en: 'Thai Credit Bank', alias: ['tcd'] },
  { code: '073', th: 'ธนาคารแลนด์ แอนด์ เฮ้าส์', en: 'Land and Houses Bank', alias: ['lhbank', 'lhfg'] },
  { code: '070', th: 'ธนาคารไอซีบีซี (ไทย)', en: 'ICBC (Thai)', alias: ['icbc', 'icbct'] },
  { code: '098', th: 'ธนาคารพัฒนาวิสาหกิจขนาดกลางและขนาดย่อม', en: 'SME Development Bank', alias: ['sme'] },
  { code: '034', th: 'ธนาคารเพื่อการเกษตรและสหกรณ์การเกษตร', en: 'Bank for Agriculture and Agricultural Cooperatives', alias: ['baac', 'ธกส'] },
  { code: '035', th: 'ธนาคารเพื่อการส่งออกและนำเข้าแห่งประเทศไทย', en: 'Export-Import Bank of Thailand', alias: ['exim'] },
  { code: '030', th: 'ธนาคารออมสิน', en: 'Government Savings Bank', alias: ['gsb'] },
  { code: '033', th: 'ธนาคารอาคารสงเคราะห์', en: 'Government Housing Bank', alias: ['ghb', 'ธอส'] },
  { code: '066', th: 'ธนาคารอิสลามแห่งประเทศไทย', en: 'Islamic Bank of Thailand', alias: ['ibank', 'isbt'] },
];

/** Canonicalise a free-text bank name to its official Thai name, or null if unrecognised. */
export function normalizeBank(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim().replace(/^ธนาคาร\s*/, '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const key = normalizeKey(raw);
  for (const b of TH_BANKS) {
    if (raw === b.th || key === normalizeKey(b.th) || key === normalizeKey(b.en) || key === b.code || (b.alias ?? []).some((a) => normalizeKey(a) === key)) return b.th;
  }
  let best: { th: string; score: number } | null = null;
  for (const b of TH_BANKS) {
    const score = Math.max(nameSimilarity(raw, b.th), nameSimilarity(raw, b.en));
    if (!best || score > best.score) best = { th: b.th, score };
  }
  return best && best.score >= 0.82 ? best.th : null;
}
