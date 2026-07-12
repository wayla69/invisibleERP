import { Module } from '@nestjs/common';
import { ChannelAdapterService } from './channel-adapter.service';
import { ChannelCustomerRefsService } from './channel-customer-refs.service';
import { ChannelAdapterController, ChannelWebhookController } from './channel-adapter.controller';
import { RealtimeScope } from '../restaurant/realtime.scope';

@Module({
  controllers: [ChannelAdapterController, ChannelWebhookController],
  providers: [ChannelAdapterService, ChannelCustomerRefsService, RealtimeScope],
  exports: [ChannelAdapterService, ChannelCustomerRefsService],
})
export class ChannelAdapterModule {}
