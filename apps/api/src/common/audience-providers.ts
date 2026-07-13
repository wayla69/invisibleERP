// G3 follow-up (docs/45, PDPA-05): DIRECT ads-platform adapters for the hashed-audience export.
// Env-activated like wallet-pass (unset ⇒ not configured ⇒ the job stays on webhook/mock): each configured
// provider receives the SAME consent-filtered, sha256-only batches the webhook target gets — raw PII never
// reaches this layer at all. Adapters NEVER throw (one platform's outage degrades that run to a 'failed'
// register row without crashing the scheduler), and each batch rides the platform's own bulk protocol.
//
//   Meta (Custom Audiences / Marketing API):
//     META_ADS_ACCESS_TOKEN   system-user token with ads_management on the ad account
//     META_AUDIENCE_ID        the Custom Audience id — create it ONCE (Ads Manager, or
//                             POST act_{account}/customaudiences with subtype=CUSTOM and
//                             customer_file_source=USER_PROVIDED_ONLY) and pin it here; requiring the id
//                             means a run can never silently mint a duplicate audience.
//     META_GRAPH_VERSION      optional, default v21.0
//   Google (Customer Match / Google Ads API, REST):
//     GOOGLE_ADS_DEVELOPER_TOKEN + GOOGLE_ADS_CLIENT_ID + GOOGLE_ADS_CLIENT_SECRET +
//     GOOGLE_ADS_REFRESH_TOKEN + GOOGLE_ADS_CUSTOMER_ID (digits only) +
//     GOOGLE_ADS_USER_LIST_ID  the Customer Match user list — create ONCE, pin the id (same rationale)
//     GOOGLE_ADS_LOGIN_CUSTOMER_ID  optional (MCC manager access)
//     GOOGLE_ADS_API_VERSION        optional, default v18
//
// Hash formats (both platforms' published normalization): email = sha256(trim+lowercase);
// Meta phone = sha256(E.164 digits, NO '+'); Google phone = sha256(E.164 WITH leading '+') — the export
// rows carry hashed_phone (Meta) and hashed_phone_plus (Google) so each adapter picks its variant.
import { assertPublicUrl } from './net-guard';

export interface AudienceRow { hashed_email?: string; hashed_phone?: string; hashed_phone_plus?: string }
export interface AudiencePushResult { ok: boolean; status?: number; error?: string; ref?: string }
export interface AudienceSession { sessionId: number; batchSeq: number; lastBatch: boolean; estimatedTotal: number }
export interface AudienceProvider {
  name: string; // 'meta' | 'google'
  push(rows: AudienceRow[], session: AudienceSession): Promise<AudiencePushResult>;
  // Withdrawal removal sync (extends PDPA-05): prune previously-uploaded members whose marketing consent
  // was withdrawn — Meta DELETE /users; Google OfflineUserDataJob remove operations. Same never-throw contract.
  remove(rows: AudienceRow[], session: AudienceSession): Promise<AudiencePushResult>;
}

// The webhook target's URL is runtime-configurable, so it is ALWAYS SSRF-gated in cdp-sync. The adapter
// hosts below are compile-time constants — the gate is belt-and-suspenders there, and skipped only under
// NODE_ENV=test so the fetch-stubbed harness stays hermetic (no live DNS in CI).
async function gate(url: string): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  await assertPublicUrl(url, { allowHttp: false });
}

async function post(url: string, headers: Record<string, string>, body: string): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(url, { method: 'POST', headers, body });
  let json: any = {};
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, json };
}

const errText = (json: any, status: number) =>
  String(json?.error?.message ?? json?.error?.details?.[0]?.errors?.[0]?.message ?? `status ${status}`).slice(0, 300);

// ── Meta: session-batched POST /{audience_id}/users with pre-hashed multi-key schema ──
function metaProvider(): AudienceProvider | null {
  const token = process.env.META_ADS_ACCESS_TOKEN;
  const audienceId = process.env.META_AUDIENCE_ID;
  if (!token || !audienceId) return null;
  const version = process.env.META_GRAPH_VERSION || 'v21.0';
  const send = async (method: 'POST' | 'DELETE', rows: AudienceRow[], s: AudienceSession): Promise<AudiencePushResult> => {
    const url = `https://graph.facebook.com/${version}/${audienceId}/users`;
    try {
      await gate(url);
      const body = JSON.stringify({
        // multi-key schema with PRE-HASHED values; a missing identifier is an empty string per the spec
        payload: { schema: ['EMAIL_SHA256', 'PHONE_SHA256'], data: rows.map((r) => [r.hashed_email ?? '', r.hashed_phone ?? '']) },
        session: { session_id: s.sessionId, batch_seq: s.batchSeq, last_batch_flag: s.lastBatch, estimated_num_total: s.estimatedTotal },
      });
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body });
      let json: any = {};
      try { json = await res.json(); } catch { /* non-JSON error body */ }
      return res.ok
        ? { ok: true, status: res.status, ref: `audience:${audienceId} session:${s.sessionId}` }
        : { ok: false, status: res.status, error: `meta: ${errText(json, res.status)}` };
    } catch (e: any) {
      return { ok: false, error: `meta: ${String(e?.message ?? e).slice(0, 300)}` };
    }
  };
  return {
    name: 'meta',
    push: (rows, s) => send('POST', rows, s),
    // Meta removal = the same payload shape via HTTP DELETE on /users
    remove: (rows, s) => send('DELETE', rows, s),
  };
}

// ── Google: OfflineUserDataJob create (first batch) → addOperations (every batch) → run (last batch) ──
let googleToken: { value: string; expires: number } | null = null;
const googleJobBySession = new Map<number, string>();

async function googleAccessToken(): Promise<string> {
  if (googleToken && googleToken.expires > Date.now()) return googleToken.value;
  const url = 'https://oauth2.googleapis.com/token';
  await gate(url);
  const res = await post(url, { 'Content-Type': 'application/x-www-form-urlencoded' }, new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.GOOGLE_ADS_CLIENT_ID!,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET!,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN!,
  }).toString());
  if (!res.ok || !res.json?.access_token) throw new Error(`google oauth: ${errText(res.json, res.status)}`);
  googleToken = { value: res.json.access_token, expires: Date.now() + 50 * 60_000 };
  return googleToken.value;
}

function googleProvider(): AudienceProvider | null {
  const need = ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_USER_LIST_ID'];
  if (need.some((k) => !process.env[k])) return null;
  const version = process.env.GOOGLE_ADS_API_VERSION || 'v18';
  const cid = process.env.GOOGLE_ADS_CUSTOMER_ID!.replace(/-/g, '');
  const listId = process.env.GOOGLE_ADS_USER_LIST_ID!;
  const base = `https://googleads.googleapis.com/${version}/customers/${cid}`;
  const sendOps = async (kind: 'create' | 'remove', rows: AudienceRow[], s: AudienceSession): Promise<AudiencePushResult> => {
      try {
        const token = await googleAccessToken();
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
          ...(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { 'login-customer-id': process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, '') } : {}),
        };
        let jobRN = googleJobBySession.get(s.sessionId);
        if (!jobRN) {
          const createUrl = `${base}/offlineUserDataJobs:create`;
          await gate(createUrl);
          const created = await post(createUrl, headers, JSON.stringify({
            job: { type: 'CUSTOMER_MATCH_USER_LIST', customerMatchUserListMetadata: { userList: `customers/${cid}/userLists/${listId}` } },
          }));
          if (!created.ok || !created.json?.resourceName) return { ok: false, status: created.status, error: `google create: ${errText(created.json, created.status)}` };
          jobRN = String(created.json.resourceName);
          googleJobBySession.set(s.sessionId, jobRN);
        }
        const ops = rows.map((r) => ({
          [kind]: {
            userIdentifiers: [
              ...(r.hashed_email ? [{ hashedEmail: r.hashed_email }] : []),
              ...(r.hashed_phone_plus ? [{ hashedPhoneNumber: r.hashed_phone_plus }] : []),
            ],
          },
        }));
        const addUrl = `https://googleads.googleapis.com/${version}/${jobRN}:addOperations`;
        const added = await post(addUrl, headers, JSON.stringify({ enablePartialFailure: true, operations: ops }));
        if (!added.ok) return { ok: false, status: added.status, error: `google add: ${errText(added.json, added.status)}` };
        if (s.lastBatch) {
          const run = await post(`https://googleads.googleapis.com/${version}/${jobRN}:run`, headers, '{}');
          googleJobBySession.delete(s.sessionId);
          if (!run.ok) return { ok: false, status: run.status, error: `google run: ${errText(run.json, run.status)}` };
        }
        // the job matches asynchronously on Google's side; the job resource name is the auditable ref
        return { ok: true, ref: jobRN };
      } catch (e: any) {
        googleJobBySession.delete(s.sessionId);
        return { ok: false, error: `google: ${String(e?.message ?? e).slice(0, 300)}` };
      }
  };
  return {
    name: 'google',
    push: (rows, s) => sendOps('create', rows, s),
    // Google removal = the same OfflineUserDataJob flow with `remove` operations (its own session/job)
    remove: (rows, s) => sendOps('remove', rows, s),
  };
}

// Every DIRECT adapter with complete env creds. Empty array = none configured (webhook/mock semantics
// in the caller are unchanged).
export function resolveAudienceProviders(): AudienceProvider[] {
  return [metaProvider(), googleProvider()].filter((p): p is AudienceProvider => p != null);
}
