import { Controller, Get, Post, Param, Query, Body, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MasterDataService, parseCsv } from './masterdata.service';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const ImportBody = z.object({
  mode: z.enum(['append', 'replace']).default('append'),
  format: z.enum(['rows', 'csv']).default('rows'),
  csv: z.string().optional(),
  rows: z.array(z.record(z.any())).optional(),
});
type ImportBodyT = z.infer<typeof ImportBody>;

@Controller('api/admin/master-data')
@Permissions('masterdata')
export class MasterDataController {
  constructor(private readonly svc: MasterDataService) {}

  @Get('entities')
  entities() {
    return this.svc.entities();
  }

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
  import(@Param('entity') entity: string, @Body(new ZodValidationPipe(ImportBody)) b: ImportBodyT, @CurrentUser() u: JwtUser) {
    const rows = b.format === 'csv' ? parseCsv(b.csv ?? '') : (b.rows ?? []);
    return this.svc.importRows(entity, b.mode, rows, u);
  }
}
