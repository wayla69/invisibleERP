import { Module } from '@nestjs/common';
import { ProcurementController } from './procurement.controller';
import { ProcurementService } from './procurement.service';
import { WorkflowModule } from '../workflow/workflow.module';
import { CostingModule } from '../costing/costing.module';

@Module({ imports: [WorkflowModule, CostingModule], controllers: [ProcurementController], providers: [ProcurementService], exports: [ProcurementService] })
export class ProcurementModule {}
