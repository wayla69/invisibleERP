import { Module } from '@nestjs/common';
import { PosModule } from '../modules/pos/pos.module';
import { RestaurantModule } from '../modules/restaurant/restaurant.module';
import { MenuModule } from '../modules/menu/menu.module';
import { ReturnsModule } from '../modules/returns/returns.module';
import { DeliveryModule } from '../modules/delivery/delivery.module';
import { ReservationsModule } from '../modules/reservations/reservations.module';
import { ChannelAdapterModule } from '../modules/channel-adapter/channel-adapter.module';
import { BranchModule } from '../modules/branch/branch.module';
import { HubModule } from '../modules/hub/hub.module';

// docs/46 Phase 5 — front-of-house operations (POS · restaurant · menu · returns · delivery · reservations · channels · branch/hub) aggregate.
// Pure WIRING: no providers/controllers of its own — it only groups the domain's feature modules so
// app.module.ts reads as ~10 domains instead of a 140-line flat array, ownership is legible, and a new
// feature module lands as a one-line change HERE (merge conflicts stay local to the domain). Cosmetic for
// DI: Nest registers the transitive imports identically; cross-module injection still flows through each
// feature module's own imports/exports.
@Module({
  imports: [
    PosModule,
    RestaurantModule,
    MenuModule,
    ReturnsModule,
    DeliveryModule,
    ReservationsModule,
    ChannelAdapterModule,
    BranchModule,
    HubModule,
  ],
  // Re-export every member so providers the feature modules export stay visible to AppModule's own
  // injector context (the APP_GUARD/APP_INTERCEPTOR providers resolve there — e.g. JwtAuthGuard's
  // ApiKeyService) exactly as when the modules were direct imports.
  exports: [
    PosModule,
    RestaurantModule,
    MenuModule,
    ReturnsModule,
    DeliveryModule,
    ReservationsModule,
    ChannelAdapterModule,
    BranchModule,
    HubModule,
  ],
})
export class OperationsDomainModule {}
