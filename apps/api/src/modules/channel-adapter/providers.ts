// Outbound delivery-aggregator adapters (GrabFood / LINE MAN / Foodpanda / Robinhood). Mirrors the
// payment/messaging gateway pattern: a platform resolves to a REAL HTTP client when its credentials are
// configured (CHANNEL_API_URL_<PLATFORM> + CHANNEL_API_TOKEN_<PLATFORM>), otherwise a Mock that records
// the call deterministically (dev/demo/CI). The inbound order webhook is handled separately
// (ChannelAdapterService.ingestWebhook); this is the OUTBOUND side — menu push + order lifecycle callbacks.
const rnd = () => Math.random().toString(36).slice(2, 10);

export interface PlatformMenuItem { sku: string; name: string; price: number; available: boolean }
export interface CallResult { ok: boolean; ref?: string; error?: string }

export interface PlatformProvider {
  readonly name: string;
  pushMenu(storeRef: string | null, items: PlatformMenuItem[]): Promise<CallResult>;
  updateStatus(extOrderId: string | null, status: string): Promise<CallResult>;
  acceptOrder(extOrderId: string | null): Promise<CallResult>;
  rejectOrder(extOrderId: string | null, reason: string): Promise<CallResult>;
}

// Mock — deterministic, no network. The default until per-platform creds exist.
export class MockPlatformProvider implements PlatformProvider {
  readonly name = 'mock';
  async pushMenu() { return { ok: true, ref: `mock_menu_${rnd()}` }; }
  async updateStatus() { return { ok: true, ref: `mock_status_${rnd()}` }; }
  async acceptOrder() { return { ok: true, ref: `mock_accept_${rnd()}` }; }
  async rejectOrder() { return { ok: true, ref: `mock_reject_${rnd()}` }; }
}

// Generic HTTP — one shape that fits each aggregator's partner API (a dedicated subclass can override the
// paths/payloads later). Network/API errors return { ok:false } (the caller still updates local state and
// can retry) rather than throwing, so a partner outage never crashes the POS.
export class HttpPlatformProvider implements PlatformProvider {
  constructor(readonly name: string, private readonly baseUrl: string, private readonly token?: string) {}

  private async call(path: string, body: Record<string, unknown>): Promise<CallResult> {
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(body),
      });
      let json: any = {}; try { json = await res.json(); } catch { /* non-JSON ack */ }
      if (!res.ok) return { ok: false, error: `${this.name} ${res.status} ${json?.message ?? ''}`.trim().slice(0, 300) };
      return { ok: true, ref: json?.id ?? json?.ref ?? res.headers.get('x-request-id') ?? `${this.name}_${rnd()}` };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
    }
  }

  pushMenu(storeRef: string | null, items: PlatformMenuItem[]) { return this.call('/menu', { store_ref: storeRef, items }); }
  updateStatus(extOrderId: string | null, status: string) { return this.call(`/orders/${extOrderId ?? ''}/status`, { status }); }
  acceptOrder(extOrderId: string | null) { return this.call(`/orders/${extOrderId ?? ''}/accept`, {}); }
  rejectOrder(extOrderId: string | null, reason: string) { return this.call(`/orders/${extOrderId ?? ''}/reject`, { reason }); }
}

// Resolve a platform's outbound provider. Real client when CHANNEL_API_URL_<PLATFORM> is set; else mock.
export function getPlatformProvider(platform: string): PlatformProvider {
  const key = platform.toUpperCase();
  const base = process.env[`CHANNEL_API_URL_${key}`];
  if (base) return new HttpPlatformProvider(platform, base, process.env[`CHANNEL_API_TOKEN_${key}`]);
  return new MockPlatformProvider();
}
