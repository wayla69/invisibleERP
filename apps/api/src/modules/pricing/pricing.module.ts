import { Module } from '@nestjs/common';
import { PricingService } from './pricing.service';
import { PriceBookService } from './price-book.service';
import { PricingController } from './pricing.controller';

// docs/52 Phase 4a — PriceBookService is a sibling bounded sub-service in the pricing context; exported so the
// POS sale path (PortalPosService) can resolve a governed base price before promo discounts.
@Module({ controllers: [PricingController], providers: [PricingService, PriceBookService], exports: [PricingService, PriceBookService] })
export class PricingModule {}
