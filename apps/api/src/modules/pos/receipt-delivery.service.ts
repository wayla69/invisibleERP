import { Inject, Injectable, Logger, Optional, BadRequestException } from '@nestjs/common';
import { stripTrailingSlashes } from '@ierp/shared';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { receiptPrints, posMemberLedger, posMembers, dineInOrders } from '../../database/schema';
import { eq, and, sql, desc } from 'drizzle-orm';
import { ReceiptService } from './receipt.service';
import { MessagingService } from '../messaging/messaging.service';
import { TenantMessagingService } from '../messaging/tenant-messaging.service';
import { receiptFlexBubble } from './receipt-format';
import { mintReceiptToken } from './receipt-token.util';
import type { JwtUser } from '../../common/decorators';
import type { SendReceiptDto } from './receipt.dto';

export interface ReceiptDeliveryProvider {
  send(channel: 'email' | 'sms', to: string, subject: string, body: string): Promise<{ queued: true; provider: string; ref: string }>;
}

// Default provider — calls NO external service. Logs + returns a synthetic ref. Swap on RECEIPT_PROVIDER.
@Injectable()
export class NoopReceiptProvider implements ReceiptDeliveryProvider {
  private readonly logger = new Logger(NoopReceiptProvider.name);
  async send(channel: 'email' | 'sms', to: string, subject: string, _body: string) {
    this.logger.log(`[noop] would send ${channel} receipt "${subject}" to ${to}`);
    const ref = `noop-${channel}-${to.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`;
    return { queued: true as const, provider: 'noop', ref };
  }
}

@Injectable()
export class ReceiptDeliveryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly receipts: ReceiptService,
    private readonly provider: NoopReceiptProvider,
    // POS-2 — LINE e-receipt rides the EXISTING messaging LINE client (flex push + message_log audit +
    // per-tenant creds). Optional so partial harnesses that construct POS without messaging still boot.
    @Optional() private readonly messaging?: MessagingService,
    @Optional() private readonly tenantMsg?: TenantMessagingService,
  ) {}

  // Build the receipt body (HTML for email, text for SMS) and hand to the provider. Records a print row.
  async send(saleNo: string, dto: SendReceiptDto, user: JwtUser) {
    if (dto.channel === 'line') return this.sendLine(saleNo, user);
    const to = dto.to ?? ''; // guaranteed non-empty for email/sms by the DTO refine
    const body = await this.receipts.bodyFor(saleNo, dto.channel === 'email' ? 'html' : 'text'); // throws 404 if no sale
    const subject = `ใบเสร็จรับเงิน ${saleNo}`;
    const r = await this.provider.send(dto.channel, to, subject, body);
    await this.recordDelivery(saleNo, user.tenantId ?? null, dto.channel, user);
    return { queued: true as const, channel: dto.channel, to, provider: r.provider, ref: r.ref };
  }

  // POS-2 — push a flex e-receipt to the LINE account of the loyalty member on the sale. The member is
  // resolved FROM the sale (points ledger ref_doc, else the dine-in order header for online/kiosk sales) —
  // never from caller input, so a receipt can only go to the member who actually transacted. The card links
  // to the full HTML receipt via an opaque HMAC token (never a guessable URL). Delivery is logged twice:
  // message_log (campaign 'e-receipt', LINE convention) + receipt_prints channel 'line' (receipt log).
  private async sendLine(saleNo: string, user: JwtUser) {
    const { model, tenantId } = await this.receipts.buildModel(saleNo); // throws 404 if no sale
    const member = await this.memberFor(saleNo);
    if (!member?.lineUserId) {
      throw new BadRequestException({
        code: 'LINE_NOT_LINKED',
        message: member ? 'The member on this sale has no linked LINE account' : 'This sale has no loyalty member with a linked LINE account',
        messageTh: member ? 'สมาชิกของบิลนี้ยังไม่ได้เชื่อมบัญชี LINE' : 'บิลนี้ไม่มีสมาชิกที่เชื่อมบัญชี LINE',
      });
    }
    // Typed config guard: in prod an unset LINE channel token must NOT silently "send" via the dev mock —
    // fail with a clear code (dev/test fall through to the messaging mock so harnesses can assert the send).
    const creds = await this.tenantMsg?.resolveCreds(tenantId ?? user.tenantId ?? null, 'line').catch(() => null);
    const token = (creds?.token as string | undefined) ?? process.env.LINE_CHANNEL_TOKEN;
    if (!this.messaging || (!token && process.env.NODE_ENV === 'production')) {
      throw new BadRequestException({
        code: 'LINE_NOT_CONFIGURED',
        message: 'LINE Messaging API is not configured (set LINE_CHANNEL_TOKEN or the tenant LINE credentials)',
        messageTh: 'ยังไม่ได้ตั้งค่าช่องทาง LINE ของร้าน (LINE_CHANNEL_TOKEN)',
      });
    }
    const base = stripTrailingSlashes(process.env.WEB_BASE_URL);
    const url = base && tenantId != null ? `${base}/api/pos/receipt/public/${mintReceiptToken({ tenantId, saleNo })}` : null;
    const altText = `ใบเสร็จรับเงิน ${saleNo} ยอดรวม ${model.total.toFixed(2)} บาท`;
    const res = await this.messaging.sendFlex(
      { to: String(member.lineUserId), alt_text: altText, flex: receiptFlexBubble(model, url), campaign: 'e-receipt' },
      user,
    );
    await this.recordDelivery(saleNo, tenantId ?? user.tenantId ?? null, 'line', user);
    return {
      queued: res.status !== 'failed', channel: 'line' as const,
      to: `${String(member.lineUserId).slice(0, 6)}…`, member_id: Number(member.id),
      provider: res.provider, ref: res.provider_ref, status: res.status, receipt_url: url,
    };
  }

  // The loyalty member who transacted this sale: latest points-ledger row (Earn/Redeem, ref_doc = saleNo),
  // else the dine-in order header's member (online/kiosk orders persist member_id there). RLS-scoped.
  private async memberFor(saleNo: string) {
    const db = this.db;
    const [led] = await db.select({ memberId: posMemberLedger.memberId }).from(posMemberLedger)
      .where(eq(posMemberLedger.refDoc, saleNo)).orderBy(desc(posMemberLedger.id)).limit(1);
    let memberId = led?.memberId != null ? Number(led.memberId) : null;
    if (memberId == null) {
      const [o] = await db.select({ memberId: dineInOrders.memberId }).from(dineInOrders)
        .where(eq(dineInOrders.saleNo, saleNo)).limit(1);
      memberId = o?.memberId != null ? Number(o.memberId) : null;
    }
    if (memberId == null) return null;
    const [m] = await db.select().from(posMembers).where(eq(posMembers.id, memberId)).limit(1);
    return m ?? null;
  }

  // Record the delivery in receipt_prints; marked as a copy when a 'print' already exists for this sale.
  private async recordDelivery(saleNo: string, tenantId: number | null, channel: string, user: JwtUser) {
    const db = this.db;
    const [pc] = await db.select({ c: sql<string>`count(*)` }).from(receiptPrints).where(and(eq(receiptPrints.saleNo, saleNo), eq(receiptPrints.channel, 'print')));
    await db.insert(receiptPrints).values({ saleNo, tenantId, channel, isCopy: Number(pc?.c ?? 0) > 0 ? 'true' : 'false', printedBy: user.username });
  }
}
