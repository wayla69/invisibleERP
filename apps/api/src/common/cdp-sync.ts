// Outbound CDP (Customer Data Platform) sync — push the member snapshot to an external CDP/marketing webhook
// (Segment, mParticle, a customer's own ingest URL, …) via an authorized HTTP POST. Env-activated, mirroring
// the object-storage / messaging pattern: configured ⇒ real POST; unset ⇒ no-op (the scheduled job reports a
// mock push so the flow is exercised without a destination).
//
//   CDP_WEBHOOK_URL    the ingest endpoint (POST of a JSON batch)
//   CDP_WEBHOOK_TOKEN  optional Bearer token / shared secret for the POST
export function cdpConfigured(): boolean {
  return !!process.env.CDP_WEBHOOK_URL;
}

// POST one batch to the CDP. Returns {ok} — never throws, so a sync run degrades gracefully (the job reports
// the failure in its summary rather than crashing the scheduler).
export async function pushToCdp(payload: Record<string, any>): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = process.env.CDP_WEBHOOK_URL;
  if (!url) return { ok: true, status: 0 }; // unconfigured ⇒ treated as a no-op success (mock)
  try {
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
