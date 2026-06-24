import { Module } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { ConnectorsController } from './connectors.controller';

// D2 (Phase 24) — connector framework. DRIZZLE is global; stub transport so CI runs offline.
@Module({
  controllers: [ConnectorsController],
  providers: [ConnectorsService],
})
export class ConnectorsModule {}
