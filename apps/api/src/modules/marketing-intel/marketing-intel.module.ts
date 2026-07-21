import { Module } from '@nestjs/common';
import { MarketingIntelService } from './marketing-intel.service';
import { MarketingIntelController } from './marketing-intel.controller';

// docs/48 phase 3 — Marketing Intelligence push-back store + internal read for /marketing-intel.
// Exports the service so the public-API module can call the analytics:write push into the same
// bounded context (marketing-intel owns mi_analytics_snapshots — no other module writes it). DRIZZLE
// is global.
@Module({
  controllers: [MarketingIntelController],
  providers: [MarketingIntelService],
  exports: [MarketingIntelService],
})
export class MarketingIntelModule {}
