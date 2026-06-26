import { Inject, Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { giftCards, giftCardTxns } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { PasswordService } from '../auth/password.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// P2c — gift-card PIN (activation/balance-check) + reload (top-up reuses the giftCardTxns ledger).
// PINs are stored HASHED (scrypt via PasswordService), never plaintext. A legacy plaintext PIN already in
// the table still verifies (timing-safe) and is transparently re-hashed the next time it is set.
@Injectable()
export class GiftCardExtraService {
  private readonly pw = new PasswordService();
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService) {}

  // Verify a supplied PIN against the stored value: scrypt hash (new) or legacy plaintext (timing-safe).
  private async pinMatches(stored: string, supplied: string | undefined): Promise<boolean> {
    if (supplied == null) return false;
    if (stored.startsWith('scrypt$')) return (await this.pw.verify(supplied, stored)).ok;
    const a = Buffer.from(stored), b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b); // legacy plaintext fallback
  }

  async setPin(cardNo: string, pin: string) {
    const db = this.db as any;
    const [c] = await db.select().from(giftCards).where(eq(giftCards.cardNo, cardNo)).limit(1);
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Card not found', messageTh: 'ไม่พบบัตร' });
    const pinHash = await this.pw.hash(pin);
    await db.update(giftCards).set({ pin: pinHash, updatedAt: new Date() }).where(eq(giftCards.id, c.id));
    return { card_no: cardNo, pin_set: true };
  }

  async balanceWithPin(cardNo: string, pin?: string) {
    const db = this.db as any;
    const [c] = await db.select().from(giftCards).where(eq(giftCards.cardNo, cardNo)).limit(1);
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Card not found', messageTh: 'ไม่พบบัตร' });
    if (c.pin && !(await this.pinMatches(c.pin, pin))) throw new ForbiddenException({ code: 'BAD_PIN', message: 'Incorrect PIN', messageTh: 'PIN ไม่ถูกต้อง' });
    return { card_no: cardNo, balance: n(c.balance), status: c.status };
  }

  async reload(cardNo: string, amount: number, pin: string | undefined, user: JwtUser) {
    if (!(amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be > 0', messageTh: 'จำนวนเงินไม่ถูกต้อง' });
    const db = this.db as any;
    return db.transaction(async (tx: any) => {
      const [c] = await tx.select().from(giftCards).where(eq(giftCards.cardNo, cardNo)).limit(1).for('update');
      if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Card not found', messageTh: 'ไม่พบบัตร' });
      if (c.status === 'Void') throw new BadRequestException({ code: 'CARD_VOID', message: 'Card is void', messageTh: 'บัตรถูกยกเลิก' });
      if (c.pin && !(await this.pinMatches(c.pin, pin))) throw new ForbiddenException({ code: 'BAD_PIN', message: 'Incorrect PIN', messageTh: 'PIN ไม่ถูกต้อง' });
      const newBal = round2(n(c.balance) + amount);
      const txnNo = await this.docNo.nextDaily('GCT');
      await tx.update(giftCards).set({ balance: String(newBal), status: 'Active', updatedAt: new Date() }).where(eq(giftCards.id, c.id));
      await tx.insert(giftCardTxns).values({ txnNo, tenantId: c.tenantId, cardNo, type: 'Refund', amount: String(round2(amount)), balanceAfter: String(newBal), refDoc: 'reload', createdBy: user.username });
      return { card_no: cardNo, reloaded: round2(amount), balance: newBal };
    });
  }
}
