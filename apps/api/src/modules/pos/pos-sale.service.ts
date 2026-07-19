import { Inject, Injectable, ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { PortalPosService, type PortalSaleDto } from '../portal/portal.pos.service';
import { PosProfileService } from './pos-profile.service';

// docs/52 Phase 1b — the INTERNAL register's generic (non-restaurant) checkout.
// Reuses the already-generic PortalPosService.createSale engine (a direct cust_pos_sales write + stock move +
// VAT + loyalty + tender-to-till, with NO dine_in_orders / KDS / table / course), so a retail or services
// business rings a plain sale that never touches the restaurant order path. The revenue posts under the
// business-type profile's event (SALE.GOODS / SALE.SERVICE); a restaurant tenant keeps the dine-in checkout.
@Injectable()
export class PosSaleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly portalPos: PortalPosService,
    private readonly profile: PosProfileService,
  ) {}

  // POST /api/pos/sales — resolve the caller's tenant + profile server-side, then ring the generic sale.
  async createGenericSale(dto: PortalSaleDto, user: JwtUser) {
    if (user.tenantId == null) {
      // an HQ/platform (tenant-less) session has no single store to sell into.
      throw new ForbiddenException({ code: 'NO_TENANT', message: 'Select a company to ring a sale', messageTh: 'เลือกบริษัทก่อนทำรายการขาย' });
    }
    const prof = await this.profile.resolve(user);
    // Internal users' customerName is the tenant NAME, not its CODE, so portal.tenantId can't resolve them —
    // pass the tenant explicitly (resolved from the JWT tenantId).
    const [t] = await this.db.select({ id: tenants.id, code: tenants.code }).from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);
    if (!t) throw new ForbiddenException({ code: 'NO_TENANT', message: 'Tenant not found', messageTh: 'ไม่พบร้านค้า' });
    return this.portalPos.createSale(dto, user, { tenant: { id: Number(t.id), code: t.code }, revenueEvent: prof.revenue_event });
  }
}
