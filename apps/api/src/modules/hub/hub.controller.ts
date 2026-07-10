import { Body, Controller, Get, Headers, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { HubSyncService } from './hub-sync.service';
import { Permissions, CurrentUser, Public, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

// Store-hub sync surface (docs/41 Phases 1–2). Everything is fail-closed behind HUB_SYNC_SECRET.
// - GET  snapshot        (branch/exec)  — signed export to seed a hub; `?include_credentials=1`
//                                         additionally requires the X-Hub-Sync-Key header.
// - POST ingest          (@Public+HMAC) — machine-to-machine sales replay from a hub (BRANCH-04);
//                                         idempotent target, so replayed batches only yield duplicates.
// - GET  reconciliation  (branch/exec)  — BRANCH-04 detective tie-out of hub-ingested sales.
const IngestLine = z.object({ sku: z.string().optional(), menu_item_id: z.number().int().optional(), qty: z.number().positive(), modifier_option_ids: z.array(z.number().int()).optional(), notes: z.string().optional() });
const IngestSale = z.object({
  client_uuid: z.string().min(1), device_id: z.string().optional(), client_seq: z.number().int().optional(),
  captured_at: z.string().min(1), lines: z.array(IngestLine), method: z.string().optional(),
  discount_pct: z.number().min(0).max(100).optional(), discount: z.number().nonnegative().optional(),
  tip: z.number().nonnegative().optional(), service_charge_pct: z.number().min(0).max(100).optional(),
  // Phase 2b: buffet-tier sale — cloud re-prices the per-pax charge from ITS package master
  buffet: z.object({ package_code: z.string().min(1), pax: z.number().int().positive(), overtime_pax: z.number().int().nonnegative().optional() }).optional(),
}).refine((s) => s.lines.length > 0 || !!s.buffet, { message: 'a sale needs lines or a buffet charge' });
const IngestBody = z.object({ tenant_id: z.number().int().positive(), sent_at: z.string().min(1), sales: z.array(IngestSale), signature: z.string().min(1) });
type IngestDto = z.infer<typeof IngestBody>;

@Controller('api/hub')
export class HubController {
  constructor(private readonly svc: HubSyncService) {}

  @Get('snapshot') @Permissions('branch', 'exec')
  snapshot(
    @CurrentUser() user: JwtUser,
    @Query('include_credentials') includeCredentials?: string,
    @Headers('x-hub-sync-key') syncKey?: string,
  ) {
    return this.svc.exportSnapshot(user, {
      includeCredentials: includeCredentials === '1' || includeCredentials === 'true',
      syncKey: syncKey ?? null,
    });
  }

  @Public() @Post('ingest')
  ingest(@Body(new ZodValidationPipe(IngestBody)) body: IngestDto) {
    return this.svc.ingest(body);
  }

  @Get('reconciliation') @Permissions('branch', 'exec')
  reconciliation(@CurrentUser() user: JwtUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.reconciliation(user, from, to);
  }
}
