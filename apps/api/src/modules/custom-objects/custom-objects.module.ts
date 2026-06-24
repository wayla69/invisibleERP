import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { CustomObjectsService } from './custom-objects.service';
import { CustomObjectsController } from './custom-objects.controller';

// Custom objects (Phase 11 — A1) — tenant-defined record types with no code. Reuses CustomFieldsModule for
// the typed field defs + values (entity = object_key); records get their own registry. DRIZZLE is global.
@Module({
  imports: [CustomFieldsModule],
  controllers: [CustomObjectsController],
  providers: [CustomObjectsService],
  exports: [CustomObjectsService],
})
export class CustomObjectsModule {}
