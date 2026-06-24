import { Module } from '@nestjs/common';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';
import { MemberService } from './member.service';
import { LedgerModule } from '../ledger/ledger.module';

@Module({ imports: [LedgerModule], controllers: [LoyaltyController], providers: [LoyaltyService, MemberService], exports: [LoyaltyService, MemberService] })
export class LoyaltyModule {}
