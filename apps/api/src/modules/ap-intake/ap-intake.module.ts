import { Module } from '@nestjs/common';
import { ApIntakeController } from './ap-intake.controller';
import { ApIntakeService } from './ap-intake.service';
import { DocAiModule } from '../doc-ai/doc-ai.module';
import { MatchModule } from '../match/match.module';
import { FinanceModule } from '../finance/finance.module';

// AP invoice intake (EXP-10) — composes the doc-ai extractor, the 3-way match, and AP bill booking
// into one scan → PO auto-map → payment-ready pipeline. DocNumber/StatusLog are global.
@Module({
  imports: [DocAiModule, MatchModule, FinanceModule],
  controllers: [ApIntakeController],
  providers: [ApIntakeService],
})
export class ApIntakeModule {}
