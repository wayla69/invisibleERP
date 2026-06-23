import { Module } from '@nestjs/common';
import { ChannelAdapterService } from './channel-adapter.service';
import { ChannelAdapterController, ChannelWebhookController } from './channel-adapter.controller';
import { RealtimeScope } from '../restaurant/realtime.scope';

@Module({
  controllers: [ChannelAdapterController, ChannelWebhookController],
  providers: [ChannelAdapterService, RealtimeScope],
  exports: [ChannelAdapterService],
})
export class ChannelAdapterModule {}
