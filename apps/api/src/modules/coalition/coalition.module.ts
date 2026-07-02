import { Module } from '@nestjs/common';
import { CoalitionController } from './coalition.controller';
import { CoalitionService } from './coalition.service';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { IntercompanyModule } from '../intercompany/intercompany.module';

// W2 (docs/27) — coalition network (LYL-19). Earn/burn rides MemberService's locked earnInTx/redeemInTx
// on the member's HOME ledger; every cross-shop movement posts an intercompany clearing entry
// (IntercompanyService.createIcInternal). No cycle: loyalty → {ledger,bilive,platform,automation},
// intercompany → ledger — none import CoalitionModule.
@Module({
  imports: [LoyaltyModule, IntercompanyModule],
  controllers: [CoalitionController],
  providers: [CoalitionService],
  exports: [CoalitionService],
})
export class CoalitionModule {}
