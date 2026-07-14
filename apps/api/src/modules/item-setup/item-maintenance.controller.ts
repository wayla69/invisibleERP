import { Controller, Get, Post, Body, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { PlatformAdmin, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ItemSetupService } from './item-setup.service';

const PurgeBody = z.object({ confirm: z.string().min(1).max(100) });

// God-only maintenance for the SHARED item master. `items` has no tenant_id, so factory-reset/purge (which
// clear only tenant_id-scoped tables) never touch it — a wiped company's catalogue rows survive and keep
// showing in every tenant's /shop. These routes garbage-collect the items NO tenant references any more.
//
// @PlatformAdmin (not a class-level tenant @Permissions) gates them purely to the platform owner AND keeps the
// FULL cross-tenant RLS bypass even when a god is scoped to one company via the act-as switcher — so
// "unreferenced" is computed across EVERY tenant, never per-company (which would wrongly delete another
// company's in-use items). Read the preview first; the destructive purge needs the typed confirm phrase.
@Controller('api/admin/item-maintenance')
export class ItemMaintenanceController {
  constructor(private readonly svc: ItemSetupService) {}

  @Get('unused-items') @PlatformAdmin()
  previewUnused(@CurrentUser() u: JwtUser) {
    return this.svc.previewUnusedItems(u);
  }

  @Post('purge-unused-items') @PlatformAdmin() @HttpCode(200)
  purgeUnused(@Body(new ZodValidationPipe(PurgeBody)) b: z.infer<typeof PurgeBody>, @CurrentUser() u: JwtUser) {
    return this.svc.purgeUnusedItems(u, b.confirm);
  }
}
