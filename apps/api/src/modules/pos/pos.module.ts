import { Module } from '@nestjs/common';
import { PosController, OrdersController } from './pos.controller';
import { PosService } from './pos.service';
import { SplitController } from './split.controller';
import { SplitBillService } from './split.service';
import { RestaurantModule } from '../restaurant/restaurant.module';
import { PaymentsModule } from '../payments/payments.module';
import { TaxModule } from '../tax/tax.module';

@Module({
  imports: [RestaurantModule, PaymentsModule, TaxModule],
  controllers: [PosController, OrdersController, SplitController],
  providers: [PosService, SplitBillService],
  exports: [PosService],
})
export class PosModule {}
