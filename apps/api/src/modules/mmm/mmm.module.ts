import { Module } from '@nestjs/common';
import { MmmController } from './mmm.controller';
import { MmmIngestService } from './mmm-ingest.service';
import { MmmModelService } from './mmm-model.service';
import { MmmReadsService } from './mmm-reads.service';
import { MmmBiReports } from './mmm-bi-reports';

// docs/48 — Marketing Mix Modeling. New bounded context (distinct from marketing campaigns, reputation
// ingestion and connectors). DocNumberService comes from the @Global CommonModule. Exported so the BI
// scheduler (bi.module.ts) can discover MmmBiReports + call the model for the live GET /api/bi/mmm-summary.
@Module({
  controllers: [MmmController],
  providers: [MmmIngestService, MmmModelService, MmmReadsService, MmmBiReports],
  exports: [MmmModelService, MmmBiReports],
})
export class MmmModule {}
