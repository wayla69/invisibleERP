// Outbound customer-messaging gateways (LINE / SMS / email). Provider-agnostic, mirroring the payment
// gateway pattern: a channel resolves to a real provider when its credentials are configured, otherwise a
// Mock that records the message as 'sent' (dev/demo). LINE has a real push implementation (the dominant
// Thai channel); SMS is a provider-agnostic HTTP client (any bulk-SMS REST API) and email is SMTP via
// nodemailer — both activate the moment their env is set, else they fall through to the dev mock. The
// abstraction + delivery log let the rest of the system work today and a real client drops in via env.
import nodemailer, { type Transporter } from 'nodemailer';

const rnd = () => Math.random().toString(36).slice(2, 12);

export type MessageChannel = 'line' | 'sms' | 'email';
export interface SendResult { status: 'sent' | 'failed'; provider: string; ref?: string; error?: string }

// Optional per-tenant credential override. When a field is present it wins over the platform env default;
// when absent the env value is used. Shapes: line {token}; sms {apiKey,apiUrl,sender?}; email {host,port?,
// user?,pass?,from?,secure?,subject?}. Undefined ⇒ pure env behaviour (back-compat).
export type ChannelCreds = Record<string, any>;

// Merge per-tenant creds over the platform env for a channel. Reading env at call time (not module-load)
// means a late-injected secret takes effect without a restart — mirrors the payment-gateway resolver.
function mergeCreds(channel: MessageChannel, creds?: ChannelCreds) {
  const e = process.env;
  if (channel === 'line') return { token: creds?.token ?? e.LINE_CHANNEL_TOKEN };
  if (channel === 'sms') return { apiKey: creds?.apiKey ?? e.SMS_API_KEY, apiUrl: creds?.apiUrl ?? e.SMS_API_URL, sender: creds?.sender ?? e.SMS_SENDER };
  return {
    host: creds?.host ?? e.SMTP_HOST, port: Number(creds?.port ?? e.SMTP_PORT ?? 587),
    user: creds?.user ?? e.SMTP_USER, pass: creds?.pass ?? e.SMTP_PASS, from: creds?.from ?? e.SMTP_FROM,
    secure: (creds?.secure ?? (e.SMTP_SECURE === 'true')) === true, subject: creds?.subject ?? e.SMTP_SUBJECT,
  };
}

// A channel is "configured" iff its primary credential is present (from tenant creds or env):
//   LINE → token   SMS → apiKey   email → host. Otherwise the gateway is a logged dev mock.
export function resolveMessageGateway(channel: MessageChannel, creds?: ChannelCreds) {
  const c: any = mergeCreds(channel, creds);
  const primary = channel === 'line' ? c.token : channel === 'sms' ? c.apiKey : c.host;
  const configured = !!primary;
  const provider = configured ? channel : 'mock';
  return {
    provider,
    async send(recipient: string, body: string): Promise<SendResult> {
      // Each channel has a real client that activates once its credential is set (tenant override or env);
      // until then all fall through to the dev mock so the delivery log + campaign flows work end-to-end.
      if (configured && channel === 'line') return sendLinePush(c.token, recipient, body);
      if (configured && channel === 'sms') return sendSms(c, recipient, body);
      if (configured && channel === 'email') return sendEmail(c, recipient, body);
      return { status: 'sent', provider, ref: `${provider}_${rnd()}` };
    },
  };
}

// LINE Messaging API push (https://api.line.me/v2/bot/message/push). The recipient is a LINE userId the
// customer obtained by adding the shop's Official Account / via LINE Login. Network or API errors return
// 'failed' (logged in message_log) rather than throwing, so a receipt send never crashes the POS flow.
// Shared LINE Messaging API poster — one place to send a `messages` array to a push/broadcast endpoint.
// Network / non-2xx errors return 'failed' (logged), never throw, so a send never crashes the caller.
async function postLine(token: string, endpoint: 'push' | 'broadcast' | 'reply', payload: Record<string, any>): Promise<SendResult> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/message/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { status: 'failed', provider: 'line', error: `LINE ${res.status} ${detail}`.trim().slice(0, 300) };
    }
    return { status: 'sent', provider: 'line', ref: res.headers.get('x-line-request-id') ?? `line_${rnd()}` };
  } catch (e: any) {
    return { status: 'failed', provider: 'line', error: String(e?.message ?? e).slice(0, 300) };
  }
}

// A LINE flex message (altText shown in the chat list / notifications; contents is a LINE flex container —
// a bubble or carousel of cards/images/buttons). Passed through opaquely so any valid flex JSON works.
export function flexMessage(altText: string, contents: any) {
  return { type: 'flex', altText: String(altText || 'ข้อความ').slice(0, 400), contents };
}

async function sendLinePush(token: string, to: string, text: string): Promise<SendResult> {
  return postLine(token, 'push', { to, messages: [{ type: 'text', text: text.slice(0, 5000) }] });
}

// Reply to an incoming LINE webhook event using its one-time replyToken (no push quota consumed). Used by
// the OA chat command flow (link / pr). Without a token (mock/dev) the caller should skip the network call.
export async function replyLine(token: string, replyToken: string, text: string): Promise<SendResult> {
  return postLine(token, 'reply', { replyToken, messages: [{ type: 'text', text: text.slice(0, 5000) }] });
}

// Reply with a rich flex message (card/carousel with postback buttons) — LC-1 one-tap chat interactions.
export async function replyLineFlex(token: string, replyToken: string, altText: string, contents: any): Promise<SendResult> {
  return postLine(token, 'reply', { replyToken, messages: [flexMessage(altText, contents)] });
}

// Download a message's binary content (photo/file the user sent) from the LINE content API. Returns the
// bytes as a data URL, or a typed error ('too-large' / 'fetch-failed') — never throws. Used by the chat
// attach flow (invoice/receipt photos onto a PO).
export async function fetchLineContent(token: string, messageId: string, maxBytes = 2_000_000): Promise<{ dataUrl: string } | { error: 'too-large' | 'fetch-failed' }> {
  try {
    const res = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { error: 'fetch-failed' };
    const contentType = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return { error: 'too-large' };
    return { dataUrl: `data:${contentType};base64,${buf.toString('base64')}` };
  } catch {
    return { error: 'fetch-failed' };
  }
}

// Push a rich flex message to one LINE user (a card/carousel with images + buttons, not just plain text).
export async function pushLineFlex(token: string, to: string, altText: string, contents: any): Promise<SendResult> {
  return postLine(token, 'push', { to, messages: [flexMessage(altText, contents)] });
}

// Broadcast a rich flex message to every OA follower.
export async function broadcastLineFlex(token: string, altText: string, contents: any): Promise<SendResult> {
  return postLine(token, 'broadcast', { messages: [flexMessage(altText, contents)] });
}

// LINE OA broadcast (https://api.line.me/v2/bot/message/broadcast) — pushes ONE message to EVERY follower of
// the shop's Official Account. Unlike a per-member push/blast, there is no recipient list and no per-member
// consent filter: the audience is LINE's OA follower set (consent = the user followed the OA; they opt out by
// unfollowing). Use for public announcements. Errors return 'failed' (logged), never throw.
export async function broadcastLine(token: string, text: string): Promise<SendResult> {
  return postLine(token, 'broadcast', { messages: [{ type: 'text', text: text.slice(0, 5000) }] });
}

// Is the LINE push/broadcast channel configured (an OA channel token present)? Lets the service decide whether
// a broadcast will really send or fall through to the mock (logged as sent).
export function lineConfigured(): boolean {
  return !!process.env.LINE_CHANNEL_TOKEN;
}

// SMS via a provider-agnostic HTTP REST call — works with most Thai bulk-SMS gateways (ThaiBulkSMS, Twilio,
// AWS SNS proxies, …) that accept a JSON POST with a Bearer key. Endpoint + optional sender come from env so
// no provider is hard-coded. Config: SMS_API_KEY (Bearer), SMS_API_URL (endpoint), SMS_SENDER (optional
// alphanumeric sender id). Non-2xx / network errors return 'failed' (logged), never throw.
async function sendSms(c: { apiKey: string; apiUrl?: string; sender?: string }, to: string, text: string): Promise<SendResult> {
  const url = c.apiUrl;
  if (!url) return { status: 'failed', provider: 'sms', error: 'SMS_API_URL not set' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({ to, message: text.slice(0, 1000), ...(c.sender ? { sender: c.sender } : {}) }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { status: 'failed', provider: 'sms', error: `SMS ${res.status} ${detail}`.trim().slice(0, 300) };
    }
    return { status: 'sent', provider: 'sms', ref: `sms_${rnd()}` };
  } catch (e: any) {
    return { status: 'failed', provider: 'sms', error: String(e?.message ?? e).slice(0, 300) };
  }
}

// Email via SMTP (nodemailer). Config: SMTP_HOST (activates the channel), SMTP_PORT (default 587), SMTP_USER,
// SMTP_PASS, SMTP_FROM (envelope from), SMTP_SECURE ('true' ⇒ implicit TLS/465). Convention: if the body has
// a first line followed by a blank line it is used as the Subject and the remainder as the text body; else a
// default subject applies. Transport is cached per host:port so a blast reuses one pool. Errors → 'failed'.
interface EmailCreds { host: string; port: number; user?: string; pass?: string; from?: string; secure: boolean; subject?: string }
let mailer: { key: string; tx: Transporter } | null = null;
function transport(c: EmailCreds): Transporter {
  const key = `${c.host}:${c.port}:${c.user ?? ''}:${c.secure}`;
  if (mailer?.key === key) return mailer.tx;
  const tx = nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure,
    ...(c.user ? { auth: { user: c.user, pass: c.pass ?? '' } } : {}),
  });
  mailer = { key, tx };
  return tx;
}

async function sendEmail(c: EmailCreds, to: string, body: string): Promise<SendResult> {
  const nl = body.indexOf('\n\n');
  const subject = nl > 0 ? body.slice(0, nl).trim().slice(0, 200) : (c.subject ?? 'แจ้งข่าวสาร');
  const text = nl > 0 ? body.slice(nl + 2) : body;
  const from = c.from ?? c.user ?? 'no-reply@localhost';
  try {
    const info = await transport(c).sendMail({ from, to, subject, text });
    return { status: 'sent', provider: 'email', ref: info.messageId ?? `email_${rnd()}` };
  } catch (e: any) {
    return { status: 'failed', provider: 'email', error: String(e?.message ?? e).slice(0, 300) };
  }
}
