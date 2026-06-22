import { Module } from '@nestjs/common';
import { CpqService } from './cpq.service';
import { CpqController } from './cpq.controller';

@Module({ providers: [CpqService], controllers: [CpqController], exports: [CpqService] })
export class CpqModule {}
