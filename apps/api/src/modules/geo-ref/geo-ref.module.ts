import { Module, Controller, Get, Query } from '@nestjs/common';
import { TH_PROVINCES, normalizeProvince } from '../../common/thai-address';
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
