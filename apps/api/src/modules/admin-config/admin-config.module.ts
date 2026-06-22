import { Module } from '@nestjs/common';
import { ModuleConfigService } from './module-config.service';
import { ModuleConfigController } from './module-config.controller';
import { PublicModulesController } from './public-modules.controller';
import { ModuleEnabledGuard } from './module.guard';

@Module({
  controllers: [ModuleConfigController, PublicModulesController],
  providers: [ModuleConfigService, ModuleEnabledGuard],
  exports: [ModuleConfigService, ModuleEnabledGuard],
})
export class AdminConfigModule {}
