import { Controller, Get, Post, Body, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { PlatformAdmin, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ItemSetupService } from './item-setup.service';

const PurgeBody = z.object({ confirm: z.string().min(1).max(100) });
const ForcePreviewBody = z.object({ item_ids: z.array(z.string().min(1).max(100)).max(5000).optional() });
// `expected_ref_rows` is the total_ref_rows the caller just read from force-preview — required, and
// re-checked server-side, so the destructive call cannot run without having seen its own blast radius.
const ForcePurgeBody = z.object({ item_ids: z.array(z.string().min(1).max(100)).max(5000).optional(), confirm: z.string().min(1).max(100), expected_ref_rows: z.number().int().min(0) });

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

  // FORCE purge — deletes products EVEN IF a company still uses them, wiping the references cross-tenant.
  // Four gates, because omitting `item_ids` targets the WHOLE catalogue: god-only, the ops kill switch
  // ALLOW_ITEM_FORCE_PURGE (fail-closed — 403 FORCE_PURGE_DISABLED), the strong confirm FORCE-PURGE-ITEMS,
  // and `expected_ref_rows` echoed from force-preview (409 BLAST_RADIUS_MISMATCH otherwise) — which makes the
  // preview genuinely mandatory instead of merely documented, and refuses if the catalogue moved underneath.
  @Post('force-preview') @PlatformAdmin() @HttpCode(200)
  forcePreview(@Body(new ZodValidationPipe(ForcePreviewBody)) b: z.infer<typeof ForcePreviewBody>, @CurrentUser() u: JwtUser) {
    return this.svc.forcePurgePreview(u, b.item_ids);
  }

  @Post('force-purge') @PlatformAdmin() @HttpCode(200)
  forcePurge(@Body(new ZodValidationPipe(ForcePurgeBody)) b: z.infer<typeof ForcePurgeBody>, @CurrentUser() u: JwtUser) {
    return this.svc.forcePurgeItems(u, b.item_ids, b.confirm, b.expected_ref_rows);
  }
}
