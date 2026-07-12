import { Module } from '@nestjs/common';
import { DisclosureController } from './disclosure.controller';
import { DisclosureService } from './disclosure.service';

// CLS-02 (control GL-26) — Disclosure / close-package checklist (governed close binder). DRIZZLE +
// DocNumberService are global (CommonModule @Global). Detective/monitoring; posts nothing to the GL.
@Module({
  controllers: [DisclosureController],
  providers: [DisclosureService],
  exports: [DisclosureService],
})
export class DisclosureModule {}
