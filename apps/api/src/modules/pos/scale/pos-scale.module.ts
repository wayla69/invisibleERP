import { Module } from '@nestjs/common';
import { LockingService } from './locking.service';
import { RealtimeService } from './realtime.service';
import { PosScaleController } from './pos-scale.controller';
import { ChannelAdapterModule } from '../../channel-adapter/channel-adapter.module';

// ChannelAdapterModule is imported so LockingService.recomputeAvailability can mirror local auto-86
// transitions out to the delivery aggregators (POS-7). Acyclic: channel-adapter does not import pos-scale.
@Module({ imports: [ChannelAdapterModule], controllers: [PosScaleController], providers: [LockingService, RealtimeService], exports: [LockingService, RealtimeService] })
export class PosScaleModule {}
