import { BadRequestException } from '@nestjs/common';

// Pluggable card-terminal/PSP provider. 'mock' is the default (used by tests + when no key is set).
// Real providers (Opn/Omise wired here; 2C2P/GBPrime follow the same shape) call the PSP over HTTPS.
export type IntentStatus = 'Captured' | 'Authorized' | 'Pending' | 'Failed';

export interface ChargeReq { amount: number; currency: string; type: 'sale' | 'preauth'; token?: string; intentNo: string }
export interface ChargeRes { ref: string; status: IntentStatus }

export interface TerminalProvider {
  readonly name: string;
  charge(req: ChargeReq): Promise<ChargeRes>;
  capture(ref: string, amount: number): Promise<{ ok: boolean }>;
  voidCharge(ref: string): Promise<{ ok: boolean }>;
  refund(ref: string, amount: number): Promise<{ ok: boolean }>;
  /** Confirm a webhook event is authentic (re-fetch/verify). Returns the authoritative status. */
  verifyWebhook(providerRef: string): Promise<IntentStatus | null>;
}

// ── Mock (default; deterministic, no network) ───────────────────────────────
export class MockProvider implements TerminalProvider {
  readonly name = 'mock';
  async charge(req: ChargeReq): Promise<ChargeRes> {
    const ref = `mock_${Math.abs(hash(`${req.intentNo}:${req.amount}:${req.type}`))}`;
    return { ref, status: req.type === 'preauth' ? 'Authorized' : 'Captured' };
  }
  async capture() { return { ok: true }; }
  async voidCharge() { return { ok: true }; }
  async refund() { return { ok: true }; }
  async verifyWebhook() { return null; }
}

// ── Opn (Omise) — real card PSP ─────────────────────────────────────────────
// amount is in satang (THB×100). Auth = secret key as basic-auth username.
// Card-present POS supplies a token/source from the terminal SDK (req.token).
export class OmiseProvider implements TerminalProvider {
  readonly name = 'omise';
  private base = 'https://api.omise.co';
  constructor(private readonly secretKey: string) {}

  private auth() { return 'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64'); }
  private async call(path: string, body?: Record<string, any>): Promise<any> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { Authorization: this.auth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)] as [string, string])) : undefined,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.object === 'error') {
      throw new BadRequestException({ code: 'PSP_ERROR', message: json.message ?? `Omise error ${res.status}`, messageTh: 'การชำระเงินผิดพลาด' });
    }
    return json;
  }
  private map(c: any): IntentStatus {
    if (c.status === 'failed' || c.failure_code) return 'Failed';
    if (c.status === 'pending') return 'Pending';
    if (c.paid === true || c.status === 'successful') return 'Captured';
    if (c.authorized === true) return 'Authorized';
    return 'Pending';
  }
  async charge(req: ChargeReq): Promise<ChargeRes> {
    if (!req.token) throw new BadRequestException({ code: 'NO_TOKEN', message: 'Card token/source required from terminal', messageTh: 'ต้องมี token จากเครื่องรับบัตร' });
    const c = await this.call('/charges', {
      amount: Math.round(req.amount * 100), currency: (req.currency || 'THB').toLowerCase(),
      card: req.token, capture: req.type === 'sale',
    });
    return { ref: c.id, status: this.map(c) };
  }
  async capture(ref: string, amount: number) { await this.call(`/charges/${ref}/capture`, { capture_amount: Math.round(amount * 100) }); return { ok: true }; }
  async voidCharge(ref: string) { await this.call(`/charges/${ref}/reverse`); return { ok: true }; }
  async refund(ref: string, amount: number) { await this.call(`/charges/${ref}/refunds`, { amount: Math.round(amount * 100) }); return { ok: true }; }
  async verifyWebhook(providerRef: string): Promise<IntentStatus | null> {
    // Re-fetch the charge from Omise (events can be spoofed; the API is authoritative).
    const res = await fetch(`${this.base}/charges/${providerRef}`, { headers: { Authorization: this.auth() } });
    if (!res.ok) return null;
    return this.map(await res.json());
  }
}

// Factory: resolve a provider by name. Real providers need a configured secret (env/tenant).
export function getProvider(name: string | undefined): TerminalProvider {
  const p = (name || 'mock').toLowerCase();
  if (p === 'mock') return new MockProvider();
  if (p === 'omise') {
    const key = process.env.OMISE_SECRET_KEY;
    if (!key) throw new BadRequestException({ code: 'PROVIDER_NOT_CONFIGURED', message: 'OMISE_SECRET_KEY not set', messageTh: 'ยังไม่ได้ตั้งค่าคีย์ Omise' });
    return new OmiseProvider(key);
  }
  // 2c2p / gbprime: same TerminalProvider shape — add classes here when creds exist.
  throw new BadRequestException({ code: 'PROVIDER_NOT_CONFIGURED', message: `Provider ${p} not configured`, messageTh: 'ยังไม่ได้ตั้งค่าผู้ให้บริการชำระเงิน' });
}

function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; } return h; }
