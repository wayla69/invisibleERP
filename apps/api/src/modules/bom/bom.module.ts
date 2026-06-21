import { Module } from '@nestjs/common';
import { BomController, PortalBomController } from './bom.controller';
import { BomService } from './bom.service';

@Module({
  controllers: [BomController, PortalBomController],
  providers: [BomService],
  exports: [BomService],
})
export class BomModule {}
