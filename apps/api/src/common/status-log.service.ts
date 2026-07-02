import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE, type DrizzleDb } from '../database/database.module';
import { docStatusLog } from '../database/schema';

// แทน _log_status ของ V1 — audit trail polymorphic ทุกชนิดเอกสาร
@Injectable()
export class StatusLogService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async log(docType: string, docNo: string, oldStatus: string, newStatus: string, changedBy: string, remarks?: string) {
    await this.db.insert(docStatusLog).values({
      docType, docNo, oldStatus, newStatus, changedBy: changedBy || 'system', remarks: remarks ?? null,
    });
  }
}
