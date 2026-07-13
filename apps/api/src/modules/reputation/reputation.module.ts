import { Module } from '@nestjs/common';
import { ReputationController } from './reputation.controller';
import { GoogleOAuthService } from './google-oauth.service';
import { ReputationConnectionsService } from './reputation-connections.service';
import { ReputationReviewSyncService } from './reputation-review-sync.service';
import { ReputationAnalyticsSyncService } from './reputation-analytics-sync.service';
import { ReputationReadsService } from './reputation-reads.service';
import { ReputationBiReports } from './reputation-bi-reports';

// docs/47 — reputation & external analytics ingestion (Google Maps reviews, GA4). New bounded context:
// distinct from marketing (campaigns/segments) and connectors (canonical order/product/statement import).
// Exported so the BI scheduler (bi.module.ts) can discover ReputationBiReports + call the sync services.
@Module({
  controllers: [ReputationController],
  providers: [
    GoogleOAuthService, ReputationConnectionsService, ReputationReviewSyncService,
    ReputationAnalyticsSyncService, ReputationReadsService, ReputationBiReports,
  ],
  exports: [GoogleOAuthService, ReputationConnectionsService, ReputationReviewSyncService, ReputationAnalyticsSyncService, ReputationBiReports],
})
export class ReputationModule {}
