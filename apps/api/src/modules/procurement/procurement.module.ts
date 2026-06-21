import { Module } from '@nestjs/common';
import { ProcurementController } from './procurement.controller';
import { ProcurementService } from './procurement.service';
import { WorkflowModule } from '../workflow/workflow.module';

@Module({ imports: [WorkflowModule], controllers: [ProcurementController], providers: [ProcurementService] })
export class ProcurementModule {}
