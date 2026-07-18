import { Controller, Get, Post, Put, Patch, Delete, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TableService } from './table.service';
import { DineInService } from './dine-in.service';
import { KdsService } from './kds.service';
import { ChannelOrderService } from './channel-order.service';
import { BuffetService } from './buffet.service';
import { PrintService } from '../printing/print.service';
import { PeripheralsService } from '../peripherals/peripherals.service';
import { RestaurantOfflineSyncService, type RegisterOfflineSyncBatchDto, type DineInOfflineSyncBatchDto } from './offline-sync.service';
import { ReservationService, type CreateReservationDto, type ListReservationsDto } from './reservation.service';
import { GuestProfileService, type UpsertDiningProfileDto, type AddCompanionDto } from './guest-profile.service';
import { TipService, type DistributeTipsDto } from './tip.service';
import { QrService } from './qr.service';
import { mintRotatingTableToken } from './qr-token.util';
import {
  CreateOrderBody, AddItemsBody, KdsActionBody, CheckoutBody, CreateTableBody, UpdateTableBody,
  TableStatusBody, ZoneBody, ZoneUpdateBody, StationBody, BuffetPackageBody, BuffetPackageUpdateBody, StartBuffetBody, MoveTableBody, TransferItemsBody, MergeTablesBody, AssignSeatBody,
  type CreateOrderDto, type AddItemsDto, type KdsActionDto, type CheckoutDto, type CreateTableDto, type UpdateTableDto,
  type ZoneDto, type ZoneUpdateDto, type BuffetPackageDto, type BuffetPackageUpdateDto, type StartBuffetDto,
} from './dto';

const OpenTableBody = z.object({ party_size: z.number().int().positive().optional() });
const CancelBody = z.object({ reason: z.string().optional() });
const KioskItem = z.object({ sku: z.string().optional(), menu_item_id: z.number().int().optional(), modifier_option_ids: z.array(z.number().int()).optional(), name: z.string().optional(), unit_price: z.number().nonnegative().optional(), station_code: z.string().optional(), qty: z.number().positive().default(1), notes: z.string().optional() }).refine((it) => it.sku != null || it.menu_item_id != null || (it.name != null && it.unit_price != null), { message: 'provide sku/menu_item_id or name+unit_price' });
const KioskBody = z.object({ fulfillment_type: z.enum(['takeaway', 'delivery', 'pickup']).optional(), items: z.array(KioskItem).min(1), delivery_fee: z.number().nonnegative().optional(), method: z.string().optional(), notes: z.string().optional() });
const FulfillmentBody = z.object({ action: z.enum(['accepted', 'preparing', 'ready', 'out_for_delivery', 'completed', 'rejected']) });
// Register offline-sync: a batch of sales captured on the touch register while the network was down.
const OfflineLineBody = z.object({ sku: z.string().optional(), menu_item_id: z.number().int().optional(), qty: z.number().positive(), modifier_option_ids: z.array(z.number().int()).optional(), notes: z.string().optional() }).refine((it) => it.sku != null || it.menu_item_id != null, { message: 'menu item (sku or menu_item_id) required' });
const OfflineSaleBody = z.object({ client_uuid: z.string().min(1).max(200), device_id: z.string().max(120).optional(), client_seq: z.number().int().optional(), captured_at: z.string().min(1), lines: z.array(OfflineLineBody).min(1).max(100), method: z.string().optional(), discount_pct: z.number().min(0).max(100).optional() });
const OfflineSyncBody = z.object({ sales: z.array(OfflineSaleBody).min(1).max(200) });
// POS-6 offline DINE-IN ops: open table / add items / fire captured while offline (settlement stays online).
const DineInOfflineLineBody = z.object({ sku: z.string().optional(), menu_item_id: z.number().int().optional(), qty: z.number().positive(), modifier_option_ids: z.array(z.number().int()).optional(), notes: z.string().max(500).optional(), course: z.number().int().min(1).max(9).optional() }).refine((it) => it.sku != null || it.menu_item_id != null, { message: 'menu item (sku or menu_item_id) required' });
const DineInOfflineOpBody = z.object({
  client_uuid: z.string().min(1).max(200), order_uuid: z.string().min(1).max(200), op: z.enum(['open', 'add', 'fire']),
  device_id: z.string().max(120).optional(), client_seq: z.number().int().optional(), captured_at: z.string().min(1),
  table_id: z.number().int().positive().optional(), guest_count: z.number().int().positive().optional(),
  fulfillment_type: z.enum(['dine_in', 'takeaway', 'delivery', 'pickup']).optional(),
  lines: z.array(DineInOfflineLineBody).max(100).optional(), course: z.number().int().min(1).max(9).optional(),
}).refine((o) => o.op !== 'open' || (o.lines?.length ?? 0) > 0, { message: 'an open op requires at least one line' });
const DineInOfflineSyncBody = z.object({ ops: z.array(DineInOfflineOpBody).min(1).max(200) });
// Reservations + walk-in waitlist
const DistributeTipsBody = z.object({
  from: z.string().min(8), to: z.string().min(8),
  method: z.enum(['equal', 'hours', 'weight']).optional(),
  amount: z.number().positive().optional(),
  pay_account: z.string().max(20).optional(),
  staff: z.array(z.object({ staff: z.string().min(1).max(120), hours: z.number().nonnegative().optional(), weight: z.number().nonnegative().optional() })).min(1).max(200),
});
const CreateReservationBody = z.object({
  kind: z.enum(['reservation', 'waitlist']).optional(),
  table_id: z.number().int().optional(),
  reserved_for: z.string().min(1).optional(),
  party_size: z.number().int().positive().optional(),
  customer_name: z.string().max(120).optional(),
  customer_phone: z.string().max(40).optional(),
  member_id: z.number().int().optional(),
  quoted_wait_min: z.number().int().nonnegative().optional(),
  notes: z.string().max(500).optional(),
  service_mode: z.enum(['a_la_carte', 'buffet']).optional(),  // fine-casual: buffet + à la carte in one venue
  buffet_package_id: z.number().int().optional(),
  occasion: z.string().max(120).optional(),
});
// Guest dining profile (PDPA consent-gated — see GuestProfileService).
// JSON-merge-patch style: omitted = keep the stored value, explicit null = clear.
const FreeList = z.array(z.string().max(120)).max(40);
const UpsertDiningProfileBody = z.object({
  consent: z.boolean().optional(),
  favorite_menus: FreeList.nullable().optional(),
  favorite_ingredients: FreeList.nullable().optional(),
  allergies: FreeList.nullable().optional(),
  dietary: z.string().max(120).nullable().optional(),
  seating_preference: z.string().max(200).nullable().optional(),
  typical_party_size: z.number().int().positive().max(200).nullable().optional(),
  service_notes: z.string().max(1000).nullable().optional(),
  extra: z.record(z.string().max(60), z.string().max(300)).nullable().optional(),
});
const AddCompanionBody = z.object({
  name: z.string().min(1).max(120),
  relationship: z.string().max(80).optional(),
  allergies: FreeList.optional(),
  preferences: z.string().max(500).optional(),
  notes: z.string().max(500).optional(),
});

@Controller('api/restaurant')
@Permissions('pos')
export class RestaurantController {
  constructor(
    private readonly tables: TableService,
    private readonly dineIn: DineInService,
    private readonly kds: KdsService,
    private readonly channel: ChannelOrderService,
    private readonly buffet: BuffetService,
    private readonly print: PrintService,
    private readonly peripherals: PeripheralsService,
    private readonly offlineSync: RestaurantOfflineSyncService,
    private readonly reservations: ReservationService,
    private readonly guests: GuestProfileService,
    private readonly tips: TipService,
    private readonly qr: QrService,
  ) {}

  // ── Public-QR-ordering controls (SOX-ICFR #3). Staff-managed; the diner endpoints live in QrController. ──
  @Get('qr-settings') @Permissions('order_mgt', 'exec', 'pos')
  qrSettings(@CurrentUser() u: JwtUser) { return this.qr.getSettings(u.tenantId as number); }

  @Put('qr-settings') @Permissions('order_mgt', 'exec')
  setQrSettings(@Body(new ZodValidationPipe(z.object({ require_staff_fire: z.boolean().optional(), dynamic_mode: z.boolean().optional(), auto_close_on_paid: z.boolean().optional(), recommend_mode: z.enum(['manual', 'behavior', 'popular_low_cost']).optional(), recommend_count: z.number().int().min(1).max(20).optional() }))) b: { require_staff_fire?: boolean; dynamic_mode?: boolean; auto_close_on_paid?: boolean; recommend_mode?: 'manual' | 'behavior' | 'popular_low_cost'; recommend_count?: number }, @CurrentUser() u: JwtUser) {
    return this.qr.setSettings(u.tenantId as number, b, u.username);
  }

  // A per-table display fetches the current SHORT-TTL rotating QR token to render (refreshes each window);
  // a diner scans it and POSTs to /api/qr/rstart/:token. Presence-bound alternative to the static placard.
  @Get('tables/:id/rotating-qr') @Permissions('order_mgt', 'exec', 'pos')
  rotatingQr(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    const token = mintRotatingTableToken(u.tenantId as number, parseInt(id, 10));
    return { token, start_url: `/api/qr/rstart/${token}`, window_sec: Number(process.env.QR_ROTATING_WINDOW_MS ?? 30000) / 1000 };
  }

  // ── Tip pooling / distribution (TIP-01). SoD: distributing tips is a manager/finance duty (order_mgt /
  //    exec / hr), separate from the cashier who rings sales (pos_sell) — a cashier can't pay tips to self. ──
  @Get('tips/pool') @Permissions('order_mgt', 'exec', 'pos')
  tipPool(@Query('from') from: string, @Query('to') to: string, @CurrentUser() u: JwtUser) { return this.tips.pool(from, to, u); }
  @Get('tips') @Permissions('order_mgt', 'exec', 'pos')
  tipList(@CurrentUser() u: JwtUser) { return this.tips.list(u); }
  @Post('tips/distribute') @Permissions('order_mgt', 'exec')
  tipDistribute(@Body(new ZodValidationPipe(DistributeTipsBody)) b: DistributeTipsDto, @CurrentUser() u: JwtUser) { return this.tips.distribute(b, u); }

  // ── Reservations + walk-in waitlist ──
  @Post('reservations')
  createReservation(@Body(new ZodValidationPipe(CreateReservationBody)) b: CreateReservationDto, @CurrentUser() u: JwtUser) {
    return this.reservations.create(b, u);
  }
  @Get('reservations')
  listReservations(@Query('kind') kind: string | undefined, @Query('status') status: string | undefined, @Query('from') from: string | undefined, @Query('to') to: string | undefined, @CurrentUser() u: JwtUser) {
    return this.reservations.list({ kind, status, from, to } as ListReservationsDto, u);
  }
  @Post('reservations/:id/notify')
  notifyReservation(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.reservations.notifyReady(+id, u); }
  @Post('reservations/:id/seat')
  seatReservation(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.reservations.seat(+id, u); }
  @Post('reservations/:id/cancel')
  cancelReservation(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.reservations.cancel(+id, u); }
  @Post('reservations/:id/no-show')
  noShowReservation(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.reservations.noShow(+id, u); }

  // ── Guest dining profile (Michelin-style guest CRM; PDPA consent-gated per member_consents 'dining_profile') ──
  @Get('guests/:memberId/profile') @Permissions('pos', 'order_mgt', 'crm')
  guestProfile(@Param('memberId') memberId: string, @CurrentUser() u: JwtUser) { return this.guests.get(+memberId, u); }
  @Put('guests/:memberId/profile') @Permissions('pos', 'order_mgt', 'crm')
  upsertGuestProfile(@Param('memberId') memberId: string, @Body(new ZodValidationPipe(UpsertDiningProfileBody)) b: UpsertDiningProfileDto, @CurrentUser() u: JwtUser) { return this.guests.upsert(+memberId, b, u); }
  @Post('guests/:memberId/companions') @Permissions('pos', 'order_mgt', 'crm')
  addGuestCompanion(@Param('memberId') memberId: string, @Body(new ZodValidationPipe(AddCompanionBody)) b: AddCompanionDto, @CurrentUser() u: JwtUser) { return this.guests.addCompanion(+memberId, b, u); }
  @Delete('guests/:memberId/companions/:companionId') @Permissions('pos', 'order_mgt', 'crm')
  removeGuestCompanion(@Param('memberId') memberId: string, @Param('companionId') companionId: string, @CurrentUser() u: JwtUser) { return this.guests.removeCompanion(+memberId, +companionId, u); }
  // Ask the guest themselves for the 'dining_profile' consent (LINE/SMS deep-link to the /m self-service)
  @Post('guests/:memberId/consent-request') @Permissions('pos', 'order_mgt', 'crm')
  requestGuestConsent(@Param('memberId') memberId: string, @CurrentUser() u: JwtUser) { return this.guests.requestConsent(+memberId, u); }

  // Replay register sales captured offline. Idempotent on (tenant, client_uuid) — a re-sent batch
  // returns 'duplicate' for already-posted sales and never double-posts.
  @Post('offline-sync')
  offlineSyncBatch(@Body(new ZodValidationPipe(OfflineSyncBody)) b: RegisterOfflineSyncBatchDto, @CurrentUser() u: JwtUser) {
    return this.offlineSync.syncBatch(b, u);
  }

  // POS-6: replay dine-in mutations (open table / add items / fire) captured offline. Idempotent on
  // (tenant, client_uuid); settlement stays ONLINE (the cashier settles the replayed order via checkout).
  @Post('offline-sync/dinein')
  offlineSyncDineIn(@Body(new ZodValidationPipe(DineInOfflineSyncBody)) b: DineInOfflineSyncBatchDto, @CurrentUser() u: JwtUser) {
    return this.offlineSync.syncDineInBatch(b, u);
  }

  // ── floor-plan / tables ──
  @Get('zones') zones(@CurrentUser() u: JwtUser) { return this.tables.listZones(u); }
  @Get('zones/revenue') @Permissions('pos', 'order_mgt', 'exec') zoneRevenue(@Query('from') from: string | undefined, @Query('to') to: string | undefined, @CurrentUser() u: JwtUser) { return this.tables.zoneRevenue(from, to, u); }
  @Post('zones') createZone(@Body(new ZodValidationPipe(ZoneBody)) b: ZoneDto, @CurrentUser() u: JwtUser) { return this.tables.createZone(b, u); }
  @Patch('zones/:id') updateZone(@Param('id') id: string, @Body(new ZodValidationPipe(ZoneUpdateBody)) b: ZoneUpdateDto, @CurrentUser() u: JwtUser) { return this.tables.updateZone(+id, b, u); }
  @Delete('zones/:id') removeZone(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.tables.deleteZone(+id, u); }

  @Get('tables') listTables(@CurrentUser() u: JwtUser) { return this.tables.listTables(u); }
  @Get('tables/status') tablesStatus(@CurrentUser() u: JwtUser) { return this.tables.statusBoard(u); }
  @Post('tables') createTable(@Body(new ZodValidationPipe(CreateTableBody)) b: CreateTableDto, @CurrentUser() u: JwtUser) { return this.tables.createTable(b, u); }
  @Patch('tables/:id') updateTable(@Param('id') id: string, @Body(new ZodValidationPipe(UpdateTableBody)) b: UpdateTableDto, @CurrentUser() u: JwtUser) { return this.tables.updateTable(+id, b, u); }
  @Delete('tables/:id') removeTable(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.tables.deleteTable(+id, u); }
  @Patch('tables/:id/status') setStatus(@Param('id') id: string, @Body(new ZodValidationPipe(TableStatusBody)) b: { status: string }, @CurrentUser() u: JwtUser) { return this.tables.setStatus(+id, b.status, u); }
  @Post('tables/:id/open') openTable(@Param('id') id: string, @Body(new ZodValidationPipe(OpenTableBody)) b: { party_size?: number }, @CurrentUser() u: JwtUser) { return this.tables.openTable(+id, b.party_size, u.username, u); }
  @Get('tables/:id/qr') tableQr(@Param('id') id: string, @Query('base') base: string | undefined, @CurrentUser() u: JwtUser) { return this.tables.qrSticker(+id, base, u); }
  @Post('tables/:id/buffet') startBuffet(@Param('id') id: string, @Body(new ZodValidationPipe(StartBuffetBody)) b: StartBuffetDto, @CurrentUser() u: JwtUser) { return this.buffet.startBuffetForTable(+id, b.package_id, b.pax ?? 1, u); }
  @Post('tables/:id/move') moveTable(@Param('id') id: string, @Body(new ZodValidationPipe(MoveTableBody)) b: { to_table_id: number }, @CurrentUser() u: JwtUser) { return this.tables.moveSession(+id, b.to_table_id, u); }
  @Post('tables/:id/merge') mergeTable(@Param('id') id: string, @Body(new ZodValidationPipe(MergeTablesBody)) b: { from_table_id: number }, @CurrentUser() u: JwtUser) { return this.dineIn.mergeTables(+id, b.from_table_id, u); }

  // ── dine-in orders ──
  @Post('orders') createOrder(@Body(new ZodValidationPipe(CreateOrderBody)) b: CreateOrderDto, @CurrentUser() u: JwtUser) { return this.dineIn.createOrder(b, u); }
  @Get('orders') listOrders(@CurrentUser() u: JwtUser) { return this.dineIn.listOpenOrders(u); }
  @Get('orders/:orderNo') getOrder(@Param('orderNo') o: string, @CurrentUser() u: JwtUser) { return this.dineIn.getOrder(o, u); }
  @Post('orders/:orderNo/items') addItems(@Param('orderNo') o: string, @Body(new ZodValidationPipe(AddItemsBody)) b: AddItemsDto, @CurrentUser() u: JwtUser) { return this.dineIn.addItems(o, b, u); }
  @Post('orders/:orderNo/transfer-items') transferItems(@Param('orderNo') o: string, @Body(new ZodValidationPipe(TransferItemsBody)) b: { item_ids: number[]; to_table_id: number }, @CurrentUser() u: JwtUser) { return this.dineIn.transferItems(o, b.item_ids, b.to_table_id, u); }
  // POS-9: (re)assign lines to a guest seat (null = shared/table)
  @Post('orders/:orderNo/seats/assign') assignSeat(@Param('orderNo') o: string, @Body(new ZodValidationPipe(AssignSeatBody)) b: { item_ids: number[]; seat: number | null }, @CurrentUser() u: JwtUser) { return this.dineIn.assignSeat(o, b.item_ids, b.seat, u); }
  @Post('orders/:orderNo/fire') fire(@Param('orderNo') o: string, @Query('course') course: string | undefined, @Query('seat') seat: string | undefined, @CurrentUser() u: JwtUser) { return this.dineIn.fire(o, u, course != null && course !== '' ? +course : undefined, seat != null && seat !== '' ? +seat : undefined); }
  @Post('orders/:orderNo/bill') bill(@Param('orderNo') o: string, @CurrentUser() u: JwtUser) { return this.dineIn.requestBill(o, u); }
  @Post('orders/:orderNo/checkout') async checkout(@Param('orderNo') o: string, @Body(new ZodValidationPipe(CheckoutBody)) b: CheckoutDto, @CurrentUser() u: JwtUser) {
    const res: any = await this.dineIn.checkout(o, b, u);
    if (res?.sale_no) {
      // best-effort: auto-queue the customer receipt (failure must never block a settled sale)
      try { await this.print.enqueue({ job_type: 'receipt', sale_no: res.sale_no }, u, { taxInvoiceNo: res.tax_invoice_no }); } catch { /* receipt is non-fiscal — never block checkout */ }
      // cash sale → pop the drawer (audited as reason 'sale'); never block the sale on a peripheral
      const method = (b.method ?? 'Cash');
      if (/cash|เงินสด/i.test(String(method))) { try { await this.peripherals.kickDrawer({ reason: 'sale', sale_no: res.sale_no, amount: res.total_with_tip ?? res.total }, u); } catch { /* drawer is a peripheral — never block checkout */ } }
    }
    return res;
  }
  @Post('orders/:orderNo/close') close(@Param('orderNo') o: string, @CurrentUser() u: JwtUser) { return this.dineIn.closeTable(o, u); }
  @Post('orders/:orderNo/cancel') cancel(@Param('orderNo') o: string, @Body(new ZodValidationPipe(CancelBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.dineIn.cancelOrder(o, b.reason, u); }

  // ── online / delivery / kiosk (POS Tier 2 #10) ──
  @Post('kiosk/checkout') kioskCheckout(@Body(new ZodValidationPipe(KioskBody)) b: any, @CurrentUser() u: JwtUser) { return this.channel.kioskCheckout(b, u); }
  @Patch('orders/:orderNo/fulfillment') fulfillment(@Param('orderNo') o: string, @Body(new ZodValidationPipe(FulfillmentBody)) b: { action: string }, @CurrentUser() u: JwtUser) { return this.channel.advanceFulfillment(o, b.action, u); }
  @Get('fulfillment/board') @Permissions('delivery', 'order_mgt', 'pos') fulfillmentBoard(@CurrentUser() u: JwtUser) { return this.channel.fulfillmentBoard(u); }

  // ── KDS ──
  @Get('kds/feed') feed(@CurrentUser() u: JwtUser) { return this.kds.feed(u); }
  @Get('kds/expo') kdsExpo(@CurrentUser() u: JwtUser) { return this.kds.expo(u); }            // order-ready pass (POS-4)
  @Get('kds/load') kdsLoad(@CurrentUser() u: JwtUser) { return this.kds.stationLoad(u); }     // per-station load + bump/recall counts (POS-4)
  @Patch('kds/items/:id') itemAction(@Param('id') id: string, @Body(new ZodValidationPipe(KdsActionBody)) b: KdsActionDto, @CurrentUser() u: JwtUser) { return this.dineIn.itemTransition(+id, b.action, b.reason, u); }
  // Serve a whole ticket: scan the order QR (or tap "Served" on the expo card) → every ready line flips to
  // served in one go, so a finished ticket never lingers on the pass.
  @Post('kds/serve') serveOrder(@Body(new ZodValidationPipe(z.object({ order_no: z.string().min(1) }))) b: { order_no: string }, @CurrentUser() u: JwtUser) { return this.dineIn.serveOrder(b.order_no, u); }
  // Start a whole ticket: accept every queued line of an order at once (queued → preparing) so a station
  // can take a table's order in one tap instead of card-by-card.
  @Post('kds/start') startOrder(@Body(new ZodValidationPipe(z.object({ order_no: z.string().min(1) }))) b: { order_no: string }, @CurrentUser() u: JwtUser) { return this.dineIn.startOrder(b.order_no, u); }
  @Get('kds/stations') stations(@CurrentUser() u: JwtUser) { return this.kds.listStations(u); }

  // ── buffet packages / tiers (Phase 2) — read for POS/floor, manage for master-data roles (SoD) ──
  @Get('buffet/packages') @Permissions('pos', 'order_mgt', 'masterdata') listBuffet(@CurrentUser() u: JwtUser) { return this.buffet.listPackages(u); }
  @Get('buffet/analytics') @Permissions('pos', 'order_mgt', 'masterdata', 'exec') buffetAnalytics(@CurrentUser() u: JwtUser) { return this.buffet.analytics(u); }
  @Post('buffet/packages') @Permissions('masterdata', 'pricelist', 'exec') createBuffet(@Body(new ZodValidationPipe(BuffetPackageBody)) b: BuffetPackageDto, @CurrentUser() u: JwtUser) { return this.buffet.createPackage(b, u); }
  @Patch('buffet/packages/:id') @Permissions('masterdata', 'pricelist', 'exec') updateBuffet(@Param('id') id: string, @Body(new ZodValidationPipe(BuffetPackageUpdateBody)) b: BuffetPackageUpdateDto, @CurrentUser() u: JwtUser) { return this.buffet.updatePackage(+id, b, u); }
  @Post('kds/stations') upsertStation(@Body(new ZodValidationPipe(StationBody)) b: z.infer<typeof StationBody>, @CurrentUser() u: JwtUser) { return this.kds.upsertStation(b, u); }
}
