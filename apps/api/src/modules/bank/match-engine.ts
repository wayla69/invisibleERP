// Bank reconciliation auto-match engine (shared). The scoring that ties an imported bank-statement line to
// a book entry — amount (within a cent), date (within a tolerance window), and an optional payer-ref — lives
// HERE as one reusable matcher so both the GL bank reconciliation (bank.service.ts autoMatch) and the
// PromptPay store-level reconciliation (promptpay-recon.service.ts) score identically. Do NOT fork a second
// matcher; extend this one.

export const TOLERANCE_DAYS = 5;

export const round4 = (x: unknown) => Math.round((Number(x) || 0) * 10000) / 10000;

// Whole-day distance between two dates (calendar days, sign-agnostic).
export const daysApart = (a: unknown, b: unknown) =>
  Math.abs((new Date(String(a)).getTime() - new Date(String(b)).getTime()) / 86400000);

// The core score predicate: the amounts tie (within a cent) and the dates fall inside the tolerance window.
export function amountDateMatch(
  candidateAmount: number,
  candidateDate: unknown,
  targetAmount: number,
  targetDate: unknown,
  toleranceDays: number = TOLERANCE_DAYS,
): boolean {
  return Math.abs(round4(candidateAmount) - round4(targetAmount)) < 0.01
    && daysApart(candidateDate, targetDate) <= toleranceDays;
}

export interface BankSide<L> { line: L; amount: number; date: unknown; ref?: string | null }
export interface BookSide<B> { entry: B; amount: number; date: unknown; ref?: string | null }

export interface GreedyMatchResult<L, B> {
  matches: { bank: BankSide<L>; book: BookSide<B> }[];
  unmatchedBank: BankSide<L>[];
  unmatchedBook: BookSide<B>[];
}

// Greedy one-to-one matcher over normalized bank inflow lines and book entries. For each bank line, take the
// first still-unused book entry that (a) passes amountDateMatch and (b) — when BOTH sides carry a payer-ref —
// has the book ref appear in the bank line's ref (containment; the bank narration usually wraps the ref).
// When either ref is absent the match falls back to amount+date only (same behaviour as the GL auto-match).
export function greedyMatch<L, B>(
  bank: BankSide<L>[],
  book: BookSide<B>[],
  toleranceDays: number = TOLERANCE_DAYS,
): GreedyMatchResult<L, B> {
  const used = new Set<number>();
  const matches: { bank: BankSide<L>; book: BookSide<B> }[] = [];
  const unmatchedBank: BankSide<L>[] = [];
  for (const bl of bank) {
    const idx = book.findIndex((be, i) =>
      !used.has(i)
      && amountDateMatch(be.amount, be.date, bl.amount, bl.date, toleranceDays)
      && refMatch(bl.ref, be.ref));
    if (idx >= 0) {
      used.add(idx);
      matches.push({ bank: bl, book: book[idx]! });
    } else {
      unmatchedBank.push(bl);
    }
  }
  const unmatchedBook = book.filter((_, i) => !used.has(i));
  return { matches, unmatchedBank, unmatchedBook };
}

// Ref gate: only constrains the match when BOTH refs are present; a normalized book ref must be a substring
// of the normalized bank narration (case/space-insensitive). Missing ref on either side → no ref constraint.
function refMatch(bankRef?: string | null, bookRef?: string | null): boolean {
  if (!bankRef || !bookRef) return true;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  return norm(bankRef).includes(norm(bookRef)) || norm(bookRef).includes(norm(bankRef));
}
