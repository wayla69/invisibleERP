import { Module } from '@nestjs/common';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';
import { MemberService } from './member.service';

@Module({ controllers: [LoyaltyController], providers: [LoyaltyService, MemberService], exports: [LoyaltyService, MemberService] })
export class LoyaltyModule {}
