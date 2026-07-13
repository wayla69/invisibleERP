import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomerMasterService } from './customer-master.service';
import { CustomersController, CustomerMasterController } from './customers.controller';

// docs/46 Phase 5 — the single-file module split into conventional service/controller/module files
// (pure verbatim moves, no DI change). Service classes are re-exported so existing
// `import { … } from './customers/customers.module'` sites keep working.
export { CustomersService } from './customers.service';
export { CustomerMasterService } from './customer-master.service';

@Module({ controllers: [CustomersController, CustomerMasterController], providers: [CustomersService, CustomerMasterService], exports: [CustomersService, CustomerMasterService] })
export class CustomersModule {}
