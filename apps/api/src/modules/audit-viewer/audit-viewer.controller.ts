import { Controller, Get, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Permissions } from '../../common/decorators';
import { qint } from '../../common/query';
import { AuditViewerService, type AuditFilters } from './audit-viewer.service';

// Audit-trail viewer — read-only over the append-only audit_log, gated by `users` (the same admin/compliance
// permission as the access-review). Tenant-scoped by RLS. Pairs with ITGC-AC-10 (tamper-evident audit trail).
@Controller('api/admin/audit')
export class AuditViewerController {
  constructor(private readonly svc: AuditViewerService) {}

  @Get()
  @Permissions('users')
  query(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('actor') actor?: string,
    @Query('action') action?: string,
    @Query('status') status?: string,
    @Query('entity') entity?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const filters: AuditFilters = { actor, action, status, entity, from, to };
    return this.svc.query(filters, Math.min(qint('limit', limit, 50), 200), Math.max(qint('offset', offset, 0), 0));
  }

  @Get('export')
  @Permissions('users')
  async export(
    @Res() reply: FastifyReply,
    @Query('actor') actor?: string,
    @Query('action') action?: string,
    @Query('status') status?: string,
    @Query('entity') entity?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const csv = await this.svc.exportCsv({ actor, action, status, entity, from, to });
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="audit-log.csv"').send(csv);
  }
}
