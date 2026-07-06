import { Controller, Get, Post, Param, Query, Body, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MasterDataService } from './masterdata.service';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Import body shared by the admin master-data endpoints and the item-setup IO endpoints. `xlsx` carries a
// base64-encoded workbook so the exact template/export file can be re-imported without a Save-As-CSV step.
export const ImportBody = z.object({
  mode: z.enum(['append', 'replace']).default('append'),
  format: z.enum(['rows', 'csv', 'xlsx']).default('rows'),
  csv: z.string().optional(),
  xlsx: z.string().optional(),
  rows: z.array(z.record(z.any())).optional(),
  skip_errors: z.boolean().optional(),
});
export type ImportBodyT = z.infer<typeof ImportBody>;
const RejectBody = z.object({ reason: z.string().max(500).optional() });

@Controller('api/admin/master-data')
@Permissions('masterdata')
export class MasterDataController {
  constructor(private readonly svc: MasterDataService) {}

  @Get('entities')
  entities() {
    return this.svc.entities();
  }

  // ── Sensitive-import maker-checker (audit G5/G7/G8) — declared before the `:entity/*` routes so these
  //    literal paths win over the `:entity` param. An import that sets a financially-sensitive field
  //    (credit limits, vendor terms, prices, promo discounts) is staged here; a DISTINCT user approves it. ──
  @Get('import-approvals') @Permissions('masterdata', 'exec', 'approvals')
  pendingBatches(@Query('status') status?: string) { return this.svc.listPendingBatches(status); }
  @Post('import-approvals/:reqNo/approve') @Permissions('exec', 'approvals')
  approveBatch(@Param('reqNo') reqNo: string, @CurrentUser() u: JwtUser) { return this.svc.approveBatch(reqNo, u); }
  @Post('import-approvals/:reqNo/reject') @Permissions('exec', 'approvals')
  rejectBatch(@Param('reqNo') reqNo: string, @Body(new ZodValidationPipe(RejectBody)) b: z.infer<typeof RejectBody>, @CurrentUser() u: JwtUser) { return this.svc.rejectBatch(reqNo, u, b.reason); }

  @Get(':entity/export')
  async export(@Param('entity') entity: string, @Query('format') format: string | undefined, @Res() reply: FastifyReply) {
    if (format === 'csv') {
      const csv = await this.svc.exportCsv(entity);
      reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${entity}.csv"`).send(csv);
      return;
    }
    const buf = await this.svc.exportXlsx(entity);
    reply.header('Content-Type', XLSX_MIME).header('Content-Disposition', `attachment; filename="${entity}.xlsx"`).header('Content-Length', buf.length).send(buf);
  }

  @Get(':entity/template')
  async template(@Param('entity') entity: string, @Res() reply: FastifyReply) {
    const buf = await this.svc.templateXlsx(entity);
    reply.header('Content-Type', XLSX_MIME).header('Content-Disposition', `attachment; filename="${entity}_template.xlsx"`).header('Content-Length', buf.length).send(buf);
  }

  @Post(':entity/import')
  async import(@Param('entity') entity: string, @Body(new ZodValidationPipe(ImportBody)) b: ImportBodyT, @CurrentUser() u: JwtUser) {
    const rows = await this.svc.rowsFromInput(b);
    return this.svc.importRows(entity, b.mode, rows, u);
  }

  // Dry-run: validate every row and report all errors, without touching the DB.
  @Post(':entity/import/validate')
  async validate(@Param('entity') entity: string, @Body(new ZodValidationPipe(ImportBody)) b: ImportBodyT, @CurrentUser() u: JwtUser) {
    const rows = await this.svc.rowsFromInput(b);
    return this.svc.validateReport(entity, b.mode, rows, u);
  }

  // Validated commit: by default refuses an import with any bad row (imports nothing); with skip_errors it
  // imports the valid rows and reports the rest. Also reports already-existing rows it skipped (append).
  @Post(':entity/import/checked')
  async importChecked(@Param('entity') entity: string, @Body(new ZodValidationPipe(ImportBody)) b: ImportBodyT, @CurrentUser() u: JwtUser) {
    const rows = await this.svc.rowsFromInput(b);
    return this.svc.importChecked(entity, b.mode, rows, u, b.skip_errors ?? false);
  }
}
