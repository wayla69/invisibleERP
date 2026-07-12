import { Module } from '@nestjs/common';
import { MemberController } from './member.controller';
import { MemberAuthService } from './member-auth.service';
import { MemberGuard } from './member.guard';
import { AuthModule } from '../../auth/auth.module';
import { LoyaltyModule } from '../loyalty.module';
import { RewardsModule } from '../engagement/rewards.module';
import { GamificationModule } from '../engagement/gamification.module';
import { ReferralsModule } from '../engagement/referrals.module';
import { WheelsModule } from '../engagement/wheels.module';
import { PartnersModule } from '../../partners/partners.module';
import { MessagingModule } from '../../messaging/messaging.module';
import { ChannelAdapterModule } from '../../channel-adapter/channel-adapter.module';

// The member self-service app. Reuses the existing loyalty/rewards/gamification/referrals/wheels/partners
// services (tenant-scoped + adversarially reviewed); adds only the phone-OTP auth. AuthModule re-exports
// JwtModule (token signing) + PasswordService (scrypt OTP hashing). MessagingModule supplies
// TenantMessagingService so the OTP SMS uses the tenant's own provider.
@Module({
  imports: [AuthModule, LoyaltyModule, RewardsModule, GamificationModule, ReferralsModule, WheelsModule, PartnersModule, MessagingModule, ChannelAdapterModule],
  controllers: [MemberController],
  providers: [MemberAuthService, MemberGuard],
})
export class MemberModule {}
