import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { ServiceCasesService } from './service-cases.service';
import { ServiceCasesController, CaseEmailInboundController } from './service-cases.controller';

// SVC-4 — Service Cloud: Support Cases + Email-to-Case (SVC-04 control). MessagingModule provides the per-tenant
// email credential lookup (TenantMessagingService) for the inbound shared secret / HMAC. DRIZZLE + guards are
// global. Append-only (case lifecycle + email trail — no GL post in v1). Distinct from the #666 subscription/SLA
// ServiceModule and the SVC-2 ServiceWarrantyModule.
@Module({
  imports: [MessagingModule],
  controllers: [ServiceCasesController, CaseEmailInboundController],
  providers: [ServiceCasesService],
  exports: [ServiceCasesService],
})
export class ServiceCasesModule {}
