import { Module } from '@nestjs/common';
import { DocAiService } from './doc-ai.service';
import { DocAiController } from './doc-ai.controller';

// Document-AI intake (Phase 16 — B2). Self-contained: Claude when a key is set, deterministic regex otherwise.
@Module({
  controllers: [DocAiController],
  providers: [DocAiService],
  exports: [DocAiService], // AP-intake (scan → PO auto-map) reuses the extractor
})
export class DocAiModule {}
