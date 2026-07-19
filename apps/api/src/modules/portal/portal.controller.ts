import { Controller, Get, Post, Patch, Delete, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  PortalService, type AddInventoryDto, type UpdateInventoryDto, type VarianceDto,
} from './portal.service';
import { PortalPosService, type PortalSaleDto } from './portal.pos.service';
import { OfflineSyncService, type OfflineSyncBatchDto } from './offline-sync.service';
import {
  PortalMyErpService, type MyCustomerDto, type MySupplierDto, type MyPoDto,
} from './portal.myerp.service';
import { PortalUsersService, type SubUserDto } from './portal.users.service';
import { qint, qintOpt } from '../../common/query';

// ── Zod schemas ──────────────────────────────────────────────────
const SaleBody = z.object({
  items: z.array(z.object({
    item_id: z.string().min(1), item_description: z.string().optional(),
    qty: z.number().positive(), unit_price: z.number().nonnegative(),
    uom: z.string().optional(), discount_pct: z.number().min(0).max(100).optional(),
    modifier_option_ids: z.array(z.number().int()).optional(),
    lot_no: z.string().trim().max(64).optional(), // docs/52 Phase 3a — explicit lot for a lot-tracked item (else FEFO)
  })).min(1),
  discount: z.number().nonnegative().optional(),
  payment_method: z.string().optional(),
  notes: z.string().optional(),
  apply_pricing: z.boolean().optional(),
  channel: z.string().optional(),
  party_size: z.number().int().optional(),
  service_charge_pct: z.number().min(0).max(100).optional(),
  service_min_party: z.number().int().positive().optional(),
  rounding: z.number().nonnegative().optional(),
  branch_id: z.number().int().positive().optional(),
  // docs/52 Phase 6a — split payment: settle one sale across several tenders (must sum to the total).
  tenders: z.array(z.object({
    method: z.string().min(1),
    amount: z.number().positive(),
    gateway: z.string().optional(),
    cash_tendered: z.number().nonnegative().optional(),
    reference: z.string().max(120).optional(),
  })).min(1).max(10).optional(),
});

const AddInventoryBody = z.object({
  item_id: z.string().min(1), item_description: z.string().optional(), uom: z.string().optional(),
  current_stock: z.number().optional(), reorder_point: z.number().optional(), reorder_qty: z.number().optional(), notes: z.string().optional(),
});
const UpdateInventoryBody = z.object({
  current_stock: z.number().optional(), reorder_point: z.number().optional(), reorder_qty: z.number().optional(), notes: z.string().optional(),
});

const VARIANCE_REASONS = ['WASTE', 'OVERSTOCK', 'SPOILAGE', 'PORTIONING', 'THEFT', 'OTHER'] as const;
const VarianceBody = z.object({
  items: z.array(z.object({
    item_id: z.string().min(1), item_description: z.string().optional(), bom_code: z.string().optional(),
    uom: z.string().optional(), theoretical_use: z.number().optional(), actual_use: z.number(), reason: z.string().optional(),
    reason_code: z.enum(VARIANCE_REASONS).optional(), station: z.string().optional(),
  })).min(1),
  shift: z.string().optional(),
});

// Offline sync: a batch of queued offline sales. Per-OP validation is LENIENT (lines is a plain array)
// so a single corrupt op fails on its own at processing time instead of 400-ing the whole batch.
const OfflineSaleOp = z.object({
  client_uuid: z.string().min(1),
  branch_id: z.number().int().positive().optional(),
  device_id: z.string().optional(),
  client_seq: z.number().int().nonnegative().optional(),
  captured_at: z.string().min(1),
  lines: z.array(z.object({
    item_id: z.string().min(1), item_description: z.string().optional(),
    qty: z.number().positive(), unit_price: z.number().nonnegative(),
    uom: z.string().optional(), discount_pct: z.number().min(0).max(100).optional(),
  })),
  discount: z.number().nonnegative().optional(),
  payment_method: z.string().optional(),
});
const OfflineSyncBody = z.object({ sales: z.array(OfflineSaleOp).min(1).max(200) });

const SubUserBody = z.object({ username: z.string().min(1), password: z.string().min(8), permissions: z.array(z.string()).optional() });
const MyCustomerBody = z.object({ customer_name: z.string().min(1), phone: z.string().optional(), address: z.string().optional(), notes: z.string().optional() });
const MySupplierBody = z.object({ supplier_name: z.string().min(1), contact_name: z.string().optional(), phone: z.string().optional(), address: z.string().optional() });
const MyPoBody = z.object({
  supplier_name: z.string().optional(), remarks: z.string().optional(),
  items: z.array(z.object({ item_description: z.string().min(1), qty: z.number().positive(), uom: z.string().optional(), unit_price: z.number().nonnegative() })).min(1),
});

@Controller('api/portal')
export class PortalController {
  constructor(
    private readonly svc: PortalService,
    private readonly pos: PortalPosService,
    private readonly offline: OfflineSyncService,
    private readonly myerp: PortalMyErpService,
    private readonly subUsers: PortalUsersService,
  ) {}

  // ── Dashboard ──
  @Get('dashboard') @Permissions('cust_dash')
  dashboard(@CurrentUser() u: JwtUser) { return this.svc.dashboard(u); }

  // ── POS ──
  @Post('pos/sales') @Permissions('cust_pos')
  createSale(@Body(new ZodValidationPipe(SaleBody)) b: PortalSaleDto, @CurrentUser() u: JwtUser) { return this.pos.createSale(b, u); }

  @Get('pos/sales') @Permissions('cust_pos')
  listSales(@CurrentUser() u: JwtUser, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.pos.listSales(u, qint('limit', limit, 50), qint('offset', offset, 0));
  }

  // Offline sync: replay a batch of offline-queued sales idempotently (per-item savepoint isolation).
  @Post('pos/offline-sync') @Permissions('cust_pos')
  offlineSync(@Body(new ZodValidationPipe(OfflineSyncBody)) b: OfflineSyncBatchDto, @CurrentUser() u: JwtUser) {
    return this.offline.syncBatch(b, u);
  }

  // ── Inventory ──
  @Get('inventory') @Permissions('cust_inventory')
  listInventory(@CurrentUser() u: JwtUser) { return this.svc.listInventory(u); }

  @Post('inventory') @Permissions('cust_inventory')
  addInventory(@Body(new ZodValidationPipe(AddInventoryBody)) b: AddInventoryDto, @CurrentUser() u: JwtUser) { return this.svc.addInventory(b, u); }

  @Patch('inventory/:id') @Permissions('cust_inventory')
  updateInventory(@Param('id') id: string, @Body(new ZodValidationPipe(UpdateInventoryBody)) b: UpdateInventoryDto, @CurrentUser() u: JwtUser) {
    return this.svc.updateInventory(parseInt(id, 10), b, u);
  }

  // ── Pending Orders ──
  @Get('pending-orders') @Permissions('cust_inventory')
  pendingOrders(@CurrentUser() u: JwtUser) { return this.svc.listPendingOrders(u); }

  @Patch('pending-orders/:no/submit') @Permissions('cust_inventory')
  submitPending(@Param('no') no: string, @CurrentUser() u: JwtUser) { return this.svc.submitPendingOrder(no, u); }

  // ── Variance (EOD) ──
  @Post('variance') @Permissions('cust_variance')
  variance(@Body(new ZodValidationPipe(VarianceBody)) b: VarianceDto, @CurrentUser() u: JwtUser) { return this.svc.createVariance(b, u); }

  // ── Track ──
  @Get('track') @Permissions('track')
  track(@CurrentUser() u: JwtUser) { return this.svc.track(u); }

  // ── Mini-ERP: My Customers ──
  @Get('my/customers') @Permissions('cust_my_crm')
  listCustomers(@CurrentUser() u: JwtUser) { return this.myerp.listCustomers(u); }

  @Post('my/customers') @Permissions('cust_my_crm')
  addCustomer(@Body(new ZodValidationPipe(MyCustomerBody)) b: MyCustomerDto, @CurrentUser() u: JwtUser) { return this.myerp.addCustomer(b, u); }

  @Delete('my/customers/:id') @Permissions('cust_my_crm')
  deleteCustomer(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.myerp.deleteCustomer(parseInt(id, 10), u); }

  // ── Mini-ERP: My Suppliers ──
  @Get('my/suppliers') @Permissions('cust_my_suppliers')
  listSuppliers(@CurrentUser() u: JwtUser) { return this.myerp.listSuppliers(u); }

  @Post('my/suppliers') @Permissions('cust_my_suppliers')
  addSupplier(@Body(new ZodValidationPipe(MySupplierBody)) b: MySupplierDto, @CurrentUser() u: JwtUser) { return this.myerp.addSupplier(b, u); }

  @Delete('my/suppliers/:id') @Permissions('cust_my_suppliers')
  deleteSupplier(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.myerp.deleteSupplier(parseInt(id, 10), u); }

  // ── Mini-ERP: My Purchase Orders ──
  @Get('my/purchase-orders') @Permissions('cust_my_pos')
  listPurchaseOrders(@CurrentUser() u: JwtUser) { return this.myerp.listPurchaseOrders(u); }

  @Post('my/purchase-orders') @Permissions('cust_my_pos')
  createPurchaseOrder(@Body(new ZodValidationPipe(MyPoBody)) b: MyPoDto, @CurrentUser() u: JwtUser) { return this.myerp.createPurchaseOrder(b, u); }

  @Delete('my/purchase-orders/:no') @Permissions('cust_my_pos')
  deletePurchaseOrder(@Param('no') no: string, @CurrentUser() u: JwtUser) { return this.myerp.deletePurchaseOrder(no, u); }

  // ── Mini-ERP: My sub-account users ──
  @Get('my/users') @Permissions('cust_my_users')
  listMyUsers(@CurrentUser() u: JwtUser) { return this.subUsers.list(u); }

  @Post('my/users') @Permissions('cust_my_users')
  createMyUser(@Body(new ZodValidationPipe(SubUserBody)) b: SubUserDto, @CurrentUser() u: JwtUser) { return this.subUsers.create(b, u); }

  @Delete('my/users/:username') @Permissions('cust_my_users')
  deleteMyUser(@Param('username') username: string, @CurrentUser() u: JwtUser) { return this.subUsers.remove(username, u); }
}
