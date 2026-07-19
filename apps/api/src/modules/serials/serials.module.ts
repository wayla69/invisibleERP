import { Module } from '@nestjs/common';
import { SerialsController } from './serials.controller';
import { SerialsService } from './serials.service';

// docs/52 Phase 3b — serial/IMEI unit tracking (its own bounded context). SerialsService is re-exported so the
// POS sale path (PortalPosService) can consume serials at sell time.
@Module({ controllers: [SerialsController], providers: [SerialsService], exports: [SerialsService] })
export class SerialsModule {}
