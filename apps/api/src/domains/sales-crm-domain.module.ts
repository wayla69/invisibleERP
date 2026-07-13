import { Module } from '@nestjs/common';
import { CustomersModule } from '../modules/customers/customers.module';
import { CrmModule } from '../modules/crm/crm.module';
import { MarketingModule } from '../modules/marketing/marketing.module';
import { LoyaltyModule } from '../modules/loyalty/loyalty.module';
import { CampaignsModule } from '../modules/campaigns/campaigns.module';
import { JourneysModule } from '../modules/journeys/journeys.module';
import { PartnersModule } from '../modules/partners/partners.module';
import { MemberModule } from '../modules/loyalty/member/member.module';
import { CoalitionModule } from '../modules/coalition/coalition.module';
import { NpsModule } from '../modules/nps/nps.module';
import { GiftCardsModule } from '../modules/giftcards/gift-card.module';
import { RetentionModule } from '../modules/retention/retention.module';
import { CpqModule } from '../modules/cpq/cpq.module';
import { PricingModule } from '../modules/pricing/pricing.module';
import { ServiceModule } from '../modules/service/service.module';
import { ServiceWarrantyModule } from '../modules/service-warranty/service-warranty.module';
import { ServiceCasesModule } from '../modules/service-cases/service-cases.module';
import { ServiceKbModule } from '../modules/service-kb/service-kb.module';
import { ReputationModule } from '../modules/reputation/reputation.module';

// docs/46 Phase 5 — customer & revenue front office (customers · CRM · loyalty · marketing · CPQ/pricing · service desk) aggregate.
// Pure WIRING: no providers/controllers of its own — it only groups the domain's feature modules so
// app.module.ts reads as ~10 domains instead of a 140-line flat array, ownership is legible, and a new
// feature module lands as a one-line change HERE (merge conflicts stay local to the domain). Cosmetic for
// DI: Nest registers the transitive imports identically; cross-module injection still flows through each
// feature module's own imports/exports.
@Module({
  imports: [
    CustomersModule,
    CrmModule,
    MarketingModule,
    LoyaltyModule,
    CampaignsModule,
    JourneysModule,
    PartnersModule,
    MemberModule,
    CoalitionModule,
    NpsModule,
    GiftCardsModule,
    RetentionModule,
    CpqModule,
    PricingModule,
    ServiceModule,
    ServiceWarrantyModule,
    ServiceCasesModule,
    ServiceKbModule,
    ReputationModule,
  ],
  // Re-export every member so providers the feature modules export stay visible to AppModule's own
  // injector context (the APP_GUARD/APP_INTERCEPTOR providers resolve there — e.g. JwtAuthGuard's
  // ApiKeyService) exactly as when the modules were direct imports.
  exports: [
    CustomersModule,
    CrmModule,
    MarketingModule,
    LoyaltyModule,
    CampaignsModule,
    JourneysModule,
    PartnersModule,
    MemberModule,
    CoalitionModule,
    NpsModule,
    GiftCardsModule,
    RetentionModule,
    CpqModule,
    PricingModule,
    ServiceModule,
    ServiceWarrantyModule,
    ServiceCasesModule,
    ServiceKbModule,
    ReputationModule,
  ],
})
export class SalesCrmDomainModule {}
