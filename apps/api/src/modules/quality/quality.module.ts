import { Module } from '@nestjs/common';
import { CoaService } from './coa.service';
import { CoaController } from './coa.controller';

// QMS-3 — Certificate of Analysis (CoA) capture + out-of-spec release approval (QC-03). Read-only over the
// lot ledger (references lot_no); adds spec/CoA/results capture with the QC-03 deviation maker-checker.
@Module({ controllers: [CoaController], providers: [CoaService], exports: [CoaService] })
export class QualityModule {}
