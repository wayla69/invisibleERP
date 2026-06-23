import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TableService } from './table.service';
import { DineInService } from './dine-in.service';
import { KdsService } from './kds.service';
import { ChannelOrderService } from './channel-order.service';
import { BuffetService } from './buffet.service';
import {
  CreateOrderBody, AddItemsBody, KdsActionBody, CheckoutBody, CreateTableBody, UpdateTableBody,
  TableStatusBody, ZoneBody, StationBody, BuffetPackageBody, BuffetPackageUpdateBody,
  type CreateOrderDto, type AddItemsDto, type KdsActionDto, type CheckoutDto, type CreateTableDto, type UpdateTableDto,
  type BuffetPackageDto, type BuffetPackageUpdateDto,
} from './dto';

const OpenTableBody = z.object({ party_size: z.number().int().positive().optional() });
const CancelBody = z.object({ reason: z.string().optional() });
const KioskItem = z.object({ sku: z.string().optional(), menu_item_id: z.number().int().optional(), modifier_option_ids: z.array(z.number().int()).optional(), name: z.string().optional(), unit_price: z.number().nonnegative().optional(), station_code: z.string().optional(), qty: z.number().positive().default(1), notes: z.string().optional() }).refine((it) => it.sku != null || it.menu_item_id != null || (it.name != null && it.unit_price != null), { message: 'provide sku/menu_item_id or name+unit_price' });
const KioskBody = z.object({ fulfillment_type: z.enum(['takeaway', 'delivery', 'pickup']).optional(), items: z.array(KioskItem).min(1), delivery_fee: z.number().nonnegative().optional(), method: z.string().optional(), notes: z.string().optional() });
const FulfillmentBody = z.object({ action: z.enum(['accepted', 'preparing', 'ready', 'out_for_delivery', 'completed', 'rejected']) });

@Controller('api/restaurant')
@Permissions('pos')
export class RestaurantController {
  constructor(
    private readonly tables: TableService,
    private readonly dineIn: DineInService,
    private readonly kds: KdsService,
    private readonly channel: ChannelOrderService,
    private readonly buffet: BuffetService,
  ) {}

  // ── floor-plan / tables ──
  @Get('zones') zones(@CurrentUser() u: JwtUser) { return this.tables.listZones(u); }
  @Post('zones') createZone(@Body(new ZodValidationPipe(ZoneBody)) b: { name: string; sort_order?: number }, @CurrentUser() u: JwtUser) { return this.tables.createZone(b.name, b.sort_order, u); }

  @Get('tables') listTables(@CurrentUser() u: JwtUser) { return this.tables.listTables(u); }
  @Get('tables/status') tablesStatus(@CurrentUser() u: JwtUser) { return this.tables.statusBoard(u); }
  @Post('tables') createTable(@Body(new ZodValidationPipe(CreateTableBody)) b: CreateTableDto, @CurrentUser() u: JwtUser) { return this.tables.createTable(b, u); }
  @Patch('tables/:id') updateTable(@Param('id') id: string, @Body(new ZodValidationPipe(UpdateTableBody)) b: UpdateTableDto, @CurrentUser() u: JwtUser) { return this.tables.updateTable(+id, b, u); }
  @Patch('tables/:id/status') setStatus(@Param('id') id: string, @Body(new ZodValidationPipe(TableStatusBody)) b: { status: string }, @CurrentUser() u: JwtUser) { return this.tables.setStatus(+id, b.status, u); }
  @Post('tables/:id/open') openTable(@Param('id') id: string, @Body(new ZodValidationPipe(OpenTableBody)) b: { party_size?: number }, @CurrentUser() u: JwtUser) { return this.tables.openTable(+id, b.party_size, u.username, u); }

  // ── dine-in orders ──
  @Post('orders') createOrder(@Body(new ZodValidationPipe(CreateOrderBody)) b: CreateOrderDto, @CurrentUser() u: JwtUser) { return this.dineIn.createOrder(b, u); }
  @Get('orders') listOrders(@CurrentUser() u: JwtUser) { return this.dineIn.listOpenOrders(u); }
  @Get('orders/:orderNo') getOrder(@Param('orderNo') o: string, @CurrentUser() u: JwtUser) { return this.dineIn.getOrder(o, u); }
  @Post('orders/:orderNo/items') addItems(@Param('orderNo') o: string, @Body(new ZodValidationPipe(AddItemsBody)) b: AddItemsDto, @CurrentUser() u: JwtUser) { return this.dineIn.addItems(o, b, u); }
  @Post('orders/:orderNo/fire') fire(@Param('orderNo') o: string, @CurrentUser() u: JwtUser) { return this.dineIn.fire(o, u); }
  @Post('orders/:orderNo/bill') bill(@Param('orderNo') o: string, @CurrentUser() u: JwtUser) { return this.dineIn.requestBill(o, u); }
  @Post('orders/:orderNo/checkout') checkout(@Param('orderNo') o: string, @Body(new ZodValidationPipe(CheckoutBody)) b: CheckoutDto, @CurrentUser() u: JwtUser) { return this.dineIn.checkout(o, b, u); }
  @Post('orders/:orderNo/close') close(@Param('orderNo') o: string, @CurrentUser() u: JwtUser) { return this.dineIn.closeTable(o, u); }
  @Post('orders/:orderNo/cancel') cancel(@Param('orderNo') o: string, @Body(new ZodValidationPipe(CancelBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.dineIn.cancelOrder(o, b.reason, u); }

  // ── online / delivery / kiosk (POS Tier 2 #10) ──
  @Post('kiosk/checkout') kioskCheckout(@Body(new ZodValidationPipe(KioskBody)) b: any, @CurrentUser() u: JwtUser) { return this.channel.kioskCheckout(b, u); }
  @Patch('orders/:orderNo/fulfillment') fulfillment(@Param('orderNo') o: string, @Body(new ZodValidationPipe(FulfillmentBody)) b: { action: string }, @CurrentUser() u: JwtUser) { return this.channel.advanceFulfillment(o, b.action, u); }
  @Get('fulfillment/board') @Permissions('delivery', 'order_mgt', 'pos') fulfillmentBoard(@CurrentUser() u: JwtUser) { return this.channel.fulfillmentBoard(u); }

  // ── KDS ──
  @Get('kds/feed') feed(@CurrentUser() u: JwtUser) { return this.kds.feed(u); }
  @Patch('kds/items/:id') itemAction(@Param('id') id: string, @Body(new ZodValidationPipe(KdsActionBody)) b: KdsActionDto, @CurrentUser() u: JwtUser) { return this.dineIn.itemTransition(+id, b.action, b.reason, u); }
  @Get('kds/stations') stations(@CurrentUser() u: JwtUser) { return this.kds.listStations(u); }

  // ── buffet packages / tiers (Phase 2) — read for POS/floor, manage for master-data roles (SoD) ──
  @Get('buffet/packages') @Permissions('pos', 'order_mgt', 'masterdata') listBuffet(@CurrentUser() u: JwtUser) { return this.buffet.listPackages(u); }
  @Get('buffet/analytics') @Permissions('pos', 'order_mgt', 'masterdata', 'exec') buffetAnalytics(@CurrentUser() u: JwtUser) { return this.buffet.analytics(u); }
  @Post('buffet/packages') @Permissions('masterdata', 'pricelist', 'exec') createBuffet(@Body(new ZodValidationPipe(BuffetPackageBody)) b: BuffetPackageDto, @CurrentUser() u: JwtUser) { return this.buffet.createPackage(b, u); }
  @Patch('buffet/packages/:id') @Permissions('masterdata', 'pricelist', 'exec') updateBuffet(@Param('id') id: string, @Body(new ZodValidationPipe(BuffetPackageUpdateBody)) b: BuffetPackageUpdateDto, @CurrentUser() u: JwtUser) { return this.buffet.updatePackage(+id, b, u); }
  @Post('kds/stations') upsertStation(@Body(new ZodValidationPipe(StationBody)) b: z.infer<typeof StationBody>, @CurrentUser() u: JwtUser) { return this.kds.upsertStation(b, u); }
}
