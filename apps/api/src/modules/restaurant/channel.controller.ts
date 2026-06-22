import { Controller, Get, Post, Param, Body, Headers } from '@nestjs/common';
import { z } from 'zod';
import { Public, NoTx } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ChannelOrderService } from './channel-order.service';

const ItemInput = z.object({
  sku: z.string().optional(), menu_item_id: z.number().int().optional(), modifier_option_ids: z.array(z.number().int()).optional(),
  name: z.string().optional(), unit_price: z.number().nonnegative().optional(), station_code: z.string().optional(),
  qty: z.number().positive().default(1), notes: z.string().optional(),
}).refine((it) => it.sku != null || it.menu_item_id != null || (it.name != null && it.unit_price != null), { message: 'provide sku/menu_item_id or name+unit_price' });

const PublicOrderBody = z.object({
  fulfillment_type: z.enum(['takeaway', 'delivery', 'pickup']).default('takeaway'),
  channel: z.enum(['web', 'kiosk']).optional(),
  items: z.array(ItemInput).min(1),
  delivery_fee: z.number().nonnegative().optional(),
  scheduled_at: z.string().optional(),
  notes: z.string().optional(),
  member_id: z.number().int().positive().optional(),  // loyalty member — points earned on confirm
  delivery: z.object({ contact_name: z.string().optional(), contact_phone: z.string().optional(), address_line: z.string().optional(), address_note: z.string().optional(), lat: z.number().optional(), lng: z.number().optional() }).optional(),
});
const ConfirmBody = z.object({ payment_no: z.string().min(1) });

// PUBLIC online-ordering endpoints — no login (mirrors QrController). @NoTx opts out of the anonymous
// request tx; the service re-enters RealtimeScope.run(tenant) so RLS scopes every read/write.
@Controller('api')
export class ChannelController {
  constructor(private readonly channel: ChannelOrderService) {}

  @Public() @NoTx() @Get('order/:slug')
  store(@Param('slug') slug: string) { return this.channel.store(slug); }

  @Public() @NoTx() @Post('order/:slug')
  create(@Param('slug') slug: string, @Body(new ZodValidationPipe(PublicOrderBody)) b: any) { return this.channel.createPublicOrder(slug, b); }

  @Public() @NoTx() @Get('order/t/:token')
  status(@Param('token') token: string) { return this.channel.status(token); }

  @Public() @NoTx() @Post('order/t/:token/pay')
  pay(@Param('token') token: string) { return this.channel.pay(token); }

  @Public() @NoTx() @Post('order/t/:token/confirm')
  confirm(@Param('token') token: string, @Body(new ZodValidationPipe(ConfirmBody)) b: { payment_no: string }) { return this.channel.confirm(token, b.payment_no); }

  // 3rd-party aggregator webhook (Grab/LineMan) — @Public, gated by a per-source shared secret header;
  // idempotent on (source, ext_event_id).
  @Public() @NoTx() @Post('channel/webhook/:source')
  webhook(@Param('source') source: string, @Headers('x-webhook-secret') secret: string | undefined, @Body() body: any) { return this.channel.ingestThirdParty(source, body, secret); }
}
