import { Controller, Get, Post, Delete, Param, Query, Body, Res, BadRequestException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { StatutoryFsService } from './statutory-fs.service';
import { StatutoryFsReviewsService } from './statutory-fs-reviews.service';
import { ReportPdfService } from './reports-pdf.service';

const SubmitReviewBody = z.object({
  fiscal_year: z.number().int().min(2000).max(3000),
  ledger: z.string().optional(),
  industry: z.string().optional(),
});
type SubmitReviewBodyT = z.infer<typeof SubmitReviewBody>;
const ApproveReviewBody = z.object({ self_approval_reason: z.string().optional() });
type ApproveReviewBodyT = z.infer<typeof ApproveReviewBody>;

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
  constructor(
    private readonly svc: StatutoryFsService,
    private readonly reviews: StatutoryFsReviewsService,
    private readonly pdf: ReportPdfService,
  ) {}

  // ── FS issuance review & approval (GL-29, maker-checker) ──
  // A preparer submits a fiscal year's statements for review (snapshot + hash of the key figures); a DIFFERENT
  // user approves it — the approved review then drives the FS pack's "reviewed & approved" stamp (vs "unaudited").
  @Post('statement-pack/submit')
  submitReview(@Body(new ZodValidationPipe(SubmitReviewBody)) body: SubmitReviewBodyT, @CurrentUser() user: JwtUser) {
    return this.reviews.submit({ fiscalYear: body.fiscal_year, ledger: body.ledger || null, industry: body.industry || null }, user);
  }

  // Body is OPTIONAL (approval needs none; an SME self-approval may carry a justification).
  @Post('statement-reviews/:id/approve')
  approveReview(@Param('id') id: string, @Body() body: ApproveReviewBodyT | undefined, @CurrentUser() user: JwtUser) {
    const n = parseInt(id, 10);
    if (!n) throw new BadRequestException({ code: 'FS_REVIEW_BAD_ID', message: 'numeric review id required', messageTh: 'ต้องระบุรหัสรายการเป็นตัวเลข' });
    const parsed = ApproveReviewBody.safeParse(body ?? {});
    return this.reviews.approve(n, user, parsed.success ? parsed.data : {});
  }

  @Get('statement-reviews')
  listReviews(@Query('fiscal_year') fiscalYear?: string) {
    const fy = fiscalYear ? parseInt(fiscalYear, 10) : undefined;
    return this.reviews.list(fy || undefined);
  }

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

  // ── Formatted statutory FS pack (P9) — BS + PL + SOCE + optional notes as one A4 PDF ──
  // Thai-forward bilingual captions, comparative column, per-statement KPIs. `fiscal_year=YYYY` is a shortcut
  // that fills from/as_of + the prior year; otherwise pass from/as_of (+ prior_*) explicitly. Streams a PDF
  // when Chromium/PDF service is available, else falls back to the raw HTML (same degrade as other PDF routes).
  @Get('statement-pack.pdf')
  async statementPackPdf(
    @Res() reply: FastifyReply,
    @Query('fiscal_year') fiscalYear?: string,
    @Query('as_of') asOf?: string,
    @Query('from') from?: string,
    @Query('prior_as_of') priorAsOf?: string,
    @Query('prior_from') priorFrom?: string,
    @Query('ledger') ledger?: string,
    @Query('industry') industry?: string,
    @Query('notes_code') notesCode?: string,
    @Query('comparative') comparative?: string,
  ) {
    let p = { from, asOf, priorFrom, priorAsOf };
    const fy = fiscalYear ? parseInt(fiscalYear, 10) : NaN;
    if (fy) {
      const wantComp = comparative == null ? true : comparative === '1' || comparative === 'true';
      p = {
        from: `${fy}-01-01`, asOf: `${fy}-12-31`,
        priorFrom: wantComp ? `${fy - 1}-01-01` : undefined,
        priorAsOf: wantComp ? `${fy - 1}-12-31` : undefined,
      };
    }
    if (!p.from || !p.asOf) {
      throw new BadRequestException({ code: 'FS_RANGE_REQUIRED', message: 'fiscal_year, or from + as_of, is required', messageTh: 'ต้องระบุปีบัญชี หรือ from และ as_of' });
    }
    const pack: any = await this.svc.statementPack({
      asOf: p.asOf, from: p.from, priorAsOf: p.priorAsOf, priorFrom: p.priorFrom,
      ledger: ledger || null, industry: industry || null, notesCode: notesCode || null,
    });
    // GL-29: stamp the pack with its issuance review, but only for a FULL fiscal-year pack (the statutory
    // issuance case) — the review snapshot is annual, so a partial-period pack must stay "unaudited".
    const fyy = Number(String(p.asOf).slice(0, 4));
    if (p.from === `${fyy}-01-01` && p.asOf === `${fyy}-12-31`) {
      pack.review = await this.reviews.latestApproved(fyy, ledger || null);
    }
    const html = this.pdf.financialStatementPackHtml(pack);
    const pdf = await this.pdf.renderHtmlToPdf(html);
    const fname = `financial-statements-${p.asOf}.pdf`;
    if (pdf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${fname}"`).header('Content-Length', pdf.length).send(pdf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  // ── TFRS 15 revenue disaggregation (P10) — by category + timing of transfer, per industry ──
  @Get('revenue-disaggregation')
  revenueDisagg(
    @Query('as_of') asOf?: string,
    @Query('from') from?: string,
    @Query('prior_as_of') priorAsOf?: string,
    @Query('prior_from') priorFrom?: string,
    @Query('ledger') ledger?: string,
    @Query('industry') industry?: string,
  ) {
    if (!asOf || !from) throw new BadRequestException({ code: 'FS_RANGE_REQUIRED', message: 'as_of and from are required', messageTh: 'ต้องระบุ as_of และ from' });
    return this.svc.revenueDisaggregation({ asOf, from, priorAsOf, priorFrom, ledger: ledger || null, industry: industry || null });
  }

  // ── Industry layouts a viewer can pick between for the built-in DBD-PL / DBD-BS ──
  @Get('industry-layouts')
  industryLayouts() {
    return this.svc.industryLayouts();
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
