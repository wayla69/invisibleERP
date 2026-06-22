import { Module } from '@nestjs/common';
import { LockingService } from './locking.service';
import { PosScaleController } from './pos-scale.controller';

@Module({ controllers: [PosScaleController], providers: [LockingService], exports: [LockingService] })
export class PosScaleModule {}
