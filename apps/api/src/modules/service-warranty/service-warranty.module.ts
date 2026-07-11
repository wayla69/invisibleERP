import { Module } from '@nestjs/common';
import { ServiceWarrantyService } from './service-warranty.service';
import { ServiceWarrantyController } from './service-warranty.controller';

// SVC-2 — Warranty & Entitlement registry (net-new; separate module from the #666 ServiceModule so it does
// not touch the subscription/SLA paths). No GL dependency in v1.
@Module({ providers: [ServiceWarrantyService], controllers: [ServiceWarrantyController], exports: [ServiceWarrantyService] })
export class ServiceWarrantyModule {}
