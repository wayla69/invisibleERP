import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, Public, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ChannelAdapterService } from './channel-adapter.service';

const AdapterBody = z.object({ id: z.number().optional(), platform: z.string().min(1), store_ref: z.string().optional(), enabled: z.boolean().optional(), auto_accept: z.boolean().optional(), config: z.record(z.any()).optional() });
const StatusBody = z.object({ status: z.string().min(1) });
// Aggregator payloads vary per platform, so this is a minimal shape guard: reject anything that is not a
// JSON object (array/string/null) before the per-platform normalizer runs. (Signature/secret verification
// for inbound aggregator webhooks remains a separate follow-up — see the C4 PSP pattern.)
const WebhookPayload = z.object({}).passthrough();

@Controller('api/channels')
@Permissions('pos', 'order_mgt', 'exec')
export class ChannelAdapterController {
  constructor(private readonly svc: ChannelAdapterService) {}

  @Get('adapters') list() { return this.svc.listAdapters(); }
  @Post('adapters') upsert(@Body(new ZodValidationPipe(AdapterBody)) b: z.infer<typeof AdapterBody>, @CurrentUser() u: JwtUser) { return this.svc.upsertAdapter(b, u); }
  @Post(':platform/menu-sync') menuSync(@Param('platform') p: string, @CurrentUser() u: JwtUser) { return this.svc.menuSyncOut(p, u); }
  @Get('orders') orders(@Query('limit') limit?: string) { return this.svc.listChannelOrders(limit ? +limit : 50); }
  @Post('orders/:orderNo/status') status(@Param('orderNo') no: string, @Body(new ZodValidationPipe(StatusBody)) b: z.infer<typeof StatusBody>) { return this.svc.updateStatus(no, b.status); }
}

// Inbound aggregator webhook — PUBLIC (platform calls it). Idempotent on ext_event_id.
@Controller('api/channels')
export class ChannelWebhookController {
  constructor(private readonly svc: ChannelAdapterService) {}

  @Public()
  @Post(':platform/webhook')
  webhook(@Param('platform') platform: string, @Body(new ZodValidationPipe(WebhookPayload)) payload: z.infer<typeof WebhookPayload>) { return this.svc.ingestWebhook(platform, payload); }
}
