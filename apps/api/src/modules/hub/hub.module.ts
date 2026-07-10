import { Module } from '@nestjs/common';
import { HubController } from './hub.controller';
import { HubSyncService } from './hub-sync.service';

// Store-hub sync (LAN-first Phase 1, docs/41): signed snapshot export for seeding an in-store hub.
@Module({ controllers: [HubController], providers: [HubSyncService], exports: [HubSyncService] })
export class HubModule {}
