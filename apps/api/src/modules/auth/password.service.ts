import { Injectable } from '@nestjs/common';
import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/**
 * Password hashing — scrypt (built-in, no native deps).
 * รองรับ migration: verify hash แบบ legacy (unsalted SHA-256 hex 64 ตัว) แล้วค่อย rehash เป็น scrypt ตอน login สำเร็จ.
 * (Production แนะนำ argon2id — สลับ implementation ได้โดยคง interface นี้)
 */
@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const derived = (await scryptAsync(password, salt, 64)) as Buffer;
    return `scrypt$${salt}$${derived.toString('hex')}`;
  }

  async verify(password: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
    // legacy: unsalted SHA-256 hex (64 chars) จาก user_store.make_hash เดิม
    if (/^[a-f0-9]{64}$/i.test(stored)) {
      const legacy = createHash('sha256').update(password).digest('hex');
      return { ok: timingSafeEqualHex(legacy, stored), needsRehash: true };
    }
    // scrypt$salt$hash
    const parts = stored.split('$');
    if (parts[0] === 'scrypt' && parts[1] && parts[2]) {
      const derived = (await scryptAsync(password, parts[1], 64)) as Buffer;
      const expected = Buffer.from(parts[2], 'hex');
      const ok = derived.length === expected.length && timingSafeEqual(derived, expected);
      return { ok, needsRehash: false };
    }
    return { ok: false, needsRehash: false };
  }

  /** legacy hasher (สำหรับ ETL/test เปรียบเทียบ) */
  legacySha256(password: string): string {
    return createHash('sha256').update(password).digest('hex');
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
