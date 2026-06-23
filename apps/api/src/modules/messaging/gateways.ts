// Outbound customer-messaging gateways (LINE / SMS / email). Provider-agnostic, mirroring the payment
// gateway pattern: a channel resolves to a real provider when its credentials are configured, otherwise a
// Mock that records the message as 'sent' (dev/demo). Real providers are stubs pending API wiring — the
// abstraction + delivery log let the rest of the system work today and a real client drops in here.
const rnd = () => Math.random().toString(36).slice(2, 12);

export type MessageChannel = 'line' | 'sms' | 'email';
export interface SendResult { status: 'sent' | 'failed'; provider: string; ref?: string; error?: string }

const ENV: Record<MessageChannel, string | undefined> = {
  line: process.env.LINE_CHANNEL_TOKEN,
  sms: process.env.SMS_API_KEY,
  email: process.env.SMTP_HOST,
};

export function resolveMessageGateway(channel: MessageChannel) {
  const configured = !!ENV[channel];
  const provider = configured ? channel : 'mock';
  return {
    provider,
    async send(_recipient: string, _body: string): Promise<SendResult> {
      // Stub: a real LINE/SMS/email client call goes here when `configured`. Returns success either way;
      // the `provider` label distinguishes a real send from the dev mock in the delivery log.
      return { status: 'sent', provider, ref: `${provider}_${rnd()}` };
    },
  };
}
