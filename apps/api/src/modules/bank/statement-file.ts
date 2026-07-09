// Bank-statement FILE normalizer (pure — no DB). Turns the CSV/XLSX a Thai bank's internet-banking
// export produces (KBank / SCB / BBL and the common generic shapes) into the exact
// `ImportStatementDto` the existing `importStatement` accepts — so the file path is a thin front on
// the same REC/BANK-02 spine, never a second import pipeline.
//
// Header-driven, not bank-hardcoded: columns are located by fuzzy Thai/English header match
// (วันที่/Date, รายการ/Description, ถอน/Withdrawal, ฝาก/Deposit, จำนวนเงิน/Amount, คงเหลือ/Balance),
// which covers all three banks' exports without pretending their unpublished formats are stable.
// Dates accept dd/mm/yyyy · dd-mm-yyyy · yyyy-mm-dd; Buddhist-Era years (พ.ศ. > 2300) convert to CE;
// a 2-digit year ≥ 44 is read as BE short-form (69 → 2569 → 2026), else CE 20yy. Amounts strip
// commas/฿ and read parentheses as negative. Non-transaction rows (summary/footer lines with no
// parsable date+amount) are skipped and COUNTED — never silently dropped.

export interface NormalizedStatement {
  statement_date: string;
  opening_bal: number;
  closing_bal: number;
  lines: { date: string; description?: string; amount: number; balance?: number }[];
  skipped: number;
  detected: { date: string; description?: string; withdrawal?: string; deposit?: string; amount?: string; balance?: string };
}

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

const HEADER_PATTERNS: Record<string, RegExp> = {
  date: /วันที่|^date$|txn.*date|transaction.*date|value.*date/i,
  description: /รายการ|คำอธิบาย|description|transaction(?!.*date)|detail|memo|particular/i,
  withdrawal: /ถอน|withdraw|debit|เดบิต|จ่ายออก|payment/i,
  deposit: /ฝาก|deposit|credit(?!.*card)|เครดิต|รับเข้า|receive/i,
  amount: /จำนวนเงิน|^amount$|^amt$/i,
  balance: /คงเหลือ|ยอดคงเหลือ|balance|outstanding/i,
};

function findColumns(headers: string[]): Partial<Record<keyof typeof HEADER_PATTERNS, string>> {
  const found: Record<string, string> = {};
  for (const key of ['date', 'description', 'withdrawal', 'deposit', 'amount', 'balance'] as const) {
    const h = headers.find((x) => HEADER_PATTERNS[key]!.test(x.trim()));
    if (h) found[key] = h;
  }
  return found;
}

/** dd/mm/yyyy · dd-mm-yyyy · yyyy-mm-dd (+ BE → CE; 2-digit-year heuristic) → ISO YYYY-MM-DD, or null. */
export function parseStatementDate(raw: string | undefined): string | null {
  const s = String(raw ?? '').trim().split(/[ T]/)[0] ?? ''; // drop a time part ("09/07/2569 14:30")
  let d: number, m: number, y: number;
  let mm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (mm) { y = Number(mm[1]); m = Number(mm[2]); d = Number(mm[3]); }
  else {
    mm = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s);
    if (!mm) return null;
    d = Number(mm[1]); m = Number(mm[2]); y = Number(mm[3]);
    if (mm[3]!.length === 2) y = y >= 44 ? 2500 + y - 543 : 2000 + y; // BE short (69→2026) vs CE short (26→2026)
  }
  if (y > 2300) y -= 543; // Buddhist Era → CE
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2200) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "1,234.50" / "฿1,234.50" / "(35.00)" → number (parentheses = negative), or null when not numeric. */
export function parseStatementAmount(raw: string | undefined): number | null {
  let s = String(raw ?? '').replace(/[,฿\s]|THB/gi, '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const v = Number(s);
  return neg ? -v : v;
}

export class StatementParseError extends Error {
  constructor(public readonly code: string, message: string, public readonly messageTh: string) { super(message); }
}

/** Header-keyed rows (from parseCsv/parseXlsx) → normalized statement. Throws StatementParseError. */
export function normalizeStatementRows(
  rows: Record<string, string>[],
  opts: { opening_bal?: number; closing_bal?: number; statement_date?: string } = {},
): NormalizedStatement {
  if (!rows.length) throw new StatementParseError('NO_ROWS', 'The file contains no data rows', 'ไฟล์ไม่มีข้อมูลรายการ');
  const headers = Object.keys(rows[0]!);
  const cols = findColumns(headers);
  if (!cols.date) throw new StatementParseError('NO_DATE_COLUMN', `No date column found (headers: ${headers.join(', ')})`, 'ไม่พบคอลัมน์วันที่ในไฟล์');
  if (!cols.amount && !cols.withdrawal && !cols.deposit)
    throw new StatementParseError('NO_AMOUNT_COLUMN', `No amount/withdrawal/deposit column found (headers: ${headers.join(', ')})`, 'ไม่พบคอลัมน์จำนวนเงิน (ฝาก/ถอน) ในไฟล์');

  const lines: NormalizedStatement['lines'] = [];
  let skipped = 0;
  for (const r of rows) {
    const date = parseStatementDate(r[cols.date]);
    let amount: number | null = null;
    if (cols.withdrawal || cols.deposit) {
      const w = cols.withdrawal ? parseStatementAmount(r[cols.withdrawal]) : null;
      const dep = cols.deposit ? parseStatementAmount(r[cols.deposit]) : null;
      if (w != null || dep != null) amount = round2((dep ?? 0) - Math.abs(w ?? 0)); // signed: +in / -out
    } else if (cols.amount) {
      amount = parseStatementAmount(r[cols.amount]);
    }
    if (!date || amount == null) { skipped++; continue; } // summary/footer/blank row — counted, not silent
    const balance = cols.balance ? parseStatementAmount(r[cols.balance]) : null;
    lines.push({ date, description: cols.description ? (r[cols.description] ?? '').trim() || undefined : undefined, amount, ...(balance != null ? { balance } : {}) });
  }
  if (!lines.length) throw new StatementParseError('NO_PARSABLE_LINES', 'No row had a parsable date + amount', 'ไม่มีแถวที่อ่านวันที่และจำนวนเงินได้');

  // Opening/closing: explicit > derived from the running balance > derived from the sum of movements.
  const first = lines[0]!, last = lines[lines.length - 1]!;
  const sum = round2(lines.reduce((a, l) => a + l.amount, 0));
  const opening = opts.opening_bal ?? (first.balance != null ? round2(first.balance - first.amount) : 0);
  const closing = opts.closing_bal ?? (last.balance != null ? last.balance : round2(opening + sum));
  const statementDate = opts.statement_date ?? lines.reduce((a, l) => (l.date > a ? l.date : a), first.date);

  return { statement_date: statementDate, opening_bal: opening, closing_bal: closing, lines, skipped, detected: cols as NormalizedStatement['detected'] };
}
