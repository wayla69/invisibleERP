import { Module } from '@nestjs/common';
import { CrmAccountsService } from './crm-accounts.service';
import { CrmAccountsController, CrmContactsController } from './crm-accounts.controller';

// docs/46 Phase 5 — the single-file module split into conventional service/controller/module files
// (pure verbatim moves, no DI change). CrmAccountsService is re-exported so existing
// `import { CrmAccountsService } from './accounts/crm-accounts.module'` sites keep working.
export { CrmAccountsService } from './crm-accounts.service';

@Module({ controllers: [CrmAccountsController, CrmContactsController], providers: [CrmAccountsService], exports: [CrmAccountsService] })
export class CrmAccountsModule {}
