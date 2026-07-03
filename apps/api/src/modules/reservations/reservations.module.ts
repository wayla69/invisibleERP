import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { CommitmentsModule } from '../commitments/commitments.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

// Stock reservation → issue-to-project (M3, docs/32, INV-13). Needs the valued inventory ledger
// (InventoryModule → issueToProject: relieve 1200 into project WIP 1260) and the commitment ledger
// (CommitmentsModule → book the issued value against the BoQ line). One-way imports → no DI cycle.
@Module({
  imports: [InventoryModule, CommitmentsModule],
  controllers: [ReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
