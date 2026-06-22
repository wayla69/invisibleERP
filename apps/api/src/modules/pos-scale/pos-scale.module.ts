import { Module } from '@nestjs/common';
import { LockingService } from './locking.service';
import { RealtimeService } from './realtime.service';
import { PosScaleController } from './pos-scale.controller';

@Module({ controllers: [PosScaleController], providers: [LockingService, RealtimeService], exports: [LockingService, RealtimeService] })
export class PosScaleModule {}
