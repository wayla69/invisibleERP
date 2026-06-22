import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { WmsService } from './wms.service';
import { ReplenishmentService } from './replenishment.service';
import { RmaService } from './rma.service';

const BinBody = z.object({ bin_code: z.string().min(1), location_id: z.string().optional(), bin_type: z.string().optional(), aisle: z.string().optional(), rack: z.string().optional(), level: z.string().optional() });
const PutawayBody = z.object({ gr_no: z.string().optional(), bin_code: z.string().min(1), item_id: z.string().min(1), lot_no: z.string().optional(), qty: z.number().positive(), uom: z.string().optional(), expiry_date: z.string().optional() });
const WaveBody = z.object({ orders: z.array(z.object({ source_type: z.enum(['DINEIN', 'POS', 'SO']), source_ref: z.string().min(1) })).min(1) });
const PickBody = z.object({ lines: z.array(z.object({ pick_line_id: z.number(), picked_qty: z.number().nonnegative(), bin_code: z.string().optional() })).min(1) });
const ShipBody = z.object({ carrier: z.string().min(1), tracking_no: z.string().min(1) });

@Controller('api/wms')
export class WmsController {
  constructor(private readonly wms: WmsService) {}
  @Post('bins') @Permissions('locations', 'warehouse')
  createBin(@Body(new ZodValidationPipe(BinBody)) b: any, @CurrentUser() u: JwtUser) { return this.wms.createBin(b, u); }
  @Get('bins') @Permissions('locations', 'warehouse')
  listBins(@CurrentUser() u: JwtUser) { return this.wms.listBins(u); }
  @Get('bins/:binCode/stock') @Permissions('warehouse', 'lots')
  binStock(@Param('binCode') c: string, @CurrentUser() u: JwtUser) { return this.wms.binStockOf(c, u); }
  @Post('putaway') @Permissions('warehouse', 'mobile')
  putaway(@Body(new ZodValidationPipe(PutawayBody)) b: any, @CurrentUser() u: JwtUser) { return this.wms.putaway(b, u); }
  @Get('putaway/pending/:grNo') @Permissions('warehouse', 'mobile')
  pendingPutaway(@Param('grNo') grNo: string, @CurrentUser() u: JwtUser) { return this.wms.pendingPutaway(grNo, u); }
  @Post('waves') @Permissions('warehouse')
  wave(@Body(new ZodValidationPipe(WaveBody)) b: any, @CurrentUser() u: JwtUser) { return this.wms.createWave(b, u); }
  @Post('waves/:waveNo/ship') @Permissions('warehouse', 'delivery')
  shipWave(@Param('waveNo') w: string, @Body(new ZodValidationPipe(ShipBody)) b: any, @CurrentUser() u: JwtUser) { return this.wms.shipWave(w, b, u); }
  @Post('picks/:pickNo/pick') @Permissions('warehouse', 'mobile')
  pick(@Param('pickNo') p: string, @Body(new ZodValidationPipe(PickBody)) b: any, @CurrentUser() u: JwtUser) { return this.wms.pick(p, b, u); }
  @Post('picks/:pickNo/pack') @Permissions('warehouse', 'mobile')
  pack(@Param('pickNo') p: string, @CurrentUser() u: JwtUser) { return this.wms.pack(p, u); }
  @Post('shipments/:shipmentNo/ship') @Permissions('warehouse', 'delivery')
  ship(@Param('shipmentNo') s: string, @Body(new ZodValidationPipe(ShipBody)) b: any, @CurrentUser() u: JwtUser) { return this.wms.ship(s, b, u); }
}

@Controller('api/replenishment')
export class ReplenishmentController {
  constructor(private readonly rep: ReplenishmentService) {}
  @Post('suggest') @Permissions('planner', 'procurement')
  suggest(@CurrentUser() u: JwtUser) { return this.rep.suggest(u); }
  @Get('suggestions') @Permissions('planner', 'procurement')
  list(@CurrentUser() u: JwtUser) { return this.rep.list(u); }
  @Post('auto-pr') @Permissions('procurement', 'planner')
  autoPr(@Body(new ZodValidationPipe(z.object({ item_ids: z.array(z.string()).optional() }))) b: any, @CurrentUser() u: JwtUser) { return this.rep.autoPr(b, u); }
}

const RmaBody = z.object({ sale_no: z.string().min(1), reason: z.string().optional(), customer_ref: z.string().optional(), lines: z.array(z.object({ sale_item_id: z.number().optional(), item_id: z.string().min(1), qty: z.number().positive(), lot_no: z.string().optional(), uom: z.string().optional() })).min(1) });
const RmaReceiveBody = z.object({ lines: z.array(z.object({ rma_line_id: z.number(), disposition: z.enum(['restock', 'quarantine', 'scrap']), restock_bin_code: z.string().optional() })).min(1) });
const RmaRestockBody = z.object({ refund_method: z.enum(['Cash', 'Card', 'StoreCredit']) });

@Controller('api/rma')
export class RmaController {
  constructor(private readonly rma: RmaService) {}
  @Post() @Permissions('returns', 'warehouse')
  create(@Body(new ZodValidationPipe(RmaBody)) b: any, @CurrentUser() u: JwtUser) { return this.rma.create(b, u); }
  @Post(':rmaNo/receive') @Permissions('warehouse', 'lots')
  receive(@Param('rmaNo') r: string, @Body(new ZodValidationPipe(RmaReceiveBody)) b: any, @CurrentUser() u: JwtUser) { return this.rma.receive(r, b, u); }
  @Post(':rmaNo/restock') @Permissions('returns', 'warehouse')
  restock(@Param('rmaNo') r: string, @Body(new ZodValidationPipe(RmaRestockBody)) b: any, @CurrentUser() u: JwtUser) { return this.rma.restock(r, b, u); }
}
