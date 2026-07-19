import { Controller, Get, Post, Patch, Delete, Param, Query, Body, Res, BadRequestException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ItemSetupService, type CategoryDto, type TaxCodeDto, type ItemProfileDto, type WarehouseAccountsDto } from './item-setup.service';
import { MasterDataService } from '../masterdata/masterdata.service';
import { ImportBody, type ImportBodyT, XLSX_MIME } from '../masterdata/masterdata.controller';

// Registry keys this controller may bulk import/export — the two master lists these setup pages own. Kept as
// an allow-list so a narrow md_item/md_config/exec holder can't reach sensitive entities (customers, vendors,
// assets) through here; those stay behind the coarse `masterdata` duty on /api/admin/master-data (SoD R13).
const IO_ENTITIES = new Set(['item_categories', 'tax_codes']);

const acct = z.string().trim().max(20).nullish();
const CategoryBody = z.object({
  code: z.string().min(1), name: z.string().nullish(), name_th: z.string().nullish(),
  revenue_account: acct, cogs_account: acct, inventory_account: acct, valuation_account: acct,
  vat_code: z.string().nullish(), wht_income_type: z.string().nullish(), default_location_id: z.string().nullish(),
  active: z.boolean().optional(),
});
const CategoryPatch = CategoryBody.partial();
const TaxCodeBody = z.object({
  code: z.string().min(1), name: z.string().nullish(), name_th: z.string().nullish(),
  kind: z.enum(['vat', 'wht']).optional(), rate: z.number().min(0).max(1).optional(),
  output_account: acct, input_account: acct, wht_account: acct, wht_income_type: z.string().nullish(),
  inclusive: z.boolean().optional(), active: z.boolean().optional(),
});
const TaxCodePatch = TaxCodeBody.partial();
const ItemProfileBody = z.object({
  category_id: z.number().int().nullish(),
  revenue_account: acct, cogs_account: acct, inventory_account: acct, valuation_account: acct,
  vat_code: z.string().nullish(), wht_income_type: z.string().nullish(), default_location_id: z.string().nullish(),
  barcode: z.string().trim().max(64).nullish(), uom: z.string().trim().max(20).nullish(), base_uom: z.string().trim().max(20).nullish(),
  conversion_factor: z.number().positive().nullish(), unit_price: z.number().nonnegative().nullish(),
  temperature_type: z.string().trim().max(30).nullish(), bu_id: z.string().trim().max(30).nullish(),
  supply_type: z.enum(['goods', 'service', 'non_inventory']).nullish(), // docs/52 Phase 2a/2c — service & non-inventory sell with no stock move / no COGS
  min_stock: z.number().nonnegative().nullish(), max_stock: z.number().nonnegative().nullish(),
  avg_daily_usage: z.number().nonnegative().nullish(), lead_time_days: z.number().nonnegative().nullish(),
  min_order_qty: z.number().nonnegative().nullish(), order_multiple: z.number().nonnegative().nullish(),
  order_cost: z.number().nonnegative().nullish(), holding_cost: z.number().nonnegative().nullish(),
  is_fixed_asset: z.boolean().optional(), default_asset_category_id: z.number().int().nullish(),
  is_lot_tracked: z.boolean().optional(), // docs/52 Phase 3a — FEFO lot capture at the POS for this item
});
const WarehouseBody = z.object({
  location_name: z.string().trim().max(200).nullish(), zone: z.string().trim().max(50).nullish(),
  type: z.string().trim().max(50).nullish(), capacity: z.number().nonnegative().nullish(),
  temperature: z.string().trim().max(50).nullish(), active: z.boolean().optional(), notes: z.string().trim().max(2000).nullish(),
  inventory_account: acct, adjustment_account: acct,
});
// Item relationships + lifecycle (master-data audit Phase 10).
const ITEM_REL_TYPES = ['substitute', 'complement', 'supersedes', 'kit_component', 'accessory'] as const;
// qty (docs/52 Phase 2c) — components consumed per kit sold; only meaningful for rel_type='kit_component'.
const ItemRelBody = z.object({ to_item_id: z.string().min(1), rel_type: z.enum(ITEM_REL_TYPES).default('substitute'), qty: z.number().positive().max(100000).optional(), note: z.string().optional() });
// docs/52 Phase 2b — generate a variant matrix under a parent item from axes (Size, Color, …).
const GenerateVariantsBody = z.object({
  axes: z.array(z.object({ axis: z.string().trim().min(1).max(40), values: z.array(z.string().trim().min(1).max(40)).min(1).max(50) })).min(1).max(4),
  barcodes: z.record(z.string(), z.string().trim().max(64)).optional(),
});
const ItemStatusBody = z.object({ status: z.enum(['active', 'inactive', 'discontinued']), superseded_by: z.string().nullish() });
// Match-merge / DQM (master-data audit Phase 11).
const ItemMergeBody = z.object({ survivor_item_id: z.string().min(1), duplicate_item_id: z.string().min(1) });

// Item-posting setup (docs/33 PR3). Item categories + tax codes maintenance and the per-item posting-profile
// override. Gated to master-data setup duties — kept clear of transactional perms (SoD R13).
@Controller('api/item-setup')
@Permissions('md_item', 'md_config', 'masterdata', 'exec')
export class ItemSetupController {
  constructor(private readonly svc: ItemSetupService, private readonly md: MasterDataService) {}

  // ── Bulk Excel/CSV import-export for the setup master lists (item categories, tax codes) ──────────────
  // Same registry-driven engine as /api/admin/master-data, but scoped to IO_ENTITIES and gated to the setup
  // duties above so a user who can maintain these lists one-by-one can also load/download them in bulk.
  private ioEntityOrThrow(entity: string): string {
    if (!IO_ENTITIES.has(entity)) {
      throw new BadRequestException({ code: 'BAD_ENTITY', message: `Import/export not available for '${entity}' here`, messageTh: 'ไม่รองรับการนำเข้า/ส่งออกสำหรับข้อมูลนี้ที่หน้านี้' });
    }
    return entity;
  }

  @Get('io/entities')
  ioEntities() {
    return { entities: this.md.entities().entities.filter((e) => IO_ENTITIES.has(e.key)) };
  }

  @Get('io/:entity/export')
  async ioExport(@Param('entity') entity: string, @Query('format') format: string | undefined, @Res() reply: FastifyReply) {
    this.ioEntityOrThrow(entity);
    if (format === 'csv') {
      const csv = await this.md.exportCsv(entity);
      reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${entity}.csv"`).send(csv);
      return;
    }
    const buf = await this.md.exportXlsx(entity);
    reply.header('Content-Type', XLSX_MIME).header('Content-Disposition', `attachment; filename="${entity}.xlsx"`).header('Content-Length', buf.length).send(buf);
  }

  @Get('io/:entity/template')
  async ioTemplate(@Param('entity') entity: string, @Res() reply: FastifyReply) {
    this.ioEntityOrThrow(entity);
    const buf = await this.md.templateXlsx(entity);
    reply.header('Content-Type', XLSX_MIME).header('Content-Disposition', `attachment; filename="${entity}_template.xlsx"`).header('Content-Length', buf.length).send(buf);
  }

  @Post('io/:entity/import/validate')
  async ioValidate(@Param('entity') entity: string, @Body(new ZodValidationPipe(ImportBody)) b: ImportBodyT, @CurrentUser() u: JwtUser) {
    this.ioEntityOrThrow(entity);
    const rows = await this.md.rowsFromInput(b);
    return this.md.validateReport(entity, b.mode, rows, u);
  }

  @Post('io/:entity/import/checked')
  async ioImportChecked(@Param('entity') entity: string, @Body(new ZodValidationPipe(ImportBody)) b: ImportBodyT, @CurrentUser() u: JwtUser) {
    this.ioEntityOrThrow(entity);
    const rows = await this.md.rowsFromInput(b);
    return this.md.importChecked(entity, b.mode, rows, u, b.skip_errors ?? false);
  }

  @Get('categories') listCategories(@CurrentUser() u: JwtUser) { return this.svc.listCategories(u); }
  @Post('categories') createCategory(@Body(new ZodValidationPipe(CategoryBody)) b: CategoryDto, @CurrentUser() u: JwtUser) { return this.svc.createCategory(b, u); }
  @Patch('categories/:code') updateCategory(@Param('code') code: string, @Body(new ZodValidationPipe(CategoryPatch)) b: Partial<CategoryDto>, @CurrentUser() u: JwtUser) { return this.svc.updateCategory(code, b, u); }

  @Get('tax-codes') listTaxCodes(@CurrentUser() u: JwtUser) { return this.svc.listTaxCodes(u); }
  @Post('tax-codes') createTaxCode(@Body(new ZodValidationPipe(TaxCodeBody)) b: TaxCodeDto, @CurrentUser() u: JwtUser) { return this.svc.createTaxCode(b, u); }
  @Patch('tax-codes/:code') updateTaxCode(@Param('code') code: string, @Body(new ZodValidationPipe(TaxCodePatch)) b: Partial<TaxCodeDto>, @CurrentUser() u: JwtUser) { return this.svc.updateTaxCode(code, b, u); }

  @Get('items/:itemId') getItem(@Param('itemId') itemId: string, @CurrentUser() u: JwtUser) { return this.svc.getItem(itemId, u); }
  @Patch('items/:itemId') updateItem(@Param('itemId') itemId: string, @Body(new ZodValidationPipe(ItemProfileBody)) b: ItemProfileDto, @CurrentUser() u: JwtUser) { return this.svc.updateItemProfile(itemId, b, u); }
  // Item lifecycle + relationships (master-data audit Phase 10).
  @Patch('items/:itemId/status') setItemStatus(@Param('itemId') itemId: string, @Body(new ZodValidationPipe(ItemStatusBody)) b: z.infer<typeof ItemStatusBody>, @CurrentUser() u: JwtUser) { return this.svc.setItemStatus(itemId, b, u); }
  @Post('items/:itemId/relationships') addItemRelationship(@Param('itemId') itemId: string, @Body(new ZodValidationPipe(ItemRelBody)) b: z.infer<typeof ItemRelBody>, @CurrentUser() u: JwtUser) { return this.svc.addItemRelationship(itemId, b, u); }
  @Get('items/:itemId/relationships') listItemRelationships(@Param('itemId') itemId: string, @CurrentUser() u: JwtUser) { return this.svc.listItemRelationships(itemId, u); }
  // docs/52 Phase 2b — product variants / matrix items.
  @Post('items/:itemId/variants') generateVariants(@Param('itemId') itemId: string, @Body(new ZodValidationPipe(GenerateVariantsBody)) b: z.infer<typeof GenerateVariantsBody>, @CurrentUser() u: JwtUser) { return this.svc.generateVariants(itemId, b, u); }
  @Get('items/:itemId/variants') listVariants(@Param('itemId') itemId: string, @CurrentUser() u: JwtUser) { return this.svc.listVariants(itemId, u); }
  @Delete('items/:itemId/relationships/:relId') deleteItemRelationship(@Param('itemId') itemId: string, @Param('relId') relId: string, @CurrentUser() u: JwtUser) { return this.svc.deleteItemRelationship(itemId, +relId, u); }
  // Match-merge / DQM (master-data audit Phase 11) — detect is a read-only review queue for the setup duties;
  // merge is gated in the service to the platform owner (god) because items are a shared cross-tenant master.
  @Get('items-duplicates') findDuplicateItems(@CurrentUser() u: JwtUser) { return this.svc.findDuplicateItems(u); }
  @Post('items-merge') mergeItems(@Body(new ZodValidationPipe(ItemMergeBody)) b: z.infer<typeof ItemMergeBody>, @CurrentUser() u: JwtUser) { return this.svc.mergeItems(b.survivor_item_id, b.duplicate_item_id, u); }

  @Get('warehouses') listWarehouses(@CurrentUser() u: JwtUser) { return this.svc.listWarehouses(u); }
  @Patch('warehouses/:locationId') updateWarehouse(@Param('locationId') locationId: string, @Body(new ZodValidationPipe(WarehouseBody)) b: WarehouseAccountsDto, @CurrentUser() u: JwtUser) { return this.svc.updateWarehouseAccounts(locationId, b, u); }
}
