import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { WmsService } from './wms.service';
import { ReplenishmentService } from './replenishment.service';
import { RmaService } from './rma.service';

const BinBody = z.object({ bin_code: z.string().min(1), location_id: z.string().optional(), bin_type: z.string().optional(), aisle: z.string().optional(), rack: z.string().optional(), level: z.string().optional(), capacity: z.number().nonnegative().optional(), pos_x: z.number().optional(), pos_y: z.number().optional(), pos_z: z.number().optional(), dim_w: z.number().positive().optional(), dim_d: z.number().positive().optional(), dim_h: z.number().positive().optional() });
const BinLayoutBody = z.object({ capacity: z.number().nonnegative().optional(), pos_x: z.number().optional(), pos_y: z.number().optional(), pos_z: z.number().optional(), dim_w: z.number().positive().optional(), dim_d: z.number().positive().optional(), dim_h: z.number().positive().optional() });
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
  // Storage layout / 3D view: bin geometry + live utilisation; set a bin's geometry; locate an item spatially.
  @Get('layout') @Permissions('locations', 'warehouse', 'wh_custody')
  layout(@Query('location_id') loc: string | undefined, @CurrentUser() u: JwtUser) { return this.wms.warehouseLayout(u, loc); }
  @Patch('bins/:binCode/layout') @Permissions('locations', 'warehouse')
  setLayout(@Param('binCode') c: string, @Body(new ZodValidationPipe(BinLayoutBody)) b: any, @CurrentUser() u: JwtUser) { return this.wms.setBinLayout(c, b, u); }
  @Get('locate') @Permissions('locations', 'warehouse', 'wh_custody')
  locate(@Query('item_id') itemId: string, @CurrentUser() u: JwtUser) { return this.wms.locateItem(u, itemId); }
  // SoD warehouse sub-duties: receiving (wh_receive) vs picking/packing/shipping custody (wh_custody).
  // Legacy 'warehouse' holders still pass (it implies all wh_* sub-permissions).
  @Get('bins/:binCode/stock') @Permissions('warehouse', 'wh_custody', 'lots')
  binStock(@Param('binCode') c: string, @CurrentUser() u: JwtUser) { return this.wms.binStockOf(c, u); }
  @Post('putaway') @Permissions('wh_receive', 'mobile')
  putaway(@Body(new ZodValidationPipe(PutawayBody)) b: any, @CurrentUser() u: JwtUser) { return this.wms.putaway(b, u); }
  @Get('putaway/pending/:grNo') @Permissions('wh_receive', 'mobile')
  pendingPutaway(@Param('grNo') grNo: string, @CurrentUser() u: JwtUser) { return this.wms.pendingPutaway(grNo, u); }
  // Pending-list reads — feed the /wms doc-reference dropdowns (wave/pack/ship pick a document, not type it).
  @Get('picks') @Permissions('wh_custody', 'mobile')
  listPicks(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.wms.listPicks(u, status); }
  @Get('picks/:pickNo') @Permissions('wh_custody', 'mobile')
  getPick(@Param('pickNo') p: string, @CurrentUser() u: JwtUser) { return this.wms.getPick(p, u); }
  @Get('shipments') @Permissions('wh_custody', 'delivery')
  listShipments(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.wms.listShipments(u, status); }
  @Get('wave-candidates') @Permissions('wh_custody')
  waveCandidates(@CurrentUser() u: JwtUser) { return this.wms.waveCandidates(u); }
  @Post('waves') @Permissions('wh_custody')
  wave(@Body(new ZodValidationPipe(WaveBody)) b: any, @CurrentUser() u: JwtUser) { return this.wms.createWave(b, u); }
  @Post('waves/:waveNo/ship') @Permissions('wh_custody', 'delivery')
  shipWave(@Param('waveNo') w: string, @Body(new ZodValidationPipe(ShipBody)) b: any, @CurrentUser() u: JwtUser) { return this.wms.shipWave(w, b, u); }
  @Post('picks/:pickNo/pick') @Permissions('wh_custody', 'mobile')
  pick(@Param('pickNo') p: string, @Body(new ZodValidationPipe(PickBody)) b: any, @CurrentUser() u: JwtUser) { return this.wms.pick(p, b, u); }
  @Post('picks/:pickNo/pack') @Permissions('wh_custody', 'mobile')
  pack(@Param('pickNo') p: string, @CurrentUser() u: JwtUser) { return this.wms.pack(p, u); }
  @Post('shipments/:shipmentNo/ship') @Permissions('wh_custody', 'delivery')
  ship(@Param('shipmentNo') s: string, @Body(new ZodValidationPipe(ShipBody)) b: any, @CurrentUser() u: JwtUser) { return this.wms.ship(s, b, u); }
}

@Controller('api/replenishment')
export class ReplenishmentController {
  constructor(private readonly rep: ReplenishmentService) {}
  @Post('suggest') @Permissions('planner', 'procurement')
  suggest(@CurrentUser() u: JwtUser) { return this.rep.suggest(u); }
  @Get('suggestions') @Permissions('planner', 'procurement')
  list(@CurrentUser() u: JwtUser) { return this.rep.list(u); }
  // SoD: the transfer leg is a warehouse custody movement; the buy leg is a procurement act — different duties.
  @Post('auto-transfer') @Permissions('warehouse', 'wh_custody')
  autoTransfer(@Body(new ZodValidationPipe(z.object({ item_ids: z.array(z.string()).optional() }))) b: any, @CurrentUser() u: JwtUser) { return this.rep.autoTransfer(b, u); }
  @Post('auto-pr') @Permissions('procurement', 'planner')
  autoPr(@Body(new ZodValidationPipe(z.object({ item_ids: z.array(z.string()).optional() }))) b: any, @CurrentUser() u: JwtUser) { return this.rep.autoPr(b, u); }
  // Step 5 — demand-driven par-level recommendations + apply (INV-12)
  @Get('par-recommendations') @Permissions('planner', 'procurement')
  parRecommendations(@CurrentUser() u: JwtUser, @Query('branch_id') branchId?: string, @Query('window_days') windowDays?: string) {
    return this.rep.parRecommendations(u, { branchId: branchId ? Number(branchId) : undefined, windowDays: windowDays ? Number(windowDays) : undefined });
  }
  @Post('par-recommendations/apply') @Permissions('planner')
  applyPar(@Body(new ZodValidationPipe(z.object({ branch_id: z.number(), item_id: z.string().min(1), window_days: z.number().optional() }))) b: any, @CurrentUser() u: JwtUser) {
    return this.rep.applyPar(u, b.branch_id, b.item_id, { windowDays: b.window_days });
  }
  // Demand-ML order-quantity advisor (INV-13): advisory ML-driven suggested quantities for items at/below ROP.
  // horizon=7|14|28 (days); defaults to 14. Falls back to static reorder_qty when ML unavailable.
  @Get('demand-forecast') @Permissions('planner', 'procurement')
  demandForecast(@CurrentUser() u: JwtUser, @Query('horizon') horizon?: string) {
    return this.rep.demandForecast(u, { horizon: horizon ? Number(horizon) : undefined });
  }
}

const RmaBody = z.object({ sale_no: z.string().min(1), reason: z.string().optional(), customer_ref: z.string().optional(), lines: z.array(z.object({ sale_item_id: z.number().optional(), item_id: z.string().min(1), qty: z.number().positive(), lot_no: z.string().optional(), uom: z.string().optional() })).min(1) });
const RmaReceiveBody = z.object({ lines: z.array(z.object({ rma_line_id: z.number(), disposition: z.enum(['restock', 'quarantine', 'scrap']), restock_bin_code: z.string().optional() })).min(1) });
const RmaRestockBody = z.object({ refund_method: z.enum(['Cash', 'Card', 'StoreCredit']) });

@Controller('api/rma')
export class RmaController {
  constructor(private readonly rma: RmaService) {}
  @Post() @Permissions('returns', 'warehouse')
  create(@Body(new ZodValidationPipe(RmaBody)) b: any, @CurrentUser() u: JwtUser) { return this.rma.create(b, u); }
  @Post(':rmaNo/receive') @Permissions('wh_receive', 'lots')
  receive(@Param('rmaNo') r: string, @Body(new ZodValidationPipe(RmaReceiveBody)) b: any, @CurrentUser() u: JwtUser) { return this.rma.receive(r, b, u); }
  @Post(':rmaNo/restock') @Permissions('returns', 'warehouse')
  restock(@Param('rmaNo') r: string, @Body(new ZodValidationPipe(RmaRestockBody)) b: any, @CurrentUser() u: JwtUser) { return this.rma.restock(r, b, u); }
}
