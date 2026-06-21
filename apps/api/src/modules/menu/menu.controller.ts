import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MenuService } from './menu.service';
import { RecipeService } from './recipe.service';
import { UpsertRecipeBody, type UpsertRecipeDto } from './recipe.dto';
import {
  CreateCategoryBody, CreateItemBody, UpdateItemBody, SetAvailabilityBody, CreateModifierGroupBody, OptionBody, AttachGroupBody, ResolveLineBody,
  type CreateCategoryDto, type CreateItemDto, type UpdateItemDto, type CreateModifierGroupDto, type ResolveLineDto,
} from './dto';

const MANAGE = ['masterdata', 'pricelist', 'exec'] as const;
const READ = ['pos', 'order_mgt', 'masterdata', 'cust_pos'] as const;
const RECIPE_MANAGE = ['bom_master', 'masterdata', 'exec'] as const;

@Controller('api/menu')
export class MenuController {
  constructor(private readonly svc: MenuService, private readonly recipe: RecipeService) {}

  // ── categories ──
  @Post('categories') @Permissions(...MANAGE)
  createCategory(@Body(new ZodValidationPipe(CreateCategoryBody)) b: CreateCategoryDto, @CurrentUser() u: JwtUser) { return this.svc.createCategory(b, u); }
  @Get('categories') @Permissions(...READ)
  listCategories(@CurrentUser() u: JwtUser) { return this.svc.listCategories(u); }

  // ── full menu (POS render) + items ──
  @Get() @Permissions(...READ)
  menu(@CurrentUser() u: JwtUser) { return this.svc.listMenu(u); }
  @Post('items') @Permissions(...MANAGE)
  createItem(@Body(new ZodValidationPipe(CreateItemBody)) b: CreateItemDto, @CurrentUser() u: JwtUser) { return this.svc.createItem(b, u); }
  @Get('items/:sku') @Permissions(...READ)
  getItem(@Param('sku') sku: string, @CurrentUser() u: JwtUser) { return this.svc.getItem(sku, u); }
  @Patch('items/:sku') @Permissions(...MANAGE)
  updateItem(@Param('sku') sku: string, @Body(new ZodValidationPipe(UpdateItemBody)) b: UpdateItemDto, @CurrentUser() u: JwtUser) { return this.svc.updateItem(sku, b, u); }
  @Patch('items/:sku/availability') @Permissions('pos', 'order_mgt', 'masterdata')
  setAvailability(@Param('sku') sku: string, @Body(new ZodValidationPipe(SetAvailabilityBody)) b: { available: boolean }, @CurrentUser() u: JwtUser) { return this.svc.setAvailability(sku, b.available, u); }
  @Post('items/:sku/modifier-groups') @Permissions(...MANAGE)
  attachGroup(@Param('sku') sku: string, @Body(new ZodValidationPipe(AttachGroupBody)) b: { group_id: number }, @CurrentUser() u: JwtUser) { return this.svc.attachGroup(sku, b.group_id, u); }

  // ── modifier groups ──
  @Post('modifier-groups') @Permissions(...MANAGE)
  createGroup(@Body(new ZodValidationPipe(CreateModifierGroupBody)) b: CreateModifierGroupDto, @CurrentUser() u: JwtUser) { return this.svc.createModifierGroup(b, u); }
  @Get('modifier-groups') @Permissions(...READ)
  listGroups(@CurrentUser() u: JwtUser) { return this.svc.listGroups(u); }
  @Post('modifier-groups/:id/options') @Permissions(...MANAGE)
  addOption(@Param('id') id: string, @Body(new ZodValidationPipe(OptionBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.addOption(+id, b, u); }

  // ── resolve a priced order line (POS / dine-in / portal entry) ──
  @Post('resolve') @Permissions(...READ)
  resolve(@Body(new ZodValidationPipe(ResolveLineBody)) b: ResolveLineDto, @CurrentUser() u: JwtUser) { return this.svc.resolveLine(b, u); }

  // ── recipe / BOM (ตัดวัตถุดิบตามสูตร) ──
  @Get('recipes') @Permissions(...READ)
  listRecipes(@CurrentUser() u: JwtUser) { return this.recipe.listRecipes(u); }
  @Get('items/:sku/recipe') @Permissions(...READ)
  getRecipe(@Param('sku') sku: string, @CurrentUser() u: JwtUser) { return this.recipe.getRecipe(sku, u); }
  @Post('items/:sku/recipe') @Permissions(...RECIPE_MANAGE)
  upsertRecipe(@Param('sku') sku: string, @Body(new ZodValidationPipe(UpsertRecipeBody)) b: UpsertRecipeDto, @CurrentUser() u: JwtUser) { return this.recipe.upsertRecipe(sku, b, u); }
  @Delete('items/:sku/recipe') @Permissions(...RECIPE_MANAGE)
  deleteRecipe(@Param('sku') sku: string, @CurrentUser() u: JwtUser) { return this.recipe.deleteRecipe(sku, u); }
}
