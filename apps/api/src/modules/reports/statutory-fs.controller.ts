import { Controller, Get, Post, Delete, Param, Query, Body, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { StatutoryFsService } from './statutory-fs.service';

const GroupSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  labelTh: z.string().optional(),
  level: z.number().int().optional(),
  normalSide: z.enum(['debit', 'credit']).optional(),
  accounts: z.array(z.string()).optional(),
  prefixes: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  sumOf: z.array(z.object({ key: z.string(), factor: z.number() })).optional(),
  showAccounts: z.boolean().optional(),
});
const NoteSchema = z.object({
  number: z.string().min(1),
  title: z.string().min(1),
  titleTh: z.string().optional(),
  policyText: z.string().optional(),
  policyTextTh: z.string().optional(),
  normalSide: z.enum(['debit', 'credit']).optional(),
  accounts: z.array(z.string()).optional(),
  prefixes: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
});
const UpsertBody = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  statement_type: z.enum(['bs', 'pl', 'soce', 'notes']),
  config: z.object({ groups: z.array(GroupSchema).optional(), notes: z.array(NoteSchema).optional() }).default({}),
  active: z.boolean().optional(),
});
type UpsertBodyT = z.infer<typeof UpsertBody>;

// FIN-4 — Statutory FS pack. The configurable financial-report builder (row-grouping + comparative columns)
// plus the three audit-pack outputs it rides on: statement of changes in equity, note schedules, and the
// DBD e-Filing (Thai งบการเงิน XBRL / S-form) export. Read-only over the audited GL (fin_report/exec); the
// layout definitions are maintained by the close approver (gl_close/exec).
@Controller('api/reports/fs')
@Permissions('fin_report', 'exec')
export class StatutoryFsController {
  constructor(private readonly svc: StatutoryFsService) {}

  // ── Report-definition CRUD (the buyer's own FS layouts) ──
  @Get('definitions')
  listDefs(@Query('statement_type') statementType?: string) {
    return this.svc.listDefinitions(statementType || undefined);
  }

  @Get('definitions/:code')
  getDef(@Param('code') code: string) {
    return this.svc.getDefinition(code);
  }

  @Post('definitions')
  @Permissions('gl_close', 'exec')
  upsertDef(@Body(new ZodValidationPipe(UpsertBody)) body: UpsertBodyT, @CurrentUser() user: JwtUser) {
    return this.svc.upsertDefinition(body, user.username);
  }

  @Delete('definitions/:code')
  @Permissions('gl_close', 'exec')
  deleteDef(@Param('code') code: string) {
    return this.svc.deleteDefinition(code);
  }

  // ── Rendered statement (P&L / BS with buyer row-groups + comparative column) ──
  // `industry` (P6) picks which industry's bespoke DBD-PL layout to render, overriding the tenant's own —
  // 'generic' forces the standard multi-step P&L, empty auto-resolves from the tenant's industry.
  @Get('render/:code')
  render(
    @Param('code') code: string,
    @Query('as_of') asOf?: string,
    @Query('from') from?: string,
    @Query('prior_as_of') priorAsOf?: string,
    @Query('prior_from') priorFrom?: string,
    @Query('ledger') ledger?: string,
    @Query('industry') industry?: string,
  ) {
    return this.svc.renderStatement(code, { asOf, from, priorAsOf, priorFrom, ledger: ledger || null, industry: industry || null });
  }

  // ── Industry P&L layouts a viewer can pick between for the built-in DBD-PL ──
  @Get('industry-layouts')
  industryLayouts() {
    return this.svc.industryPlLayouts();
  }

  // ── Statement of changes in equity (roll-forward) ──
  @Get('changes-in-equity')
  soce(@Query('from') from: string, @Query('to') to: string, @Query('ledger') ledger?: string) {
    if (!from || !to) throw new BadRequestException({ code: 'FS_RANGE_REQUIRED', message: 'from and to are required', messageTh: 'ต้องระบุ from และ to' });
    return this.svc.statementOfChangesInEquity({ from, to, ledger: ledger || null });
  }

  // ── Note schedules (per-note account mapping + comparative + policy text) ──
  @Get('notes/:code')
  notes(
    @Param('code') code: string,
    @Query('as_of') asOf?: string,
    @Query('from') from?: string,
    @Query('prior_as_of') priorAsOf?: string,
    @Query('prior_from') priorFrom?: string,
    @Query('ledger') ledger?: string,
    @Query('basis') basis?: string,
  ) {
    const b = basis === 'pl' ? 'pl' : 'bs';
    return this.svc.noteSchedules(code, { asOf, from, priorAsOf, priorFrom, ledger: ledger || null, basis: b });
  }

  // ── DBD e-Filing export (Thai งบการเงิน — XBRL / S-form) ──
  @Get('dbd-export')
  dbd(
    @Query('fiscal_year') fiscalYear: string,
    @Query('ledger') ledger?: string,
    @Query('taxpayer_name') taxpayerName?: string,
    @Query('taxpayer_id') taxpayerId?: string,
  ) {
    const fy = parseInt(fiscalYear, 10);
    if (!fy) throw new BadRequestException({ code: 'FS_BAD_FISCAL_YEAR', message: 'fiscal_year required (YYYY)', messageTh: 'ต้องระบุปีบัญชี' });
    return this.svc.dbdExport({ fiscalYear: fy, ledger: ledger || null, taxpayerName, taxpayerId });
  }
}
