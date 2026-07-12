// Outbound CDP (Customer Data Platform) sync — push the member snapshot to an external CDP/marketing webhook
// (Segment, mParticle, a customer's own ingest URL, …) via an authorized HTTP POST. Env-activated, mirroring
// the object-storage / messaging pattern: configured ⇒ real POST; unset ⇒ no-op (the scheduled job reports a
// mock push so the flow is exercised without a destination).
//
//   CDP_WEBHOOK_URL    the ingest endpoint (POST of a JSON batch)
//   CDP_WEBHOOK_TOKEN  optional Bearer token / shared secret for the POST
import { assertPublicUrl } from './net-guard';

export function cdpConfigured(): boolean {
  return !!process.env.CDP_WEBHOOK_URL;
}

// G3 (docs/45, PDPA-05): the hashed-audience activation target — a dedicated ingest URL when configured
// (an ads-platform middleware / CDP audience endpoint), else the generic CDP webhook, else mock.
export function audienceExportConfigured(): boolean {
  return !!(process.env.AUDIENCE_EXPORT_URL || process.env.CDP_WEBHOOK_URL);
}

// POST one HASHED audience batch. Same degrade-gracefully contract as pushToCdp, plus the L-6 SSRF gate:
// the destination must be a public https URL (assertPublicUrl) — a private/rebinding target is refused.
export async function pushHashedAudience(payload: Record<string, any>): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = process.env.AUDIENCE_EXPORT_URL || process.env.CDP_WEBHOOK_URL;
  if (!url) return { ok: true, status: 0 }; // unconfigured ⇒ no-op success (mock)
  const token = process.env.AUDIENCE_EXPORT_TOKEN || process.env.CDP_WEBHOOK_TOKEN;
  try {
    await assertPublicUrl(url, { allowHttp: false });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload),
    });
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `audience ${res.status}` };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  }
}

// POST one batch to the CDP. Returns {ok} — never throws, so a sync run degrades gracefully (the job reports
// the failure in its summary rather than crashing the scheduler).
export async function pushToCdp(payload: Record<string, any>): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = process.env.CDP_WEBHOOK_URL;
  if (!url) return { ok: true, status: 0 }; // unconfigured ⇒ treated as a no-op success (mock)
  try {
    // L-6 SSRF gate (G3 hardening): a CDP destination must be a public https URL — never an internal service.
    await assertPublicUrl(url, { allowHttp: false });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(process.env.CDP_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.CDP_WEBHOOK_TOKEN}` } : {}) },
      body: JSON.stringify(payload),
    });
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `CDP ${res.status}` };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  }
}
