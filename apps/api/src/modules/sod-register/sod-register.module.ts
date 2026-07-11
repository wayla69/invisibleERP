import { Module } from '@nestjs/common';
import { SodRegisterService } from './sod-register.service';
import { SodRegisterController } from './sod-register.controller';

// GRC-5 (ITGC-AC-22): SoD-Conflict Register + Compensating-Control governance — the detective + accepted-risk
// layer over the existing preventive SoD enforcement. Read-only aggregation over users/user_permissions plus
// the sod_conflict_dispositions register; no new enforcement rule.
@Module({
  controllers: [SodRegisterController],
  providers: [SodRegisterService],
  exports: [SodRegisterService],
})
export class SodRegisterModule {}
