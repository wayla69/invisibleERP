import { Module } from '@nestjs/common';
import { PosControlService } from './pos-control.service';
import { PosControlController } from './pos-control.controller';
import { PosAuditModule } from '../audit/pos-audit.module';

@Module({ imports: [PosAuditModule], controllers: [PosControlController], providers: [PosControlService], exports: [PosControlService] })
export class PosControlModule {}
