import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { ObjectLayoutsService } from './object-layouts.service';
import { ObjectLayoutsController } from './object-layouts.controller';

// Object layouts (Phase 12 — A2) — no-code form/layout designer for custom objects (Phase 11). Resolves a
// stored layout against the object's live field defs (via CustomFieldsModule). DRIZZLE is global.
@Module({
  imports: [CustomFieldsModule],
  controllers: [ObjectLayoutsController],
  providers: [ObjectLayoutsService],
  exports: [ObjectLayoutsService],
})
export class ObjectLayoutsModule {}
