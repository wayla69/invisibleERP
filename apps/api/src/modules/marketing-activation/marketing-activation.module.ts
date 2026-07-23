import { Module } from '@nestjs/common';
import { FactLayerService } from './fact-layer.service';
import { MarketingActivationController } from './marketing-activation.controller';
import { MarketingIntelModule } from '../marketing-intel/marketing-intel.module';

// Marketing Activation (docs/61) — turns the delivered CRM × Marketing-Intelligence signals into
// sales-driving action. Phase 0 ships the shared read-only Fact Layer; the five tools (①–⑤) layer on top.
// Imports MarketingIntelModule for the pushed MMM/RFM/TOWS reads; DRIZZLE is global. Read model — no GL.
@Module({
  imports: [MarketingIntelModule],
  controllers: [MarketingActivationController],
  providers: [FactLayerService],
  exports: [FactLayerService],
})
export class MarketingActivationModule {}
