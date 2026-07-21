import { Module } from '@nestjs/common';
import { InventoryModule } from '../modules/inventory/inventory.module';
import { ProcurementModule } from '../modules/procurement/procurement.module';
import { BomModule } from '../modules/bom/bom.module';
import { MatchModule } from '../modules/match/match.module';
import { SourcingModule } from '../modules/sourcing/sourcing.module';
import { CostingModule } from '../modules/costing/costing.module';
import { LandedCostModule } from '../modules/landed-cost/landed-cost.module';
import { WmsModule } from '../modules/wms/wms.module';
import { StockOpsModule } from '../modules/stock-ops/stock-ops.module';
import { ClaimsModule } from '../modules/claims/claims.module';
import { LotsModule } from '../modules/lots/lots.module';
import { SerialsModule } from '../modules/serials/serials.module';
import { ScanModule } from '../modules/scan/scan.module';
import { MasterDataModule } from '../modules/masterdata/masterdata.module';
import { ItemSetupModule } from '../modules/item-setup/item-setup.module';
import { SupplierModule } from '../modules/supplier/supplier.module';
import { ManufacturingModule } from '../modules/manufacturing/manufacturing.module';
import { MfgDepthModule } from '../modules/mfg-depth/mfg-depth.module';
import { QualityModule } from '../modules/quality/quality.module';
import { QualityCapaModule } from '../modules/quality-capa/quality-capa.module';
import { ScmPlanningModule } from '../modules/scm-planning/scm-planning.module';

// docs/46 Phase 5 — procure-to-pay & make-to-stock (inventory · procurement · sourcing · costing · WMS · lots · manufacturing · quality · master data) aggregate.
// Pure WIRING: no providers/controllers of its own — it only groups the domain's feature modules so
// app.module.ts reads as ~10 domains instead of a 140-line flat array, ownership is legible, and a new
// feature module lands as a one-line change HERE (merge conflicts stay local to the domain). Cosmetic for
// DI: Nest registers the transitive imports identically; cross-module injection still flows through each
// feature module's own imports/exports.
@Module({
  imports: [
    InventoryModule,
    ProcurementModule,
    BomModule,
    MatchModule,
    SourcingModule,
    CostingModule,
    LandedCostModule,
    WmsModule,
    StockOpsModule,
    ClaimsModule,
    LotsModule,
    SerialsModule,
    ScanModule,
    MasterDataModule,
    ItemSetupModule,
    SupplierModule,
    ManufacturingModule,
    MfgDepthModule,
    QualityModule,
    QualityCapaModule,
    ScmPlanningModule,
  ],
  // Re-export every member so providers the feature modules export stay visible to AppModule's own
  // injector context (the APP_GUARD/APP_INTERCEPTOR providers resolve there — e.g. JwtAuthGuard's
  // ApiKeyService) exactly as when the modules were direct imports.
  exports: [
    InventoryModule,
    ProcurementModule,
    BomModule,
    MatchModule,
    SourcingModule,
    CostingModule,
    LandedCostModule,
    WmsModule,
    StockOpsModule,
    ClaimsModule,
    LotsModule,
    SerialsModule,
    ScanModule,
    MasterDataModule,
    ItemSetupModule,
    SupplierModule,
    ManufacturingModule,
    MfgDepthModule,
    QualityModule,
    QualityCapaModule,
    ScmPlanningModule,
  ],
})
export class SupplyChainDomainModule {}
