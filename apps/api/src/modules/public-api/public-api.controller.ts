import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public, CurrentUser, NoTx, type JwtUser } from '../../common/decorators';
import { PublicApiGuard, Scopes } from './public-api.guard';
import { PublicApiService } from './public-api.service';
import { buildOpenApi } from './openapi';

// Public REST API, v1. API-key authenticated (Bearer ierp_…), scope-gated, per-key rate-limited.
// The global JwtAuthGuard authenticates the key; PublicApiGuard (below) enforces key-only access,
// scopes, and the rate limit. The discovery root + OpenAPI doc are @Public (open, no key).
@Controller('api/v1')
@UseGuards(PublicApiGuard)
export class PublicApiController {
  constructor(private readonly svc: PublicApiService) {}

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
      endpoints: ['/api/v1/me', '/api/v1/items', '/api/v1/inventory', '/api/v1/orders', '/api/v1/invoices'],
    };
  }

  @Get('openapi.json')
  @Public()
  @NoTx()
  openapi() {
    return buildOpenApi();
  }

  // ── Key identity (valid key, no specific scope) ─────────────────────
  @Get('me')
  @NoTx()
  me(@CurrentUser() u: JwtUser) {
    return { principal: u.username, tenant_id: u.tenantId, scopes: u.scopes ?? [], version: 'v1' };
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
}
