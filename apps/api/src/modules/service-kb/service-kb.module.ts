import { Module } from '@nestjs/common';
import { ServiceKbService } from './service-kb.service';
import { ServiceKbController } from './service-kb.controller';

// SVC-6 — Service Cloud: Knowledge Base + Case Deflection (SVC-06 control). Governed article publish
// (draft → published[maker-checker] → archived) + a case-deflection log. DRIZZLE + guards are global; no GL.
@Module({
  controllers: [ServiceKbController],
  providers: [ServiceKbService],
  exports: [ServiceKbService],
})
export class ServiceKbModule {}
