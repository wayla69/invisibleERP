import { Module } from '@nestjs/common';
import { PosController, OrdersController } from './pos.controller';
import { PosService } from './pos.service';

@Module({ controllers: [PosController, OrdersController], providers: [PosService], exports: [PosService] })
export class PosModule {}
