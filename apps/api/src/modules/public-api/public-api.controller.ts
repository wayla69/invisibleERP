import { Controller, Get, Post, Body, Query, UseGuards, HttpCode, Header } from '@nestjs/common';
import { z } from 'zod';
import { Public, CurrentUser, NoTx, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PublicApiGuard, Scopes } from './public-api.guard';
import { PublicApiService } from './public-api.service';
import { PublicLoyaltyService } from './public-loyalty.service';
import { MarketingIntelService, PushSnapshotsBody } from '../marketing-intel/marketing-intel.service';
import { MiExperimentsService } from '../marketing-intel/mi-experiments.service';
import { buildOpenApi } from './openapi';
import { renderApiReferenceHtml } from './api-reference';

const EnrollBody = z.object({ name: z.string().optional(), phone: z.string().optional(), card_no: z.string().optional(), email: z.string().optional(), birthday: z.string().optional(), marketing_opt_in: z.boolean().optional() })
  .refine((d) => d.phone != null || d.card_no != null || d.email != null || d.name != null, { message: 'at least one identifier required' });
// net_spend is bounded (pentest info-item): an unbounded money field on a public endpoint is an overflow /
// abuse vector. 10,000,000 THB per single earn call is far above any real transaction.
const EarnBody = z.object({ member_id: z.number().int().positive(), net_spend: z.number().positive().max(10_000_000), ref_doc: z.string().optional() });
const RedeemBody = z.object({ member_id: z.number().int().positive(), points: z.number().int().positive(), ref_doc: z.string().optional() });

// Public REST API, v1. API-key authenticated (Bearer ierp_…), scope-gated, per-key rate-limited.
// The global JwtAuthGuard authenticates the key; PublicApiGuard (below) enforces key-only access,
// scopes, and the rate limit. The discovery root + OpenAPI doc are @Public (open, no key).
@Controller('api/v1')
@UseGuards(PublicApiGuard)
export class PublicApiController {
  constructor(
    private readonly svc: PublicApiService,
    private readonly loyalty: PublicLoyaltyService,
    private readonly mi: MarketingIntelService,
    private readonly experiments: MiExperimentsService,
  ) {}

  // ── Discovery (open) ────────────────────────────────────────────────
  @Get()
  @Public()
  @NoTx()
  root() {
    return {
      name: 'Invisible ERP Public API',
      version: 'v1',
      documentation: '/api/v1/openapi.json',
      authentication: 'Bearer ierp_… (API key)',
      endpoints: ['/api/v1/me', '/api/v1/items', '/api/v1/inventory', '/api/v1/orders', '/api/v1/invoices', '/api/v1/sales/daily', '/api/v1/customers/transactions', '/api/v1/marketing/experiment-outcomes', '/api/v1/analytics/snapshots', '/api/v1/loyalty/member', '/api/v1/loyalty/enroll', '/api/v1/loyalty/earn', '/api/v1/loyalty/redeem'],
    };
  }

  @Get('openapi.json')
  @Public()
  @NoTx()
  openapi() {
    return buildOpenApi();
  }

  // Human-facing, self-contained HTML reference for the same curated contract (2.12 — developer portal).
  // No external assets (CSP-safe, offline); the machine-readable spec stays at /api/v1/openapi.json.
  @Get('docs')
  @Public()
  @NoTx()
  @Header('Content-Type', 'text/html; charset=utf-8')
  docs() {
    return renderApiReferenceHtml();
  }

  // ── Key identity (valid key, no specific scope) ─────────────────────
  @Get('me')
  @NoTx()
  me(@CurrentUser() u: JwtUser) {
    // Report the machine identity (apikey:<prefix>) as the principal — a stable public-API contract. The
    // internal `username` is the minting human (H-2, for maker-checker), which the public API doesn't expose.
    const principal = u.apiKeyPrefix ? `apikey:${u.apiKeyPrefix}` : u.username;
    return { principal, tenant_id: u.tenantId, scopes: u.scopes ?? [], version: 'v1' };
  }

  // ── Scoped read endpoints ───────────────────────────────────────────
  @Get('items')
  @Scopes('catalog:read')
  items(@Query('limit') limit?: string, @Query('offset') offset?: string, @Query('q') q?: string, @Query('category') category?: string) {
    return this.svc.items({ limit, offset, q, category });
  }

  @Get('inventory')
  @Scopes('inventory:read')
  inventory(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.svc.inventory({ limit, offset });
  }

  @Get('orders')
  @Scopes('orders:read')
  orders(@Query('limit') limit?: string, @Query('offset') offset?: string, @Query('status') status?: string) {
    return this.svc.orders({ limit, offset, status });
  }

  @Get('invoices')
  @Scopes('invoices:read')
  invoices(@Query('limit') limit?: string, @Query('offset') offset?: string, @Query('status') status?: string) {
    return this.svc.invoices({ limit, offset, status });
  }

  // ── Analytics reads (Marketing Intelligence integration) ────────────
  @Get('sales/daily')
  @Scopes('analytics:read')
  salesDaily(@Query('from') from?: string, @Query('to') to?: string, @Query('group_by') groupBy?: string) {
    return this.svc.salesDaily({ from, to, group_by: groupBy });
  }

  @Get('customers/transactions')
  @Scopes('analytics:read')
  customerTransactions(@Query('from') from?: string, @Query('to') to?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.svc.customerTransactions({ from, to, limit, offset });
  }

  // ── Loyalty write API (Phase C2) — enrol / earn / redeem + read a member. Fires loyalty.* webhooks. ──
  @Get('loyalty/member')
  @Scopes('loyalty:read')
  loyaltyMember(@Query('code') code: string | undefined, @Query('phone') phone: string | undefined, @Query('card') card: string | undefined, @CurrentUser() u: JwtUser) {
    return this.loyalty.member({ code, phone, card }, u);
  }

  @Post('loyalty/enroll')
  @Scopes('loyalty:write')
  loyaltyEnroll(@Body(new ZodValidationPipe(EnrollBody)) b: any, @CurrentUser() u: JwtUser) { return this.loyalty.enroll(b, u); }

  @Post('loyalty/earn')
  @Scopes('loyalty:write')
  @HttpCode(200)
  loyaltyEarn(@Body(new ZodValidationPipe(EarnBody)) b: any, @CurrentUser() u: JwtUser) { return this.loyalty.earn(b, u); }

  @Post('loyalty/redeem')
  @Scopes('loyalty:write')
  @HttpCode(200)
  loyaltyRedeem(@Body(new ZodValidationPipe(RedeemBody)) b: any, @CurrentUser() u: JwtUser) { return this.loyalty.redeem(b, u); }

  // ── Analytics push-back (docs/48 phase 3) — the Marketing Intelligence Platform posts its computed
  // MMM / RFM / TOWS results here; the ERP stores them tenant-scoped and renders /marketing-intel. ──
  @Post('analytics/snapshots')
  @Scopes('analytics:write')
  @HttpCode(200)
  pushAnalytics(@Body(new ZodValidationPipe(PushSnapshotsBody)) b: any, @CurrentUser() u: JwtUser) { return this.mi.pushSnapshots(b, u); }

  // ── Closed-loop pull-back (docs/60 Phase 3) — the platform pulls measured campaign LIFT so the next MMM
  // fit can use realised incrementality as a regressor (the loop's feedback edge). Read-only, tenant-scoped. ──
  @Get('marketing/experiment-outcomes')
  @Scopes('analytics:read')
  experimentOutcomes(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) {
    return this.experiments.outcomes(u, limit ? Number(limit) : 100);
  }
}
