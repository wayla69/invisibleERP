import { Module } from '@nestjs/common';
import { PosAuditService } from './pos-audit.service';
import { PosAuditController } from './pos-audit.controller';

@Module({ controllers: [PosAuditController], providers: [PosAuditService], exports: [PosAuditService] })
export class PosAuditModule {}
