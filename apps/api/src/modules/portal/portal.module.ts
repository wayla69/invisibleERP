import { Module } from '@nestjs/common';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';
import { PortalPosService } from './portal.pos.service';
import { PortalMyErpService } from './portal.myerp.service';

@Module({
  controllers: [PortalController],
  providers: [PortalService, PortalPosService, PortalMyErpService],
  exports: [PortalService],
})
export class PortalModule {}
