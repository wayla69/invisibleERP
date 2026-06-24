// Outbound customer-messaging gateways (LINE / SMS / email). Provider-agnostic, mirroring the payment
// gateway pattern: a channel resolves to a real provider when its credentials are configured, otherwise a
// Mock that records the message as 'sent' (dev/demo). LINE has a real push implementation (the dominant
// Thai channel); SMS/email remain stubs pending a provider account. The abstraction + delivery log let
// the rest of the system work today and a real client drops in here.
const rnd = () => Math.random().toString(36).slice(2, 12);

export type MessageChannel = 'line' | 'sms' | 'email';
export interface SendResult { status: 'sent' | 'failed'; provider: string; ref?: string; error?: string }

const ENV: Record<MessageChannel, string | undefined> = {
  line: process.env.LINE_CHANNEL_TOKEN,
  sms: process.env.SMS_API_KEY,
  email: process.env.SMTP_HOST,
};

export function resolveMessageGateway(channel: MessageChannel) {
  const token = ENV[channel];
  const configured = !!token;
  const provider = configured ? channel : 'mock';
  return {
    provider,
    async send(recipient: string, body: string): Promise<SendResult> {
      // LINE: real push when a channel token is configured (recipient = LINE userId). SMS/email real
      // clients drop in below the same way; until configured they fall through to the dev mock.
      if (channel === 'line' && configured) return sendLinePush(token!, recipient, body);
      return { status: 'sent', provider, ref: `${provider}_${rnd()}` };
    },
  };
}

// LINE Messaging API push (https://api.line.me/v2/bot/message/push). The recipient is a LINE userId the
// customer obtained by adding the shop's Official Account / via LINE Login. Network or API errors return
// 'failed' (logged in message_log) rather than throwing, so a receipt send never crashes the POS flow.
async function sendLinePush(token: string, to: string, text: string): Promise<SendResult> {
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: 'text', text: text.slice(0, 5000) }] }),
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
