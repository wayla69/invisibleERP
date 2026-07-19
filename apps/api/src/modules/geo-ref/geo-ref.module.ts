import { Module, Controller, Get, Param, Query } from '@nestjs/common';
import {
  TH_PROVINCES, normalizeProvince,
  lookupPostalCode, subdistrictProvinces, districtsOfProvince, subdistrictsOfDistrict,
} from '../../common/thai-address';
import { TH_BANKS, normalizeBank } from '../../common/thai-banks';

// Thai geography reference (master-data audit Phase 7). Read-only canonical data — the 77-province list that
// address forms bind to, so province is chosen/normalised to one canonical value instead of free-typed. No
// @Permissions: reference data available to any authenticated user (mirrors other lookup lists).
@Controller('api/geo')
export class GeoRefController {
  @Get('provinces')
  provinces() {
    return { provinces: TH_PROVINCES, count: TH_PROVINCES.length };
  }

  // Canonicalise a free-text province (used by the UI to confirm/repair an entered value).
  @Get('normalize-province')
  normalize(@Query('q') q: string | undefined) {
    const canonical = normalizeProvince(q);
    return { input: q ?? null, canonical, recognized: canonical != null };
  }

  // Postal-code → the subdistrict(s)/district/province it covers (a code usually spans several
  // subdistricts). Drives the address form's "type รหัสไปรษณีย์ → pick เขต/แขวง" autofill.
  @Get('postal/:code')
  postal(@Param('code') code: string) {
    const matches = lookupPostalCode(code);
    return { code, matches, count: matches.length };
  }

  // Cascade fallback (choose without knowing the postal code): provinces → districts → subdistricts.
  @Get('address/provinces')
  addressProvinces() {
    const provinces = subdistrictProvinces();
    return { provinces, count: provinces.length };
  }

  @Get('address/districts')
  addressDistricts(@Query('province') province: string | undefined) {
    const districts = province ? districtsOfProvince(province) : [];
    return { province: province ?? null, districts, count: districts.length };
  }

  @Get('address/subdistricts')
  addressSubdistricts(@Query('province') province: string | undefined, @Query('district') district: string | undefined) {
    const subdistricts = province && district ? subdistrictsOfDistrict(province, district) : [];
    return { province: province ?? null, district: district ?? null, subdistricts, count: subdistricts.length };
  }

  // Governed bank master (Phase 9) — the canonical Thai-banks list the vendor bank dialog binds to.
  @Get('banks')
  banks() {
    return { banks: TH_BANKS, count: TH_BANKS.length };
  }

  @Get('normalize-bank')
  normalizeBank(@Query('q') q: string | undefined) {
    const canonical = normalizeBank(q);
    return { input: q ?? null, canonical, recognized: canonical != null };
  }
}

@Module({ controllers: [GeoRefController] })
export class GeoRefModule {}
