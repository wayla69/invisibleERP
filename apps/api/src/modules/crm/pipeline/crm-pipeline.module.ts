import { Module } from '@nestjs/common';
import { MessagingModule } from '../../messaging/messaging.module';
import { AutomationModule } from '../../automation/automation.module';
import { CrmPipelineService } from './crm-pipeline.service';
import { CrmTimelineService } from './crm-timeline.service';
import { CrmPipelineController, CrmWebToLeadController } from './crm-pipeline.controller';
import { CrmTimelineController } from './crm-timeline.controller';
import { CrmPipelineBiReports } from './crm-pipeline-bi-reports';

// CRM sales pipeline (REV-17). DocNumberService + DRIZZLE are global (CommonModule / DatabaseModule).
// CRM-2: CrmWebToLeadController is the @Public website-form capture (rate-limited + honeypot).
// CRM-4: MessagingModule (deal comms) + AutomationModule (pipeline events → no-code rules) are wired so the
// pipeline can emit lead/opp/deal events and send email/LINE from the timeline (both @Optional in the svc).
@Module({
  imports: [MessagingModule, AutomationModule],
  controllers: [CrmPipelineController, CrmWebToLeadController, CrmTimelineController],
  providers: [CrmPipelineBiReports, CrmPipelineService, CrmTimelineService],
  exports: [CrmPipelineService],
})
export class CrmPipelineModule {}
