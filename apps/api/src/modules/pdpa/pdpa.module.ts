import { Module } from '@nestjs/common';
import { PdpaService } from './pdpa.service';
import { PdpaController } from './pdpa.controller';

// PDPA (Thailand) compliance — DSAR workflow, subject-data export, erasure + audit pseudonymisation.
// Exports PdpaService so the audit viewer can mask erased subjects at read-time.
@Module({
  controllers: [PdpaController],
  providers: [PdpaService],
  exports: [PdpaService],
})
export class PdpaModule {}
