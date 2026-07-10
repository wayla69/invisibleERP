import { Module } from '@nestjs/common';
import { HubController } from './hub.controller';
import { HubSyncService } from './hub-sync.service';
import { RestaurantModule } from '../restaurant/restaurant.module';

// Store-hub sync (LAN-first, docs/41): Phase 1 signed snapshot export for seeding an in-store hub +
// Phase 2a HMAC-authenticated hub→cloud sales ingest (replays via RestaurantOfflineSyncService).
@Module({ imports: [RestaurantModule], controllers: [HubController], providers: [HubSyncService], exports: [HubSyncService] })
export class HubModule {}
