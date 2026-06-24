import { Module } from '@nestjs/common';
import { QueryService } from './query.service';
import { QueryController } from './query.controller';

// Semantic layer + pivot/report builder (Phase 14 — A5). Exports QueryService so NL-analytics (B3) can run
// governed queries from a natural-language request. DRIZZLE is global.
@Module({
  controllers: [QueryController],
  providers: [QueryService],
  exports: [QueryService],
})
export class QueryModule {}
