import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { authenticator } from 'otplib';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { users } from '../../database/schema';
import { encrypt, decrypt } from '../../common/crypto';
import type { JwtUser } from '../../common/decorators';

const ISSUER = 'Invisible ERP';

@Injectable()
export class MfaService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async userRow(user: JwtUser) {
    const db = this.db as any;
    const [u] = await db.select().from(users).where(eq(users.username, user.username)).limit(1);
    if (!u) throw new NotFoundException({ code: 'NOT_FOUND', message: 'User not found', messageTh: 'ไม่พบผู้ใช้' });
    return u;
  }

  // เริ่มลงทะเบียน TOTP — เก็บ secret ไว้ แต่ mfaEnabled ยังเป็น false จนกว่าจะ verify สำเร็จ
  async setup(user: JwtUser) {
    const db = this.db as any;
    const u = await this.userRow(user);
    const secret = authenticator.generateSecret();
    const otpauth_url = authenticator.keyuri(u.username, ISSUER, secret);
    // store ciphertext; return plaintext (caller needs it to enroll an authenticator app)
    await db.update(users).set({ totpSecret: encrypt(secret), mfaEnabled: false }).where(eq(users.id, u.id));
    return { secret, otpauth_url };
  }

  // ยืนยัน token → เปิด mfaEnabled
  async verify(user: JwtUser, token: string) {
    const db = this.db as any;
    const u = await this.userRow(user);
    if (!u.totpSecret) throw new BadRequestException({ code: 'MFA_NOT_SETUP', message: 'MFA not set up', messageTh: 'ยังไม่ได้ตั้งค่า MFA' });
    const ok = authenticator.check(String(token), decrypt(u.totpSecret));
    if (!ok) throw new BadRequestException({ code: 'MFA_INVALID', message: 'Invalid MFA token', messageTh: 'รหัส MFA ไม่ถูกต้อง' });
    await db.update(users).set({ mfaEnabled: true }).where(eq(users.id, u.id));
    return { mfaEnabled: true };
  }
}
