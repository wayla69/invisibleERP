import { Module } from '@nestjs/common';
import { FinanceModule } from '../../finance/finance.module';
import { CrmAccountHealthService } from './crm-account-health.service';
import { CrmAccountHealthController } from './crm-account-health.controller';
import { CrmAccountHealthBiReports } from './crm-account-health-bi-reports';

// docs/46 Phase 5 — the single-file module split into conventional service/controller/module files
// (pure verbatim moves, no DI change; the CRM-15 BI generator gets its own *-bi-reports.ts per the
// Phase 1 convention). The service class is re-exported for existing import sites (bi-generate).
export { CrmAccountHealthService } from './crm-account-health.service';

@Module({ imports: [FinanceModule], controllers: [CrmAccountHealthController], providers: [CrmAccountHealthService, CrmAccountHealthBiReports], exports: [CrmAccountHealthService] })
export class CrmAccountHealthModule {}
