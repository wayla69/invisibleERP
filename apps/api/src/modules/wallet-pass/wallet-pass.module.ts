import { Module } from '@nestjs/common';
import { BiLiveModule } from '../bi/bi-live.module';
import { WalletPassService } from './wallet-pass.service';

// V5 (docs/29) — wallet-pass seam. No controller of its own: the member route lives on MemberController
// (self-scoped) and the staff view on LoyaltyController, both injecting the exported service.
@Module({ imports: [BiLiveModule], providers: [WalletPassService], exports: [WalletPassService] })
export class WalletPassModule {}
