import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TableService } from './table.service';
import { DineInService } from './dine-in.service';
import { KdsService } from './kds.service';
import {
  CreateOrderBody, AddItemsBody, KdsActionBody, CheckoutBody, CreateTableBody, UpdateTableBody,
  TableStatusBody, ZoneBody, StationBody,
  type CreateOrderDto, type AddItemsDto, type KdsActionDto, type CheckoutDto, type CreateTableDto, type UpdateTableDto,
} from './dto';

const OpenTableBody = z.object({ party_size: z.number().int().positive().optional() });
const CancelBody = z.object({ reason: z.string().optional() });

@Controller('api/restaurant')
@Permissions('pos')
export class RestaurantController {
  constructor(
    private readonly tables: TableService,
    private readonly dineIn: DineInService,
    private readonly kds: KdsService,
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

  // ── KDS ──
  @Get('kds/feed') feed(@CurrentUser() u: JwtUser) { return this.kds.feed(u); }
  @Patch('kds/items/:id') itemAction(@Param('id') id: string, @Body(new ZodValidationPipe(KdsActionBody)) b: KdsActionDto, @CurrentUser() u: JwtUser) { return this.dineIn.itemTransition(+id, b.action, b.reason, u); }
  @Get('kds/stations') stations(@CurrentUser() u: JwtUser) { return this.kds.listStations(u); }
  @Post('kds/stations') upsertStation(@Body(new ZodValidationPipe(StationBody)) b: z.infer<typeof StationBody>, @CurrentUser() u: JwtUser) { return this.kds.upsertStation(b, u); }
}
