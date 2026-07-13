import { Inject, Injectable, NotFoundException, ConflictException, BadRequestException, Optional } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants } from '../../database/schema';
import { logger } from '../../observability/logger';
import { PlatformNotificationsService } from '../platform-notifications/platform-notifications.module';

// Tenant soft-delete (migration 0386, god-only, SUSPENDED companies only) — a lighter-weight lifecycle
// action than BillingService.factoryResetTenant: it does NOT touch any business data, it only flags the
// tenant row itself. A deleted tenant drops out of the Platform Console fleet list/company-switcher and
// its users are PERMANENTLY blocked at the auth guard (TENANT_DELETED), independent of suspended_at — so
// restoring a deleted tenant does not silently re-open logins until reactivate is also called separately.
// Reversible via restoreTenant. Same two-step safety as factory-reset (suspend → delete) so an actively
// used company can never be deleted in one click. Kept as its own provider (docs/46 Phase 0) rather than
// appended to billing.service.ts, which is already at its LOC ratchet baseline.
@Injectable()
export class TenantLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly platformNotifs?: PlatformNotificationsService,
  ) {}

  async deleteTenant(id: number, by: string, confirm: string) {
    const [t] = await this.db
      .select({ id: tenants.id, code: tenants.code, suspendedAt: tenants.suspendedAt, deletedAt: tenants.deletedAt })
      .from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found', messageTh: 'ไม่พบบริษัท' });
    if (t.deletedAt)
      throw new ConflictException({ code: 'TENANT_ALREADY_DELETED', message: 'Company is already deleted', messageTh: 'บริษัทนี้ถูกลบไปแล้ว' });
    if (!t.suspendedAt)
      throw new ConflictException({ code: 'TENANT_NOT_SUSPENDED', message: 'Suspend the company first — delete only runs on a suspended company (suspend → delete)', messageTh: 'ต้องระงับบริษัทก่อนจึงจะลบได้ (ระงับ → ลบ)' });
    if ((confirm ?? '').trim() !== t.code)
      throw new BadRequestException({ code: 'CONFIRM_MISMATCH', message: 'Type the company code exactly to confirm deletion', messageTh: `พิมพ์รหัสบริษัท "${t.code}" ให้ตรงเพื่อยืนยันการลบ` });

    await this.db.update(tenants).set({ deletedAt: new Date(), deletedBy: by }).where(eq(tenants.id, id));
    logger.warn({ event: 'tenant_deleted', tenant_id: id, by }, 'company deleted (soft)');
    await this.platformNotifs?.emit({ type: 'tenant_deleted', title: `ลบบริษัท #${id} (${t.code})`, body: `โดย ${by}`, tenantId: id, refType: 'tenant', refId: String(id) });
    return { tenant_id: id, status: 'deleted' };
  }

  async restoreTenant(id: number, by: string) {
    const [t] = await this.db.select({ id: tenants.id, code: tenants.code, deletedAt: tenants.deletedAt }).from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found', messageTh: 'ไม่พบบริษัท' });
    if (!t.deletedAt)
      throw new ConflictException({ code: 'TENANT_NOT_DELETED', message: 'Company is not deleted', messageTh: 'บริษัทนี้ยังไม่ถูกลบ' });

    await this.db.update(tenants).set({ deletedAt: null, deletedBy: null }).where(eq(tenants.id, id));
    logger.info({ event: 'tenant_restored', tenant_id: id, by }, 'company restored');
    await this.platformNotifs?.emit({ type: 'tenant_restored', title: `กู้คืนบริษัท #${id} (${t.code})`, body: `โดย ${by} — บริษัทยังระงับอยู่ ต้องกดคืนสถานะแยกต่างหาก`, tenantId: id, refType: 'tenant', refId: String(id) });
    return { tenant_id: id, status: 'restored' };
  }
}
