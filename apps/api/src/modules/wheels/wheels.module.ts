import { Module } from '@nestjs/common';
import { WheelsController } from './wheels.controller';
import { WheelsService } from './wheels.service';
import { DocNumberService } from '../../common/doc-number.service';

// Spin-the-wheel / lucky draw. Reuses the points ledger + coupon wallet; adds only the wheel config + the
// weighted-draw engine. Exported so the member self-service app can offer the same spin.
@Module({
  controllers: [WheelsController],
  providers: [WheelsService, DocNumberService],
  exports: [WheelsService],
})
export class WheelsModule {}
