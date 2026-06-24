import { Module } from '@nestjs/common';
import { MenuService } from './menu.service';
import { RecipeService } from './recipe.service';
import { FoodCostService } from './food-cost.service';
import { ProductionPlanService } from './production-plan.service';
import { MenuController } from './menu.controller';

// POS Menu / Catalog master — source of truth for POS / dine-in / portal order entry.
// DRIZZLE is global (DatabaseModule). Exports MenuService + RecipeService for order-entry + returns.
@Module({
  controllers: [MenuController],
  providers: [MenuService, RecipeService, FoodCostService, ProductionPlanService],
  exports: [MenuService, RecipeService, FoodCostService, ProductionPlanService],
})
export class MenuModule {}
