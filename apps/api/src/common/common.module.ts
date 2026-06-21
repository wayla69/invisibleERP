import { Global, Module } from '@nestjs/common';
import { DocNumberService } from './doc-number.service';
import { StatusLogService } from './status-log.service';

@Global()
@Module({
  providers: [DocNumberService, StatusLogService],
  exports: [DocNumberService, StatusLogService],
})
export class CommonModule {}
