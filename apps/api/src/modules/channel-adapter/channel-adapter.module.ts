import { Module } from '@nestjs/common';
import { ChannelAdapterService } from './channel-adapter.service';
import { ChannelAdapterController, ChannelWebhookController } from './channel-adapter.controller';

@Module({
  controllers: [ChannelAdapterController, ChannelWebhookController],
  providers: [ChannelAdapterService],
  exports: [ChannelAdapterService],
})
export class ChannelAdapterModule {}
