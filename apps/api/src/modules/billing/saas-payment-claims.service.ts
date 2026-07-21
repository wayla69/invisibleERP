import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE, runGlobalDb, type DrizzleDb } from '../../database/database.module';
import { saasPaymentClaims, subscriptions, plans, tenants } from '../../database/schema';
import { buildPromptPayPayload, isValidPromptPayTarget } from '../payments/promptpay-qr';
import { BillingService } from './billing.service';
import { SaasReceiptsService } from './saas-receipts.service';
import { MailerService } from '../mailer/mailer.service';
import { PlatformNotificationsService } from '../platform-notifications/platform-notifications.module';
import { logger } from '../../observability/logger';

// ── Wave C: Thai payment rails for the platform's own subscription billing ──────────────────────────────
// A tenant that pays by bank transfer / PromptPay (the Thai SME reality — no card, no Stripe) gets a real
// self-serve loop instead of "call the platform owner": GET payment-info shows WHERE to pay (the
// platform's PromptPay QR — dynamic EMVCo payload for the amount due — and/or bank account) and HOW MUCH
// (plan + purchased add-ons via the ONE A3 pricing rule); the tenant then files a slip CLAIM (transfer
// reference + amount). Money is only recognised when a platform owner VERIFIES the claim against the real
// bank statement: approve records the A4 saas_receipt (idempotent on `claim:<id>`) + re-activates the
// subscription (the A2 dunning-recovery signal) + emails the receipt; reject emails the reason. A claim
// is never money — the receipt stays god-verified, so the A4 paper trail cannot be forged by a customer.

const billingUrl = (): string => `${(process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')}/billing`;

@Injectable()
export class SaasPaymentClaimsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly billing: BillingService,
    @Optional() private readonly receipts?: SaasReceiptsService,
    @Optional() private readonly mailer?: MailerService,
    @Optional() private readonly platformNotifs?: PlatformNotificationsService,
  ) {}

  // Where + how much to pay for the caller's own subscription. amount_due is a SUGGESTION (plan price for
  // the subscription's interval + purchased add-ons not already in the plan) — the tenant can claim the
  // amount actually transferred; god verifies against the bank statement either way.
  async paymentInfo(tenantId: number) {
    const [row] = await this.db
      .select({ planCode: subscriptions.planCode, interval: subscriptions.billingInterval, addons: subscriptions.addons, planName: plans.name, priceMonthly: plans.priceMonthly, priceYearly: plans.priceYearly, features: plans.features, code: plans.code })
      .from(subscriptions)
      .leftJoin(plans, eq(subscriptions.planCode, plans.code))
      .where(eq(subscriptions.tenantId, tenantId))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);
    const interval: 'monthly' | 'annual' = row?.interval === 'annual' ? 'annual' : 'monthly';
    const planAmount = row
      ? Number((interval === 'annual' ? row.priceYearly ?? Number(row.priceMonthly ?? 0) * 10 : row.priceMonthly) ?? 0)
      : 0;
    const addonKeys = Array.isArray(row?.addons) ? (row.addons as string[]) : [];
    let addonCharges: { key: string; name: string; amount: number }[] = [];
    try {
      addonCharges = row?.code ? this.billing.resolveAddonCharges({ code: row.code, features: row.features }, interval, 'THB', addonKeys) : [];
    } catch { addonCharges = []; } // an unknown legacy key must not break the info read — it prices as 0
    const amountDue = Math.round((planAmount + addonCharges.reduce((t, c) => t + c.amount, 0)) * 100) / 100;

    const ppId = (process.env.PLATFORM_PROMPTPAY_ID ?? '').trim();
    const promptpayOk = !!ppId && isValidPromptPayTarget(ppId);
    const qrPayload = promptpayOk && amountDue > 0 ? buildPromptPayPayload(ppId, amountDue) : (promptpayOk ? buildPromptPayPayload(ppId) : null);
    // Encode the RAW EMVCo payload (never a deep link) — a banking app must scan it directly.
    const qrImage = qrPayload ? await QRCode.toDataURL(qrPayload, { margin: 1, width: 320, errorCorrectionLevel: 'M' }) : null;
    return {
      plan_code: row?.planCode ?? null,
      plan_name: row?.planName ?? null,
      interval,
      amount_due: amountDue,
      addons: addonCharges.map((c) => ({ key: c.key, amount: c.amount })),
      suggested_period: new Date().toISOString().slice(0, 7),
      promptpay_id: promptpayOk ? ppId : null,
      qr_payload: qrPayload,
      qr_image: qrImage,
      bank_details: (process.env.PLATFORM_BANK_ACCOUNT ?? '').trim() || null,
    };
  }

  // File a slip claim for the caller's own tenant. (tenant, slip_ref) is UNIQUE — refiling the same slip
  // is a 400, not a second Pending row for god to chase.
  async submitClaim(tenantId: number, body: { amount: number; period?: string; slip_ref: string; note?: string }, username: string) {
    const slipRef = body.slip_ref.trim();
    if (!slipRef) throw new BadRequestException({ code: 'SLIP_REF_REQUIRED', message: 'The transfer reference on the slip is required', messageTh: 'กรุณาระบุเลขอ้างอิงการโอนจากสลิป' });
    const inserted = await runGlobalDb('saas-payment-claims:submit', () => this.db.insert(saasPaymentClaims).values({
      aboutTenantId: tenantId,
      amount: String(Math.round(Number(body.amount) * 100) / 100),
      period: body.period ?? null,
      slipRef,
      note: body.note ?? null,
      createdBy: username,
    }).onConflictDoNothing({ target: [saasPaymentClaims.aboutTenantId, saasPaymentClaims.slipRef] }).returning({ id: saasPaymentClaims.id }));
    if (!inserted.length) throw new BadRequestException({ code: 'DUPLICATE_SLIP', message: 'This slip reference was already submitted', messageTh: 'สลิปนี้ถูกส่งเข้ามาแล้ว' });
    const id = Number(inserted[0]!.id);
    // emit is best-effort by contract (never throws) — a notification must not break the claim filing.
    await this.platformNotifs?.emit({
      type: 'payment_claim', title: `แจ้งโอนค่าบริการ ฿${body.amount} รอตรวจสอบ`,
      body: `อ้างอิง ${slipRef} โดย ${username}`, tenantId, refType: 'payment_claim', refId: String(id),
    });
    logger.info({ claim_id: id, tenant_id: tenantId, amount: body.amount }, 'saas payment claim submitted');
    return { id, status: 'Pending' };
  }

  /** A tenant's own claims (BOLA-safe: explicit about_tenant_id filter). */
  async myClaims(tenantId: number, limit = 50) {
    const rows = await this.db.select().from(saasPaymentClaims)
      .where(eq(saasPaymentClaims.aboutTenantId, tenantId))
      .orderBy(desc(saasPaymentClaims.id)).limit(Math.min(Math.max(limit, 1), 200));
    return { claims: rows.map((r) => this.toJson(r)) };
  }

  /** God verify queue (newest first; status filter, default Pending) with the tenant name joined. */
  async listClaims(status?: string, limit = 100) {
    const cond = status ? eq(saasPaymentClaims.status, status) : undefined;
    const rows = await runGlobalDb('saas-payment-claims:list', () => this.db
      .select({ claim: saasPaymentClaims, tenant: tenants.name })
      .from(saasPaymentClaims)
      .leftJoin(tenants, eq(saasPaymentClaims.aboutTenantId, tenants.id))
      .where(cond)
      .orderBy(desc(saasPaymentClaims.id))
      .limit(Math.min(Math.max(limit, 1), 200)));
    return { claims: rows.map((r) => ({ ...this.toJson(r.claim), tenant: r.tenant })) };
  }

  // God verified the transfer on the real bank statement → the money becomes real: A4 receipt
  // (idempotent on claim:<id> — a double-click approves once) + subscription Active + receipt email.
  async approve(id: number, username: string) {
    return runGlobalDb('saas-payment-claims:approve', async () => {
      const claim = await this.pendingClaim(id);
      const tenantId = Number(claim.aboutTenantId);
      const receipt = await this.receipts?.record({
        tenantId, source: 'bank_transfer', sourceRef: `claim:${id}`,
        amount: Number(claim.amount), period: claim.period, note: claim.note ?? `โอนธนาคาร อ้างอิง ${claim.slipRef}`,
        createdBy: username,
      });
      await this.db.update(saasPaymentClaims)
        .set({ status: 'Approved', receiptNo: receipt?.receipt_no ?? null, decidedBy: username, decidedAt: new Date() })
        .where(eq(saasPaymentClaims.id, id));
      // Verified subscription money re-activates the company (mirrors the Stripe invoice.paid webhook —
      // also the dunning-recovery signal the A2 lifecycle job closes its ladder on).
      await this.db.update(subscriptions).set({ status: 'Active' }).where(eq(subscriptions.tenantId, tenantId));
      logger.info({ claim_id: id, tenant_id: tenantId, receipt_no: receipt?.receipt_no }, 'saas payment claim approved');
      return { id, status: 'Approved', receipt_no: receipt?.receipt_no ?? null };
    });
  }

  async reject(id: number, reason: string | undefined, username: string) {
    return runGlobalDb('saas-payment-claims:reject', async () => {
      const claim = await this.pendingClaim(id);
      await this.db.update(saasPaymentClaims)
        .set({ status: 'Rejected', rejectReason: reason ?? null, decidedBy: username, decidedAt: new Date() })
        .where(eq(saasPaymentClaims.id, id));
      const [tenant] = await this.db.select({ name: tenants.name, email: tenants.email }).from(tenants).where(eq(tenants.id, Number(claim.aboutTenantId))).limit(1);
      if (tenant?.email) {
        await this.mailer?.send({
          template: 'payment_claim_rejected', to: tenant.email, aboutTenantId: Number(claim.aboutTenantId),
          vars: { company: tenant.name, slip_ref: claim.slipRef, reason: reason ?? '', billing_url: billingUrl() },
        }).catch((e) => logger.warn({ claim_id: id, err: (e as Error)?.message }, 'payment_claim_rejected email enqueue failed'));
      }
      logger.info({ claim_id: id, tenant_id: Number(claim.aboutTenantId), reason }, 'saas payment claim rejected');
      return { id, status: 'Rejected' };
    });
  }

  private async pendingClaim(id: number) {
    const [claim] = await this.db.select().from(saasPaymentClaims).where(eq(saasPaymentClaims.id, id)).limit(1);
    if (!claim) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Claim not found', messageTh: 'ไม่พบรายการแจ้งโอน' });
    if (claim.status !== 'Pending') throw new BadRequestException({ code: 'CLAIM_NOT_PENDING', message: `Claim is already ${claim.status}`, messageTh: 'รายการนี้ถูกตัดสินไปแล้ว' });
    return claim;
  }

  private toJson(r: typeof saasPaymentClaims.$inferSelect) {
    return {
      id: Number(r.id), tenant_id: Number(r.aboutTenantId), amount: Number(r.amount), period: r.period,
      slip_ref: r.slipRef, note: r.note, status: r.status, receipt_no: r.receiptNo,
      reject_reason: r.rejectReason, created_by: r.createdBy, decided_by: r.decidedBy,
      decided_at: r.decidedAt, created_at: r.createdAt,
    };
  }
}
