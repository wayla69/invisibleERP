import { Module } from '@nestjs/common';
import { PosTerminalService } from './pos-terminal.service';
import { PosTerminalController, PspWebhookController } from './pos-terminal.controller';
import { PaymentsModule } from '../payments/payments.module';
import { RealtimeScope } from '../restaurant/realtime.scope';

@Module({
  imports: [PaymentsModule],
  controllers: [PosTerminalController, PspWebhookController],
  providers: [PosTerminalService, RealtimeScope],
  exports: [PosTerminalService],
})
export class PosTerminalModule {}
