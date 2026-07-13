import { Module } from '@nestjs/common';
import { JourneysController } from './journeys.controller';
import { JourneysService } from './journeys.service';
import { DocNumberService } from '../../common/doc-number.service';
import { SavedSegmentsService } from '../loyalty/saved-segments.service';
import { MessagingModule } from '../messaging/messaging.module';
import { JourneysBiReports } from './journeys-bi-reports';

// Lifecycle journeys (Phase G1, docs/25). Rides MessagingService (consent + per-tenant providers) and the
// F1 saved-segment rule engine (entry sweeps + skip-rules). Exported so the automation engine's
// `enroll_journey` action and the BI scheduler's `journey_runner` job can drive it.
@Module({
  imports: [MessagingModule],
  controllers: [JourneysController],
  providers: [JourneysBiReports, JourneysService, DocNumberService, SavedSegmentsService],
  exports: [JourneysService],
})
export class JourneysModule {}
