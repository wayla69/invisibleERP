import { Module } from '@nestjs/common';
import { PosTerminalService } from './pos-terminal.service';
import { PosTerminalController, PspWebhookController } from './pos-terminal.controller';

@Module({
  controllers: [PosTerminalController, PspWebhookController],
  providers: [PosTerminalService],
  exports: [PosTerminalService],
})
export class PosTerminalModule {}
