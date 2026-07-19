// Unit-pyramid extension (2.4 — docs/27 R2-5 unit-test lane): the pure common/ helpers that master-data
// dedup, address canonicalisation, DB-error mapping and every business date derive from. All four modules
// join the vitest coverage include list with this suite.
import { describe, expect, it, afterEach } from 'vitest';
import { normalizeName, nameSimilarity, normalizeKey } from '../src/common/text-similarity';
import {
  normalizeProvince, isValidPostalCode, TH_PROVINCES,
  lookupPostalCode, subdistrictProvinces, districtsOfProvince, subdistrictsOfDistrict,
} from '../src/common/thai-address';
import { pgError, pgErrorCode, isUniqueViolation } from '../src/common/db-error';
import { bizParts, bizYmdCompact, bizYmdDash, bizStamp, bizHourMin } from '../src/common/bizdate';

describe('text-similarity', () => {
  it('normalizeName strips punctuation + legal suffixes (TH + EN) and collapses whitespace', () => {
    expect(normalizeName('บริษัท เอ จำกัด')).toBe('เอ');
    expect(normalizeName('A Co., Ltd.')).toBe('a');
    expect(normalizeName('  Acme   CORP ')).toBe('acme');
    expect(normalizeName(null)).toBe('');
  });

  it('nameSimilarity: 1 for same company written two ways, low for unrelated names', () => {
    expect(nameSimilarity('บริษัท เอ จำกัด', 'เอ Co., Ltd.')).toBe(1);
    expect(nameSimilarity('Acme Trading', 'Acme Trading Co., Ltd.')).toBeGreaterThan(0.8);
    expect(nameSimilarity('บริษัท ก้าวหน้า จำกัด', 'บริษัท ถอยหลัง จำกัด')).toBeLessThan(0.5);
    expect(nameSimilarity('', 'anything')).toBe(0);
    expect(nameSimilarity(null, undefined)).toBe(0);
  });

  it('normalizeKey strips separators (space/dash/paren/dot) for exact-key equality (phone/tax-id)', () => {
    expect(normalizeKey('02-123 4567')).toBe('021234567');
    expect(normalizeKey('(0) 2.123')).toBe('02123');
    expect(normalizeKey('  A@B.COM ')).toBe('a@bcom'); // dots stripped by design — equality signal, not display
    expect(normalizeKey(null)).toBe('');
  });
});

describe('thai-address', () => {
  it('canonicalises Bangkok variants to กรุงเทพมหานคร', () => {
    for (const v of ['กรุงเทพ', 'กรุงเทพฯ', 'กทม', 'กทม.', 'bkk', 'Bangkok', 'กรุงเทพมหานคร']) {
      expect(normalizeProvince(v)).toBe('กรุงเทพมหานคร');
    }
  });

  it('matches Thai name, English name, จังหวัด prefix, and fuzzy near-misses', () => {
    expect(normalizeProvince('เชียงใหม่')).toBe('เชียงใหม่');
    expect(normalizeProvince('Chiang Mai')).toBe('เชียงใหม่');
    expect(normalizeProvince('จังหวัด ชลบุรี')).toBe('ชลบุรี');
    expect(normalizeProvince('chiangmai')).toBe('เชียงใหม่'); // spacing variance → alias/fuzzy path
  });

  it('returns null for unrecognised input (caller keeps the original + flags it)', () => {
    expect(normalizeProvince('Atlantis')).toBeNull();
    expect(normalizeProvince('')).toBeNull();
    expect(normalizeProvince(null)).toBeNull();
  });

  it('has exactly 77 provinces and validates 5-digit postal codes', () => {
    expect(TH_PROVINCES.length).toBe(77);
    expect(isValidPostalCode('10110')).toBe(true);
    expect(isValidPostalCode('1011')).toBe(false);
    expect(isValidPostalCode('10110a')).toBe(false);
  });
});

describe('thai subdistrict reference (postal-code autofill)', () => {
  it('maps a postal code to its subdistrict(s) with district + province', () => {
    const m = lookupPostalCode('50000'); // เมืองเชียงใหม่
    expect(m.length).toBeGreaterThan(0);
    expect(m.every((r) => r.provinceTh === 'เชียงใหม่' && r.districtTh === 'เมืองเชียงใหม่')).toBe(true);
    expect(m.every((r) => r.subdistrictTh && r.subdistrictEn && r.postalCode === '50000')).toBe(true);
  });

  it('returns empty for malformed / unknown postal codes', () => {
    expect(lookupPostalCode('abc')).toEqual([]);
    expect(lookupPostalCode('999')).toEqual([]);
    expect(lookupPostalCode('00000')).toEqual([]);
    expect(lookupPostalCode(null)).toEqual([]);
  });

  it('cascades province → districts → subdistricts (each carrying its postal code)', () => {
    const provinces = subdistrictProvinces();
    expect(provinces.length).toBe(77);
    const districts = districtsOfProvince('เชียงใหม่');
    expect(districts.length).toBeGreaterThan(20); // Chiang Mai has 25 districts
    const subs = subdistrictsOfDistrict('เชียงใหม่', 'เมืองเชียงใหม่');
    expect(subs.length).toBeGreaterThan(0);
    expect(subs.every((s) => /^\d{5}$/.test(s.postalCode))).toBe(true);
  });
});

describe('db-error (drizzle 0.45 .cause chain)', () => {
  const driverErr = { code: '23505', constraint: 'ux_je_idem', detail: 'Key exists.' };

  it('recovers the SQLSTATE error from a wrapped DrizzleQueryError (.cause chain)', () => {
    const wrapped = Object.assign(new Error('Failed query'), { code: 'DRIZZLE', cause: Object.assign(new Error('dup'), driverErr) });
    expect(pgErrorCode(wrapped)).toBe('23505');
    expect(pgError(wrapped)?.constraint).toBe('ux_je_idem');
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('matches an unwrapped driver error on the first hop (0.36 compatibility)', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), driverErr))).toBe(true);
  });

  it('non-SQLSTATE codes and non-errors yield undefined / false', () => {
    expect(pgErrorCode(new Error('plain'))).toBeUndefined();
    expect(pgError({ code: 'NOTASQLSTATE' })).toBeUndefined();
    expect(isUniqueViolation(null)).toBe(false);
    // bounded walk: a self-referencing cause chain terminates
    const cyc: any = new Error('cyc'); cyc.cause = cyc;
    expect(pgErrorCode(cyc)).toBeUndefined();
  });
});

describe('bizdate (business timezone — Asia/Bangkok fixed offset)', () => {
  afterEach(() => { delete process.env.BUSINESS_TZ_OFFSET_MIN; });

  it('a UTC evening is already the NEXT business day in Bangkok (+7)', () => {
    const d = new Date('2026-07-08T18:30:45Z'); // 01:30:45 on 09 Jul in Bangkok
    expect(bizYmdDash(d)).toBe('2026-07-09');
    expect(bizYmdCompact(d)).toBe('20260709');
    expect(bizStamp(d)).toBe('20260709013045');
    expect(bizHourMin(d)).toBe('0130');
    expect(bizParts(d)).toEqual({ y: 2026, mo: 7, d: 9, h: 1, mi: 30, s: 45 });
  });

  it('a UTC morning stays the same business day', () => {
    expect(bizYmdDash(new Date('2026-07-08T05:00:00Z'))).toBe('2026-07-08');
  });

  it('BUSINESS_TZ_OFFSET_MIN overrides the offset (no-DST regions)', () => {
    process.env.BUSINESS_TZ_OFFSET_MIN = '0';
    expect(bizYmdDash(new Date('2026-07-08T18:30:45Z'))).toBe('2026-07-08');
  });
});
