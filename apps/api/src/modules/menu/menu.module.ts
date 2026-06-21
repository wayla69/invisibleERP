import { Module } from '@nestjs/common';
import { MenuService } from './menu.service';
import { MenuController } from './menu.controller';

// POS Menu / Catalog master — source of truth for POS / dine-in / portal order entry.
// DRIZZLE is global (DatabaseModule). Exports MenuService so order-entry modules can resolve priced lines.
@Module({
  controllers: [MenuController],
  providers: [MenuService],
  exports: [MenuService],
})
export class MenuModule {}
