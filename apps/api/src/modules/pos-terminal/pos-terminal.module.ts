import { Module } from '@nestjs/common';
import { PosTerminalService } from './pos-terminal.service';
import { PosTerminalController, PspWebhookController } from './pos-terminal.controller';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [PaymentsModule],
  controllers: [PosTerminalController, PspWebhookController],
  providers: [PosTerminalService],
  exports: [PosTerminalService],
})
export class PosTerminalModule {}
