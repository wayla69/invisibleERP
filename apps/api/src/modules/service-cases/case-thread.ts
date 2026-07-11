import { randomBytes } from 'node:crypto';

// SVC-4 case reply-threading token — minted once per support case and embedded in every OUTBOUND case email
// (subject/body) so a customer reply threads deterministically back to its case, regardless of which address
// the reply comes from (mirrors the CRM-6 crmt_ token). Format: `svct_<20 hex>`, serialised as `[case:<token>]`.
const CASE_THREAD_RE = /\[case:(svct_[0-9a-f]{6,64})\]/i;

export function newCaseThreadToken(): string {
  return `svct_${randomBytes(10).toString('hex')}`;
}

export function caseThreadMark(token: string): string {
  return `[case:${token}]`;
}

// Scan any number of strings (subject, body, In-Reply-To/References headers) for the first case thread token.
export function parseCaseThreadToken(...parts: (string | null | undefined)[]): string | null {
  for (const p of parts) {
    const m = typeof p === 'string' ? p.match(CASE_THREAD_RE) : null;
    if (m) return m[1]!.toLowerCase();
  }
  return null;
}
