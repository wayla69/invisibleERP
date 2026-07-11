import { Controller, Get, Post, Body, Param, Query, ParseIntPipe, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { ServiceWarrantyService } from './service-warranty.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

// SVC-2 endpoints live under /api/service/warranty/* so they sit ALONGSIDE the #666 service spine
// (/api/service/contracts|subscriptions|events) without clashing.
//   Reads  → 'exec' | 'marketing' (the service/after-sales read duty)
//   Writes → 'masterdata' for the catalogue/registry; the claim maker-checker splits raise ('exec') from
//            authorize/reject ('approvals'), and the requester≠authorizer rule (SVC-01) is enforced in-app.
const TermBody = z.object({ term_code: z.string().min(1), name: z.string().min(1), coverage_months: z.number().int().positive(), coverage_type: z.enum(['parts', 'labor', 'full']).optional(), active: z.boolean().optional() });
const UnitBody = z.object({ serial_no: z.string().min(1), item_code: z.string().min(1), item_id: z.number().int().optional(), customer_id: z.number().int().optional(), customer_name: z.string().optional(), sold_date: z.string().min(1), warranty_term_id: z.number().int(), warranty_start: z.string().optional() });
const ClaimBody = z.object({ installed_base_id: z.number().int(), fault: z.string().min(1), coverage_kind: z.enum(['parts', 'labor', 'full']).optional(), reported_date: z.string().optional() });
const AuthorizeBody = z.object({ disposition: z.enum(['repair', 'replace']).optional(), charge: z.number().nonnegative().optional() });
const RejectBody = z.object({ reason: z.string().min(1) });

@Controller('api/service/warranty')
export class ServiceWarrantyController {
  constructor(private readonly svc: ServiceWarrantyService) {}

  // ── Terms ──
  @Get('terms')
  @Permissions('exec', 'marketing')
  listTerms(@CurrentUser() user: JwtUser) { return this.svc.listTerms(user); }

  @Post('terms')
  @Permissions('masterdata')
  createTerm(@Body(new ZodValidationPipe(TermBody)) dto: z.infer<typeof TermBody>, @CurrentUser() user: JwtUser) { return this.svc.createTerm(dto, user); }

  // ── Installed base ──
  @Get('units')
  @Permissions('exec', 'marketing')
  listUnits(@CurrentUser() user: JwtUser) { return this.svc.listUnits(user); }

  @Get('units/:id')
  @Permissions('exec', 'marketing')
  getUnit(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.getUnit(id, user); }

  @Post('units')
  @Permissions('masterdata')
  registerUnit(@Body(new ZodValidationPipe(UnitBody)) dto: z.infer<typeof UnitBody>, @CurrentUser() user: JwtUser) { return this.svc.registerUnit(dto, user); }

  // ── Detective reads (before the parametric /claims/:id routes) ──
  @Get('expiring')
  @Permissions('exec', 'marketing')
  expiring(@Query('days') days: string | undefined, @CurrentUser() user: JwtUser) { return this.svc.expiring(Number(days ?? 30), user); }

  @Get('coverage-exceptions')
  @Permissions('exec', 'marketing')
  coverageExceptions(@CurrentUser() user: JwtUser) { return this.svc.coverageExceptions(user); }

  // ── Claims + SVC-01 coverage-authorization control ──
  @Get('claims')
  @Permissions('exec', 'marketing')
  listClaims(@Query('status') status: string | undefined, @CurrentUser() user: JwtUser) { return this.svc.listClaims(user, status); }

  @Post('claims')
  @Permissions('exec')
  createClaim(@Body(new ZodValidationPipe(ClaimBody)) dto: z.infer<typeof ClaimBody>, @CurrentUser() user: JwtUser) { return this.svc.createClaim(dto, user); }

  @Post('claims/:id/authorize')
  @Permissions('approvals')
  @HttpCode(200)
  authorizeClaim(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(AuthorizeBody)) dto: z.infer<typeof AuthorizeBody>, @CurrentUser() user: JwtUser) { return this.svc.authorizeClaim(id, dto, user); }

  @Post('claims/:id/reject')
  @Permissions('approvals')
  @HttpCode(200)
  rejectClaim(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RejectBody)) dto: z.infer<typeof RejectBody>, @CurrentUser() user: JwtUser) { return this.svc.rejectClaim(id, dto, user); }
}
