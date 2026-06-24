import { Module } from '@nestjs/common';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';
import { DocNumberService } from '../../common/doc-number.service';

// Partner privileges. Exported so the member self-service app can browse + claim privileges.
@Module({
  controllers: [PartnersController],
  providers: [PartnersService, DocNumberService],
  exports: [PartnersService],
})
export class PartnersModule {}
