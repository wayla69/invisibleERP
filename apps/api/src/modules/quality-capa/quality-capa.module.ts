import { Module } from '@nestjs/common';
import { CapaService } from './capa.service';
import { CapaController } from './capa.controller';

// QMS-2 — CAPA (Corrective & Preventive Action) lifecycle with effectiveness sign-off (control QC-02).
// Net-new, self-contained quality module (no dependency on the QMS-1 NCR tables — a CAPA links to any source
// via a generic source_type/source_ref, not a FK). No GL posting in v1.
@Module({ providers: [CapaService], controllers: [CapaController], exports: [CapaService] })
export class QualityCapaModule {}
