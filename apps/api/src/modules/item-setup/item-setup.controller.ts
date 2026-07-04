import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ItemSetupService, type CategoryDto, type TaxCodeDto, type ItemProfileDto, type WarehouseAccountsDto } from './item-setup.service';

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
});
const WarehouseBody = z.object({ inventory_account: acct, adjustment_account: acct });

// Item-posting setup (docs/33 PR3). Item categories + tax codes maintenance and the per-item posting-profile
// override. Gated to master-data setup duties — kept clear of transactional perms (SoD R13).
@Controller('api/item-setup')
@Permissions('md_item', 'md_config', 'masterdata', 'exec')
export class ItemSetupController {
  constructor(private readonly svc: ItemSetupService) {}

  @Get('categories') listCategories(@CurrentUser() u: JwtUser) { return this.svc.listCategories(u); }
  @Post('categories') createCategory(@Body(new ZodValidationPipe(CategoryBody)) b: CategoryDto, @CurrentUser() u: JwtUser) { return this.svc.createCategory(b, u); }
  @Patch('categories/:code') updateCategory(@Param('code') code: string, @Body(new ZodValidationPipe(CategoryPatch)) b: Partial<CategoryDto>, @CurrentUser() u: JwtUser) { return this.svc.updateCategory(code, b, u); }

  @Get('tax-codes') listTaxCodes(@CurrentUser() u: JwtUser) { return this.svc.listTaxCodes(u); }
  @Post('tax-codes') createTaxCode(@Body(new ZodValidationPipe(TaxCodeBody)) b: TaxCodeDto, @CurrentUser() u: JwtUser) { return this.svc.createTaxCode(b, u); }
  @Patch('tax-codes/:code') updateTaxCode(@Param('code') code: string, @Body(new ZodValidationPipe(TaxCodePatch)) b: Partial<TaxCodeDto>, @CurrentUser() u: JwtUser) { return this.svc.updateTaxCode(code, b, u); }

  @Get('items/:itemId') getItem(@Param('itemId') itemId: string, @CurrentUser() u: JwtUser) { return this.svc.getItem(itemId, u); }
  @Patch('items/:itemId') updateItem(@Param('itemId') itemId: string, @Body(new ZodValidationPipe(ItemProfileBody)) b: ItemProfileDto, @CurrentUser() u: JwtUser) { return this.svc.updateItemProfile(itemId, b, u); }

  @Get('warehouses') listWarehouses(@CurrentUser() u: JwtUser) { return this.svc.listWarehouses(u); }
  @Patch('warehouses/:locationId') updateWarehouse(@Param('locationId') locationId: string, @Body(new ZodValidationPipe(WarehouseBody)) b: WarehouseAccountsDto, @CurrentUser() u: JwtUser) { return this.svc.updateWarehouseAccounts(locationId, b, u); }
}
