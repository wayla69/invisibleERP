import { randomBytes } from 'node:crypto';

// CRM-6 reply-threading token — shared by the CRM-4 OUTBOUND comms (crm-pipeline.service.sendComms embeds it
// in the sent email) and the CRM-6 INBOUND capture (crm-inbound.service parses it out of a reply) so a
// customer reply threads deterministically back to its originating opportunity, regardless of which address
// the reply comes from. Format: `crmt_<20 hex>`, embedded/serialised as the tag `[ref:<token>]`.
const CRM_THREAD_RE = /\[ref:(crmt_[0-9a-f]{6,64})\]/i;

export function newCrmThreadToken(): string {
  return `crmt_${randomBytes(10).toString('hex')}`;
}

export function crmThreadMark(token: string): string {
  return `[ref:${token}]`;
}

// Scan any number of strings (subject, body, In-Reply-To/References headers) for the first thread token.
export function parseCrmThreadToken(...parts: (string | null | undefined)[]): string | null {
  for (const p of parts) {
    const m = typeof p === 'string' ? p.match(CRM_THREAD_RE) : null;
    if (m) return m[1]!.toLowerCase();
  }
  return null;
}
