// PDPA data-minimization for the LLM boundary. The AI assistant summarizes ERP data via tool calls; the
// tool RESULTS are sent to a third-party model (Anthropic). Those results don't need direct contact
// identifiers — email, phone, Thai national/tax id (13 digits), address, LINE ids — so we strip them before
// they leave the system. Business NAMES are intentionally kept: the assistant must be able to say
// "Customer ABC is 45 days overdue" to be useful, and a name alone is far lower-risk than contact data.
// Full pseudonymization + a signed Anthropic DPA (see the legal/DPA workstream) are the complete control;
// this is the immediate, code-level minimization. Toggle with AI_PII_REDACTION=off (default on).

export const PII_REDACTION_ENABLED = (): boolean =>
  (process.env.AI_PII_REDACTION ?? 'on').toLowerCase() !== 'off';

// Object keys whose VALUE is a direct contact identifier → masked wholesale (precise, structured path).
const SENSITIVE_KEY =
  /^(e[-_]?mail|phone|phone_no|phone_number|mobile|tel|telephone|fax|contact|contact_name|contact_phone|line_user_id|line_id|line_display_name|national_id|citizen_id|tax_id|taxid|vat_id|address|address_line1|address_line2|postal_code|zip|birthday|dob|passport|bank_account|sso_no|ssn)$/i;

// Free-text backstop: scrub identifiers embedded inside string values (memos, descriptions).
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const ID13_RE = /\b\d{13}\b/g; // Thai national / tax id
const PHONE_RE = /(?:\+?66|0)\d{1,2}[-\s]?\d{3,4}[-\s]?\d{3,4}/g; // Thai phone shapes
// International E.164-ish numbers embedded in free text (security review L-11): a leading `+` then a country
// code and 7+ more digits, allowing spaces / dashes / parens as separators. Requires the `+` so it won't
// mask plain amounts/counts; runs BEFORE the Thai pattern so `+66…` is caught here too.
const INTL_PHONE_RE = /\+\d[\d\s().-]{7,}\d/g;
const MASK = '[REDACTED]';

function scrubString(s: string): string {
  return s.replace(EMAIL_RE, MASK).replace(ID13_RE, MASK).replace(INTL_PHONE_RE, MASK).replace(PHONE_RE, MASK);
}

// Deep-clone with PII removed. Numbers/booleans pass through (amounts, counts, dates-as-numbers are not PII);
// only strings are scrubbed and only sensitively-named keys are masked wholesale.
export function redactPii<T>(value: T): T {
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactPii(v)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Round-2 defense-in-depth: a sensitive-named key masks WHOLESALE regardless of value shape —
      // an object/array nested under `bank_account` is as sensitive as a string (null stays null).
      out[k] = SENSITIVE_KEY.test(k) && v != null ? MASK : redactPii(v);
    }
    return out as unknown as T;
  }
  return value;
}
