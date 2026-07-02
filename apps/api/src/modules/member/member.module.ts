import { Module } from '@nestjs/common';
import { MemberController } from './member.controller';
import { MemberAuthService } from './member-auth.service';
import { MemberGuard } from './member.guard';
import { AuthModule } from '../auth/auth.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { RewardsModule } from '../rewards/rewards.module';
import { GamificationModule } from '../gamification/gamification.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { WheelsModule } from '../wheels/wheels.module';
import { PartnersModule } from '../partners/partners.module';
import { MessagingModule } from '../messaging/messaging.module';

// The member self-service app. Reuses the existing loyalty/rewards/gamification/referrals/wheels/partners
// services (tenant-scoped + adversarially reviewed); adds only the phone-OTP auth. AuthModule re-exports
// JwtModule (token signing) + PasswordService (scrypt OTP hashing). MessagingModule supplies
// TenantMessagingService so the OTP SMS uses the tenant's own provider.
@Module({
  imports: [AuthModule, LoyaltyModule, RewardsModule, GamificationModule, ReferralsModule, WheelsModule, PartnersModule, MessagingModule],
  controllers: [MemberController],
  providers: [MemberAuthService, MemberGuard],
})
export class MemberModule {}
