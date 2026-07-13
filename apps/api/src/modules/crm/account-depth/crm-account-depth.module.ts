import { Module } from '@nestjs/common';
import { CrmAccountDepthService } from './crm-account-depth.service';
import { CrmAccountDepthController } from './crm-account-depth.controller';

// docs/46 Phase 5 — the single-file module split into conventional service/controller/module files
// (pure verbatim moves, no DI change). The service class is re-exported for existing import sites.
export { CrmAccountDepthService } from './crm-account-depth.service';

@Module({ controllers: [CrmAccountDepthController], providers: [CrmAccountDepthService], exports: [CrmAccountDepthService] })
export class CrmAccountDepthModule {}
