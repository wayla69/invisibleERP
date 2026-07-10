import { Module } from '@nestjs/common';
import { HubController } from './hub.controller';
import { HubSyncService } from './hub-sync.service';
import { RestaurantModule } from '../restaurant/restaurant.module';
import { LedgerModule } from '../ledger/ledger.module';
import { InventoryModule } from '../inventory/inventory.module';
import { StockOpsModule } from '../stock-ops/stock-ops.module';

// Store-hub sync (LAN-first, docs/41): Phase 1 signed snapshot export for seeding an in-store hub,
// Phase 2a/2b HMAC-authenticated hub→cloud sales ingest (replays via RestaurantOfflineSyncService),
// Phase 2c till/Z-report + waste + stocktake ingest (BRANCH-05/06/07), Phase 4a hub heartbeat.
@Module({ imports: [RestaurantModule, LedgerModule, InventoryModule, StockOpsModule], controllers: [HubController], providers: [HubSyncService], exports: [HubSyncService] })
export class HubModule {}
