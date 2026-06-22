import { Module } from '@nestjs/common';
import { BiService } from './bi.service';
import { BiController } from './bi.controller';

@Module({ providers: [BiService], controllers: [BiController], exports: [BiService] })
export class BiModule {}
