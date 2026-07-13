import { Inject, Injectable, NotFoundException, ConflictException, BadRequestException, Optional } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants } from '../../database/schema';
import { logger } from '../../observability/logger';
import { PlatformNotificationsService } from '../platform-notifications/platform-notifications.module';
import { wipeTenantRefs, tenantIdColumns } from './tenant-wipe';

// Purge NEVER touches audit_log — the ITGC-AC-16 tamper-evident hash chain is append-only (DB-enforced;
// a DELETE against it fails regardless of a preserve-set), and per an explicit product decision the audit
// trail survives even a permanent purge. Because audit_log.tenant_id keeps a live row, the tenants row
// itself is NEVER deleted either — purge wipes everything else (business data, users, subscriptions,
// AI/usage meters) but the company record + its audit history remain, permanently inaccessible (no users).
const PURGE_PRESERVE = new Set(['audit_log']);

// Tenant soft-delete + purge (migration 0393, god-only). Two independent, escalating lifecycle actions:
// deleteTenant (SUSPENDED companies only) does NOT touch any business data, it only flags the tenant row —
// a deleted tenant drops out of the Platform Console fleet list/switcher and its users are PERMANENTLY
// blocked (TENANT_DELETED) independent of suspended_at, reversible via restoreTenant. purgeTenant (already
// -DELETED companies only — delete → purge) is the follow-up, IRREVERSIBLE step that wipes every other
// tenant-scoped row (business data, users, subscriptions, AI/usage meters) but always preserves audit_log
// (ITGC-AC-16) and therefore the tenants row itself. Kept as its own provider (docs/46 Phase 0) rather than
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
    const [t] = await this.db.select({ id: tenants.id, code: tenants.code, deletedAt: tenants.deletedAt, purgedAt: tenants.purgedAt }).from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found', messageTh: 'ไม่พบบริษัท' });
    if (!t.deletedAt)
      throw new ConflictException({ code: 'TENANT_NOT_DELETED', message: 'Company is not deleted', messageTh: 'บริษัทนี้ยังไม่ถูกลบ' });
    if (t.purgedAt)
      throw new ConflictException({ code: 'TENANT_PURGED', message: 'This company was permanently purged and cannot be restored', messageTh: 'บริษัทนี้ถูกล้างถาวรแล้ว กู้คืนไม่ได้' });

    await this.db.update(tenants).set({ deletedAt: null, deletedBy: null }).where(eq(tenants.id, id));
    logger.info({ event: 'tenant_restored', tenant_id: id, by }, 'company restored');
    await this.platformNotifs?.emit({ type: 'tenant_restored', title: `กู้คืนบริษัท #${id} (${t.code})`, body: `โดย ${by} — บริษัทยังระงับอยู่ ต้องกดคืนสถานะแยกต่างหาก`, tenantId: id, refType: 'tenant', refId: String(id) });
    return { tenant_id: id, status: 'restored' };
  }

  // Tenant PURGE (god-only, already-SOFT-DELETED companies only) — the actual "make the junk go away"
  // step: deletes every OTHER tenant-scoped row (business data, users, subscriptions, AI/usage meters —
  // PURGE_PRESERVE above). NEVER touches audit_log (ITGC-AC-16 append-only chain, by explicit product
  // decision) — so the tenants row itself also survives, kept only as that audit trail's anchor.
  // IRREVERSIBLE. Gated behind deleteTenant on purpose (delete → purge, mirroring suspend → reset): a
  // company must already be soft-deleted (and therefore was already suspended) before it can be purged, so
  // nothing gets permanently erased in one click from an active company.
  async purgeTenant(id: number, by: string, confirm: string) {
    const [t] = await this.db.select({ id: tenants.id, code: tenants.code, deletedAt: tenants.deletedAt, purgedAt: tenants.purgedAt }).from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found', messageTh: 'ไม่พบบริษัท' });
    if (!t.deletedAt)
      throw new ConflictException({ code: 'TENANT_NOT_DELETED', message: 'Soft-delete the company first — purge only runs on an already-deleted company (delete → purge)', messageTh: 'ต้องลบบริษัทก่อนจึงจะล้างถาวรได้ (ลบ → ล้างถาวร)' });
    if (t.purgedAt)
      throw new ConflictException({ code: 'TENANT_ALREADY_PURGED', message: 'Company has already been purged', messageTh: 'บริษัทนี้ถูกล้างถาวรไปแล้ว' });
    if ((confirm ?? '').trim() !== t.code)
      throw new BadRequestException({ code: 'CONFIRM_MISMATCH', message: 'Type the company code exactly to confirm the permanent purge', messageTh: `พิมพ์รหัสบริษัท "${t.code}" ให้ตรงเพื่อยืนยันการล้างถาวร` });

    const { targeted, rowsDeleted } = await wipeTenantRefs(
      this.db, id, await tenantIdColumns(this.db), PURGE_PRESERVE, 'PURGE_BLOCKED',
      (names) => `Purge blocked — tables still referenced: ${names}`,
      () => 'ล้างถาวรไม่สำเร็จ — มีตารางที่ยังถูกอ้างอิงอยู่',
    );
    await this.db.update(tenants).set({ purgedAt: new Date(), purgedBy: by }).where(eq(tenants.id, id));

    logger.warn({ event: 'tenant_purged', tenant_id: id, code: t.code, by, tables: targeted, rows: rowsDeleted }, 'company permanently purged (audit_log preserved)');
    await this.platformNotifs?.emit({ type: 'tenant_purged', title: `ล้างถาวรบริษัท #${id} (${t.code})`, body: `โดย ${by} — ลบ ${rowsDeleted} แถวจาก ${targeted} ตาราง (เก็บบันทึกตรวจสอบไว้ตามข้อกำหนด)`, tenantId: id, refType: 'tenant', refId: String(id) });
    return { tenant_id: id, status: 'purged', tables_wiped: targeted, rows_deleted: rowsDeleted };
  }
}
