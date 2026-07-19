// FA-11 / FA-12 — QR asset tags, scan-driven custody maker-checker, audit-by-scan, and the physical-
// verification report surfaces (docs/46 god-service burn-down round 4). Plain class constructed in the
// AssetsService ctor BODY (not a DI provider); the facade keeps thin delegators and its positional ctor
// contract. Bodies moved VERBATIM from assets.service.ts. No GL effect anywhere in this class — it owns
// the PHYSICAL side of the register (where an asset is, who holds it, and whether it was recently seen).
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, asc, desc, sql, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { fixedAssets, assetMovements, assetScanRequests, assetAudits, assetAuditScans } from '../../database/schema';
import type { DocNumberService } from '../../common/doc-number.service';
import type { QrService } from '../qr/qr.service';
import { n, ymd } from '../../database/queries';
import { buildAssetQrPayload, parseQrPayload } from '@ierp/shared';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';

export class AssetsCustodyService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly qr: QrService,
  ) {}

  // ── QR asset tags ──────────────────────────────────────────────────────
  private async findAsset(assetNo: string, user: JwtUser) {
    const db = this.db;
    const conds = [eq(fixedAssets.assetNo, assetNo)];
    if (user.tenantId != null) conds.push(eq(fixedAssets.tenantId, user.tenantId)); // explicit predicate under Admin bypass
    const [a] = await db.select().from(fixedAssets).where(and(...conds)).limit(1);
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Asset not found', messageTh: 'ไม่พบสินทรัพย์' });
    return a;
  }

  async assetQr(assetNo: string, user: JwtUser) {
    const a = await this.findAsset(assetNo, user);
    const payload = buildAssetQrPayload({ assetNo: a.assetNo, name: a.name, loc: a.location ?? '', cat: '' });
    return { asset_no: a.assetNo, payload, data_url: await this.qr.dataUrl(payload) };
  }

  async assetLabels(_user: JwtUser, opts: { status?: string; cols?: number; rows?: number }) {
    const db = this.db;
    const where = opts.status ? eq(fixedAssets.status, opts.status as typeof fixedAssets.$inferSelect.status) : undefined;
    const rows = await db.select().from(fixedAssets).where(where).orderBy(asc(fixedAssets.assetNo));
    const labels = rows.map((a: any) => ({
      payload: buildAssetQrPayload({ assetNo: a.assetNo, name: a.name, loc: a.location ?? '', cat: '' }),
      title: a.assetNo,
      subtitle: a.name,
      lines: [a.location ? `📍 ${a.location}` : '', a.status].filter(Boolean) as string[],
      badge: 'ASSET TAG',
    }));
    return this.qr.labelsPdf(labels, opts.cols ?? 2, opts.rows ?? 4);
  }

  // Scan an asset tag → verify presence or REQUEST a custody change (FA-11 maker-checker).
  // Confirming the current location/holder (no change) logs a non-approval 'Scan Verify' movement.
  // Any change to location/holder raises a PendingApproval custody request (NO register write here);
  // a DIFFERENT user must approve before the register moves (see approveCustody). No GL effect.
  async scanUpdate(dto: { code: string; location?: string; assigned_to?: string; note?: string }, user: JwtUser) {
    const parsed = parseQrPayload(dto.code);
    const assetNo = (parsed.ASSET_ID || parsed.ITEM_ID || dto.code || '').trim();
    if (!assetNo) throw new BadRequestException({ code: 'NO_CODE', message: 'No asset code in QR', messageTh: 'ไม่พบรหัสทรัพย์สินใน QR' });
    const db = this.db;
    return db.transaction(async (tx: any) => {
      const conds = [eq(fixedAssets.assetNo, assetNo)];
      if (user.tenantId != null) conds.push(eq(fixedAssets.tenantId, user.tenantId));
      const [a] = await tx.select().from(fixedAssets).where(and(...conds)).limit(1).for('update');
      if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: `Asset ${assetNo} not found`, messageTh: 'ไม่พบสินทรัพย์' });
      const curLoc = a.location ?? null;
      const curAssigned = a.assignedTo ?? null;
      const locChanged = dto.location !== undefined && (dto.location || null) !== curLoc;
      const assignedChanged = dto.assigned_to !== undefined && (dto.assigned_to || null) !== curAssigned;

      if (!locChanged && !assignedChanged) {
        // Presence confirmed — log a verification movement immediately (no approval needed).
        await tx.insert(assetMovements).values({
          tenantId: a.tenantId ?? user.tenantId ?? null, assetId: Number(a.id), assetNo: a.assetNo,
          moveType: 'Scan Verify', fromLocation: curLoc, toLocation: curLoc,
          fromStatus: a.status, toStatus: a.status, note: dto.note ?? null, byUser: user.username,
        });
        return { asset_no: a.assetNo, status: 'verified', location: curLoc, assigned_to: curAssigned };
      }

      // A move — raise a maker-checker custody-change request; the register does NOT move yet.
      const reqNo = await this.docNo.nextDaily('FAC');
      const toLoc = locChanged ? (dto.location || null) : curLoc;
      const toAssigned = assignedChanged ? (dto.assigned_to || null) : curAssigned;
      await tx.insert(assetScanRequests).values({
        tenantId: a.tenantId ?? user.tenantId ?? null, reqNo, assetId: Number(a.id), assetNo: a.assetNo,
        fromLocation: curLoc, toLocation: toLoc, fromAssignedTo: curAssigned, toAssignedTo: toAssigned,
        note: dto.note ?? null, source: 'scan', status: 'PendingApproval', requestedBy: user.username,
      });
      return { asset_no: a.assetNo, status: 'pending', request_no: reqNo, from_location: curLoc, to_location: toLoc, requested_by: user.username };
    });
  }

  // FA-11 — approve a pending custody change. Approver MUST differ from the requester (binds even Admin).
  async approveCustody(reqNo: string, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    return db.transaction(async (tx: any) => {
      const conds = [eq(assetScanRequests.reqNo, reqNo)];
      if (user.tenantId != null) conds.push(eq(assetScanRequests.tenantId, user.tenantId));
      const [req] = await tx.select().from(assetScanRequests).where(and(...conds)).limit(1).for('update');
      if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: `Custody request ${reqNo} not found`, messageTh: 'ไม่พบคำขอย้ายทรัพย์สิน' });
      if (req.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Request ${reqNo} is ${req.status}, not pending`, messageTh: 'คำขอนี้ไม่ได้รออนุมัติ' });
      await assertMakerChecker(tx, { user, maker: req.requestedBy, event: 'fa.custody.approve', ref: reqNo, reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a custody change you requested', messageTh: 'แยกหน้าที่: ผู้ขอไม่สามารถอนุมัติการย้ายทรัพย์สินของตนเองได้' });
      const [a] = await tx.select().from(fixedAssets).where(eq(fixedAssets.id, Number(req.assetId))).limit(1).for('update');
      if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: `Asset ${req.assetNo} not found`, messageTh: 'ไม่พบสินทรัพย์' });
      await tx.update(fixedAssets).set({ location: req.toLocation, assignedTo: req.toAssignedTo }).where(eq(fixedAssets.id, a.id));
      await tx.insert(assetMovements).values({
        tenantId: a.tenantId ?? user.tenantId ?? null, assetId: Number(a.id), assetNo: a.assetNo,
        moveType: 'Scan Update', fromLocation: req.fromLocation, toLocation: req.toLocation,
        fromStatus: a.status, toStatus: a.status, note: `${req.note ? req.note + ' — ' : ''}custody ${reqNo} requested by ${req.requestedBy}`, byUser: user.username,
      });
      await tx.update(assetScanRequests).set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() }).where(eq(assetScanRequests.id, Number(req.id)));
      return { request_no: reqNo, asset_no: a.assetNo, status: 'approved', location: req.toLocation, assigned_to: req.toAssignedTo, approved_by: user.username, requested_by: req.requestedBy };
    });
  }

  async rejectCustody(reqNo: string, user: JwtUser, reason?: string) {
    const db = this.db;
    const conds = [eq(assetScanRequests.reqNo, reqNo)];
    if (user.tenantId != null) conds.push(eq(assetScanRequests.tenantId, user.tenantId));
    const [req] = await db.select().from(assetScanRequests).where(and(...conds)).limit(1);
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: `Custody request ${reqNo} not found`, messageTh: 'ไม่พบคำขอย้ายทรัพย์สิน' });
    if (req.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Request ${reqNo} is ${req.status}, not pending`, messageTh: 'คำขอนี้ไม่ได้รออนุมัติ' });
    await db.update(assetScanRequests).set({ status: 'Rejected', rejectReason: reason ?? null }).where(eq(assetScanRequests.id, Number(req.id)));
    return { request_no: reqNo, status: 'rejected', rejected_by: user.username };
  }

  async listCustodyRequests(status: string | undefined, _user: JwtUser) {
    const db = this.db;
    const where = status ? eq(assetScanRequests.status, status) : undefined;
    const rows = await db.select().from(assetScanRequests).where(where).orderBy(desc(assetScanRequests.id)).limit(200);
    return {
      requests: rows.map((r: any) => ({
        request_no: r.reqNo, asset_no: r.assetNo, from_location: r.fromLocation, to_location: r.toLocation,
        from_assigned_to: r.fromAssignedTo, to_assigned_to: r.toAssignedTo, source: r.source, audit_no: r.auditNo,
        status: r.status, requested_by: r.requestedBy, approved_by: r.approvedBy, note: r.note,
      })),
      count: rows.length,
    };
  }

  // ── FA-11 / audit-by-scan ──────────────────────────────────────────────
  private assetsAtLocation(user: JwtUser, location: string | null) {
    const conds = [sql`${fixedAssets.status} <> 'disposed'`];
    if (user.tenantId != null) conds.push(eq(fixedAssets.tenantId, user.tenantId));
    if (location != null) conds.push(eq(fixedAssets.location, location));
    return this.db.select().from(fixedAssets).where(and(...conds));
  }

  async openAudit(dto: { location?: string }, user: JwtUser) {
    const location = dto.location?.trim() || null;
    const expected = await this.assetsAtLocation(user, location);
    const auditNo = await this.docNo.nextDaily('AUD');
    await this.db.insert(assetAudits).values({
      tenantId: user.tenantId ?? null, auditNo, location, status: 'Open',
      expectedCount: expected.length, createdBy: user.username,
    });
    return { audit_no: auditNo, location, expected_count: expected.length, status: 'Open' };
  }

  async scanAudit(auditNo: string, dto: { code: string; client_uuid?: string }, user: JwtUser) {
    const db = this.db;
    const aConds = [eq(assetAudits.auditNo, auditNo)];
    if (user.tenantId != null) aConds.push(eq(assetAudits.tenantId, user.tenantId));
    const [audit] = await db.select().from(assetAudits).where(and(...aConds)).limit(1);
    if (!audit) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Audit not found', messageTh: 'ไม่พบการตรวจนับ' });
    if (audit.status !== 'Open') throw new BadRequestException({ code: 'AUDIT_CLOSED', message: 'Audit is closed', messageTh: 'การตรวจนับถูกปิดแล้ว' });
    const parsed = parseQrPayload(dto.code);
    const assetNo = (parsed.ASSET_ID || parsed.ITEM_ID || dto.code || '').trim();
    if (!assetNo) throw new BadRequestException({ code: 'NO_CODE', message: 'No asset code in QR', messageTh: 'ไม่พบรหัสทรัพย์สินใน QR' });
    // Offline replay guard: a client_uuid already recorded for this audit is a no-op.
    if (dto.client_uuid) {
      const [dup] = await db.select().from(assetAuditScans)
        .where(and(eq(assetAuditScans.auditNo, auditNo), eq(assetAuditScans.clientUuid, dto.client_uuid))).limit(1);
      if (dup) return { audit_no: auditNo, asset_no: dup.assetNo, result: dup.result, register_location: dup.registerLocation, deduped: true };
    }
    const rConds = [eq(fixedAssets.assetNo, assetNo)];
    if (user.tenantId != null) rConds.push(eq(fixedAssets.tenantId, user.tenantId));
    const [a] = await db.select().from(fixedAssets).where(and(...rConds)).limit(1);
    let result: 'Found' | 'Misplaced' | 'Unknown';
    let registerLocation: string | null = null;
    if (!a || a.status === 'disposed') result = 'Unknown';
    else {
      registerLocation = a.location ?? null;
      result = audit.location == null || (a.location ?? null) === audit.location ? 'Found' : 'Misplaced';
    }
    await db.insert(assetAuditScans).values({
      tenantId: user.tenantId ?? null, auditNo, assetNo, result, registerLocation,
      clientUuid: dto.client_uuid ?? null, scannedBy: user.username,
    });
    return { audit_no: auditNo, asset_no: assetNo, result, register_location: registerLocation, deduped: false };
  }

  async getAudit(auditNo: string, user: JwtUser) {
    const db = this.db;
    const aConds = [eq(assetAudits.auditNo, auditNo)];
    if (user.tenantId != null) aConds.push(eq(assetAudits.tenantId, user.tenantId));
    const [audit] = await db.select().from(assetAudits).where(and(...aConds)).limit(1);
    if (!audit) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Audit not found', messageTh: 'ไม่พบการตรวจนับ' });
    const scans = await db.select().from(assetAuditScans).where(eq(assetAuditScans.auditNo, auditNo)).orderBy(desc(assetAuditScans.id));
    type ScanRow = { assetNo: string; result: string; registerLocation: string | null };
    const seen = new Map<string, ScanRow>();
    for (const s of scans as ScanRow[]) if (!seen.has(s.assetNo)) seen.set(s.assetNo, s); // latest scan per asset
    const found = [...seen.values()].filter((s) => s.result === 'Found').map((s) => s.assetNo);
    const misplaced = [...seen.values()].filter((s) => s.result === 'Misplaced').map((s) => ({ asset_no: s.assetNo, register_location: s.registerLocation }));
    const unknown = [...seen.values()].filter((s) => s.result === 'Unknown').map((s) => s.assetNo);
    const expected = await this.assetsAtLocation(user, audit.location ?? null);
    const scannedSet = new Set(seen.keys());
    const missing = (expected as { assetNo: string; name: string }[]).filter((a) => !scannedSet.has(a.assetNo)).map((a) => ({ asset_no: a.assetNo, name: a.name }));
    return {
      audit_no: audit.auditNo, location: audit.location, status: audit.status, expected_count: audit.expectedCount,
      summary: { found: found.length, missing: missing.length, misplaced: misplaced.length, unknown: unknown.length },
      found, missing, misplaced, unknown,
    };
  }

  // Close an audit → raise a custody-change request (FA-11) for each misplaced asset, proposing to move it
  // to the audited location. Those requests go through the same maker-checker approval as a scanned move.
  async closeAudit(auditNo: string, user: JwtUser) {
    const db = this.db;
    return db.transaction(async (tx: any) => {
      const aConds = [eq(assetAudits.auditNo, auditNo)];
      if (user.tenantId != null) aConds.push(eq(assetAudits.tenantId, user.tenantId));
      const [audit] = await tx.select().from(assetAudits).where(and(...aConds)).limit(1).for('update');
      if (!audit) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Audit not found', messageTh: 'ไม่พบการตรวจนับ' });
      if (audit.status === 'Closed') return { audit_no: auditNo, status: 'Closed', already: true, custody_requests_raised: 0 };
      let raised = 0;
      if (audit.location != null) {
        const scans = await tx.select().from(assetAuditScans).where(eq(assetAuditScans.auditNo, auditNo));
        const misplaced = new Map<string, any>();
        for (const s of scans as { assetNo: string; result: string; registerLocation: string | null }[]) if (s.result === 'Misplaced' && !misplaced.has(s.assetNo)) misplaced.set(s.assetNo, s);
        for (const s of misplaced.values()) {
          const [pending] = await tx.select().from(assetScanRequests)
            .where(and(eq(assetScanRequests.assetNo, s.assetNo), eq(assetScanRequests.status, 'PendingApproval'))).limit(1);
          if (pending) continue; // one custody request pending per asset
          const [a] = await tx.select().from(fixedAssets).where(eq(fixedAssets.assetNo, s.assetNo)).limit(1);
          const reqNo = await this.docNo.nextDaily('FAC');
          await tx.insert(assetScanRequests).values({
            tenantId: user.tenantId ?? null, reqNo, assetId: a ? Number(a.id) : null, assetNo: s.assetNo,
            fromLocation: s.registerLocation, toLocation: audit.location, fromAssignedTo: a?.assignedTo ?? null, toAssignedTo: a?.assignedTo ?? null,
            note: `Audit ${auditNo}: found at ${audit.location}`, source: 'audit', auditNo, status: 'PendingApproval', requestedBy: user.username,
          });
          raised++;
        }
      }
      await tx.update(assetAudits).set({ status: 'Closed', closedAt: new Date(), closedBy: user.username }).where(eq(assetAudits.id, audit.id));
      return { audit_no: auditNo, status: 'Closed', custody_requests_raised: raised };
    });
  }

  async listAudits(user: JwtUser, limit = 50) {
    const rows = await this.db.select().from(assetAudits).orderBy(desc(assetAudits.id)).limit(limit);
    return { audits: rows.map((r: any) => ({ audit_no: r.auditNo, location: r.location, status: r.status, expected_count: r.expectedCount, created_by: r.createdBy })), count: rows.length };
  }

  // Audit results as a report surface (BI report_type 'asset_audit'): recent audits with their scan tallies,
  // plus the outstanding custody-change exceptions awaiting approval. Read-only aggregation over FA-11 data.
  async auditReport(user: JwtUser, opts?: { limit?: number }) {
    const db = this.db;
    const audits = await db.select().from(assetAudits).orderBy(desc(assetAudits.id)).limit(opts?.limit ?? 50);
    const tallies = await db.select({ auditNo: assetAuditScans.auditNo, result: assetAuditScans.result, c: sql<number>`count(distinct ${assetAuditScans.assetNo})` })
      .from(assetAuditScans).groupBy(assetAuditScans.auditNo, assetAuditScans.result);
    const byAudit = new Map<string, { found: number; misplaced: number; unknown: number }>();
    for (const t of tallies as { auditNo: string; result: string; c: number }[]) {
      const m = byAudit.get(t.auditNo) ?? { found: 0, misplaced: 0, unknown: 0 };
      if (t.result === 'Found') m.found = Number(t.c);
      else if (t.result === 'Misplaced') m.misplaced = Number(t.c);
      else if (t.result === 'Unknown') m.unknown = Number(t.c);
      byAudit.set(t.auditNo, m);
    }
    const auditRows = (audits as { auditNo: string; location: string | null; status: string; expectedCount: number; createdBy: string | null; closedBy: string | null }[]).map((a) => {
      const t = byAudit.get(a.auditNo) ?? { found: 0, misplaced: 0, unknown: 0 };
      return { audit_no: a.auditNo, location: a.location, status: a.status, expected: a.expectedCount, found: t.found, misplaced: t.misplaced, unknown: t.unknown, missing: Math.max(0, a.expectedCount - t.found), created_by: a.createdBy, closed_by: a.closedBy };
    });
    const pending = await db.select().from(assetScanRequests).where(eq(assetScanRequests.status, 'PendingApproval')).orderBy(desc(assetScanRequests.id)).limit(100);
    const custodyRows = (pending as { reqNo: string; assetNo: string; fromLocation: string | null; toLocation: string | null; source: string; requestedBy: string | null }[]).map((r) => ({ request_no: r.reqNo, asset_no: r.assetNo, from_location: r.fromLocation, to_location: r.toLocation, source: r.source, requested_by: r.requestedBy }));
    const totals = auditRows.reduce((acc, r) => ({ audits: acc.audits + 1, found: acc.found + r.found, missing: acc.missing + r.missing, misplaced: acc.misplaced + r.misplaced, unknown: acc.unknown + r.unknown }), { audits: 0, found: 0, missing: 0, misplaced: 0, unknown: 0 });
    return { audits: auditRows, custody_exceptions: custodyRows, totals: { ...totals, pending_custody: custodyRows.length } };
  }

  // FA-12 (detective): active assets not physically verified within N days. "Verified" = a Scan Verify /
  // Scan Update movement; a never-verified asset falls back to its acquisition date (implicit receipt).
  // Read-only — powers the schedulable BI report_type 'asset_verification_exceptions'.
  async unverifiedAssets(user: JwtUser, opts?: { days?: number }) {
    const days = opts?.days && opts.days > 0 ? Math.floor(opts.days) : 90;
    const db = this.db;
    const aConds = [sql`${fixedAssets.status} = 'active'`];
    if (user.tenantId != null) aConds.push(eq(fixedAssets.tenantId, user.tenantId));
    const assets = await db.select().from(fixedAssets).where(and(...aConds));
    const moves = await db.select({ assetNo: assetMovements.assetNo, last: sql<string>`max(${assetMovements.moveDate})` })
      .from(assetMovements).where(inArray(assetMovements.moveType, ['Scan Verify', 'Scan Update'])).groupBy(assetMovements.assetNo);
    const lastByAsset = new Map<string, string>();
    for (const m of moves as { assetNo: string | null; last: string }[]) if (m.assetNo) lastByAsset.set(m.assetNo, m.last);
    const now = Date.now();
    const dayMs = 86_400_000;
    const exceptions: { asset_no: string; name: string; location: string | null; assigned_to: string | null; last_verified: string | null; last_seen: string | null; days_since: number; ever_verified: boolean }[] = [];
    for (const a of assets as { assetNo: string; name: string; location: string | null; assignedTo: string | null; acquireDate: string | null }[]) {
      const lastVerifyRaw = lastByAsset.get(a.assetNo);
      const lastSeen = lastVerifyRaw ? new Date(lastVerifyRaw) : a.acquireDate ? new Date(a.acquireDate) : null;
      const ageMs = lastSeen ? now - lastSeen.getTime() : Infinity;
      if (ageMs > days * dayMs) {
        exceptions.push({
          asset_no: a.assetNo, name: a.name, location: a.location ?? null, assigned_to: a.assignedTo ?? null,
          last_verified: lastVerifyRaw ? ymd(new Date(lastVerifyRaw)) : null,
          last_seen: lastSeen ? ymd(lastSeen) : null,
          days_since: Number.isFinite(ageMs) ? Math.floor(ageMs / dayMs) : -1,
          ever_verified: !!lastVerifyRaw,
        });
      }
    }
    exceptions.sort((x, y) => y.days_since - x.days_since);
    return { days, count: exceptions.length, total_active: assets.length, exceptions };
  }
}
