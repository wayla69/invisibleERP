import { Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { receiptPrints } from '../../database/schema';
import { eq, and, sql } from 'drizzle-orm';
import { ReceiptService } from './receipt.service';
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
  ) {}

  // Build the receipt body (HTML for email, text for SMS) and hand to the provider. Records a print row.
  async send(saleNo: string, dto: SendReceiptDto, user: JwtUser) {
    const db = this.db;
    const body = await this.receipts.bodyFor(saleNo, dto.channel === 'email' ? 'html' : 'text'); // throws 404 if no sale
    const subject = `ใบเสร็จรับเงิน ${saleNo}`;
    const r = await this.provider.send(dto.channel, dto.to, subject, body);
    // mark as a copy if a 'print' already exists for this sale
    const [pc] = await db.select({ c: sql<string>`count(*)` }).from(receiptPrints).where(and(eq(receiptPrints.saleNo, saleNo), eq(receiptPrints.channel, 'print')));
    await db.insert(receiptPrints).values({ saleNo, tenantId: user.tenantId ?? null, channel: dto.channel, isCopy: Number(pc?.c ?? 0) > 0 ? 'true' : 'false', printedBy: user.username });
    return { queued: true as const, channel: dto.channel, to: dto.to, provider: r.provider, ref: r.ref };
  }
}
