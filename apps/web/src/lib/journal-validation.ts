// Shared validation for the double-entry ledger forms (manual journal, recurring journal, prepaid) — they
// all collect `{ account_code, debit, credit }` lines that must net to a balanced, non-zero entry. Kept
// framework-free so any form can call it; messages are Thai to match those screens.

export interface JeLine { account_code: string; debit: string; credit: string }

const nAmt = (v: string) => (v === '' ? 0 : Number(v) || 0);

/** Per-line error for a line the user has started to fill (an all-empty line returns null so trailing rows
 *  never nag). Enforces: no negatives, exactly one of debit/credit, an account, and an amount. */
export function jeLineError(l: JeLine): string | null {
  const hasAcct = !!l.account_code?.trim();
  const touched = hasAcct || l.debit !== '' || l.credit !== '';
  if (!touched) return null;
  const d = nAmt(l.debit);
  const c = nAmt(l.credit);
  if (d < 0 || c < 0) return 'จำนวนต้องไม่ติดลบ';
  if (d > 0 && c > 0) return 'ใส่เดบิตหรือเครดิตอย่างใดอย่างหนึ่ง ไม่ใช่ทั้งสอง';
  if (!hasAcct) return 'เลือกบัญชี';
  if (d === 0 && c === 0) return 'ใส่จำนวนเดบิตหรือเครดิต';
  return null;
}

/** Form-level error across all lines: at least two posting lines, a positive total, and debits = credits.
 *  The imbalance amount is shown so the user knows how far off (and which side) they are. */
export function jeFormError(lines: JeLine[]): string | null {
  const active = lines.filter((l) => l.account_code?.trim() && (nAmt(l.debit) !== 0 || nAmt(l.credit) !== 0));
  if (active.length < 2) return 'ต้องมีอย่างน้อย 2 บรรทัดที่มีบัญชีและจำนวน';
  const sumD = lines.reduce((a, l) => a + nAmt(l.debit), 0);
  const sumC = lines.reduce((a, l) => a + nAmt(l.credit), 0);
  if (!(sumD > 0)) return 'ยอดรวมต้องมากกว่า 0';
  if (Math.abs(sumD - sumC) >= 0.005) {
    const diff = Math.abs(sumD - sumC).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `เดบิตและเครดิตไม่สมดุล — ${sumD > sumC ? 'เดบิต' : 'เครดิต'}เกิน ฿${diff}`;
  }
  return null;
}

/** True when the lines form a postable, balanced entry (no per-line or form errors). */
export function jeValid(lines: JeLine[]): boolean {
  return !jeFormError(lines) && !lines.some((l) => jeLineError(l));
}
