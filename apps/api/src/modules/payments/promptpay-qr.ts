// Real EMVCo PromptPay QR payload (Thailand). Replaces the simulated `promptpay_<amount>` ref with a
// string a banking app can actually scan to pay. Settlement is still confirmed out-of-band (the gateway
// stays 'Pending' until a bank/PSP webhook flips it), but the QR itself is genuine.
//
// Spec: EMVCo MPM + Bank of Thailand PromptPay (AID A000000677010111).

const AID_PROMPTPAY = 'A000000677010111';

// Tag-Length-Value: 2-digit id, 2-digit length, value.
function tlv(id: string, value: string): string {
  return `${id}${value.length.toString().padStart(2, '0')}${value}`;
}

// CRC16-CCITT (FALSE): poly 0x1021, init 0xFFFF — the checksum EMVCo QR uses (tag 63).
export function crc16ccitt(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// Map a PromptPay target to its merchant sub-field:
//  • 13-digit national ID / tax ID  → sub-tag 02, value as-is
//  • mobile number (local, leading 0) → sub-tag 01, value 0066XXXXXXXXX (drop leading 0, prefix 66, 13 digits)
function formatTarget(raw: string): { sub: string; value: string } {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 13) return { sub: '02', value: digits };
  const local = digits.replace(/^0/, '');
  return { sub: '01', value: ('0000000000000' + ('66' + local)).slice(-13) };
}

/**
 * Build a scannable PromptPay QR payload.
 * @param target  merchant PromptPay ID — a Thai mobile number (0xxxxxxxxx) or 13-digit national/tax ID
 * @param amount  optional THB amount → makes it a DYNAMIC QR (fixed amount); omit for a static QR
 */
export function buildPromptPayPayload(target: string, amount?: number): string {
  const { sub, value } = formatTarget(target);
  const merchantAccount = tlv('00', AID_PROMPTPAY) + tlv(sub, value);
  const hasAmount = typeof amount === 'number' && amount > 0;
  let payload =
    tlv('00', '01') +                          // payload format indicator
    tlv('01', hasAmount ? '12' : '11') +       // point of initiation: 12=dynamic, 11=static
    tlv('29', merchantAccount) +               // PromptPay merchant account info
    tlv('53', '764') +                         // transaction currency THB (ISO-4217 764)
    (hasAmount ? tlv('54', amount.toFixed(2)) : '') + // transaction amount
    tlv('58', 'TH');                           // country code
  payload += '6304';                           // CRC tag (63) + length (04); value computed over all above + this
  return payload + crc16ccitt(payload);
}

export function isValidPromptPayTarget(raw: string): boolean {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length === 13 || (digits.length === 10 && digits.startsWith('0'));
}
