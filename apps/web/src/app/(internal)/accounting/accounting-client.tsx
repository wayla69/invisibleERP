'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardPaste, Plus, Save, Scale, ShieldCheck, X } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useMe, hasPerm } from '@/lib/auth';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

type Account = { code: string; name: string; type: string };
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function AccountingWorkspace({ initialTb }: { initialTb?: unknown }) {
  const me = useMe();
  // SoD R05/GL-05: JE preparer (gl_post) ≠ JE approver (approvals/gl_close).
  // The "รออนุมัติ (JE)" tab is only shown to users who hold the approval duty.
  const canApproveJE = hasPerm(me.data, 'approvals', 'gl_close', 'exec');

  const tabs = [
    { key: 'tb', label: 'งบทดลอง', content: <TrialBalance initialData={initialTb} /> },
    { key: 'gldetail', label: 'แยกประเภทรายบัญชี', content: <GLDetail /> },
    { key: 'tieout', label: 'กระทบยอดบัญชีย่อย', content: <SubledgerTieout /> },
    { key: 'coa', label: 'ผังบัญชี', content: <ChartOfAccounts /> },
    { key: 'journal', label: 'สมุดรายวัน', content: <Journal /> },
    ...(canApproveJE ? [{ key: 'approve', label: 'รออนุมัติ (JE)', content: <PendingJournal /> }] : []),
    { key: 'pl', label: 'งบกำไรขาดทุน', content: <IncomeStatement /> },
    { key: 'bs', label: 'งบดุล', content: <BalanceSheet /> },
    { key: 'cf', label: 'งบกระแสเงินสด', content: <CashFlow /> },
    { key: 'opening', label: 'ยอดยกมา', content: <OpeningBalances /> },
  ];

  return (
    <div>
      <PageHeader
        title="บัญชีแยกประเภท"
        description="บัญชีคู่ (double-entry) — ทุกการขายลงบัญชีอัตโนมัติ เดบิตต้องเท่าเครดิตเสมอ"
      />
      <Tabs tabs={tabs} />
    </div>
  );
}

// ───────────────────────── ผังบัญชี (Chart of Accounts) ─────────────────────────
// Shows the tenant's industry-curated chart by default; the toggle reveals the full canonical universe
// (?all=true) for unusual postings. Account names follow the industry template set at company creation.
type CoaAccount = Account & { name_th?: string | null; group_label?: string | null };
function ChartOfAccounts() {
  const [showAll, setShowAll] = useState(false);
  const q = useQuery<{ accounts: CoaAccount[]; count: number; source?: string; industry_scoped?: boolean }>({
    queryKey: ['coa', showAll],
    queryFn: () => api(`/api/ledger/accounts${showAll ? '?all=true' : ''}`),
  });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {q.data.industry_scoped && !showAll ? (
                <Badge variant="success">ผังบัญชีตามประเภทธุรกิจ</Badge>
              ) : (
                <Badge variant="secondary">ผังบัญชีเต็ม (ทุกบัญชี)</Badge>
              )}
              <span>{q.data.count} บัญชี</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'แสดงเฉพาะบัญชีของธุรกิจ' : 'แสดงบัญชีทั้งหมด'}
            </Button>
          </div>
          <DataTable
            rows={q.data.accounts}
            emptyState={{ icon: Scale, title: 'ยังไม่มีผังบัญชี', description: 'ผังบัญชีจะถูกตั้งค่าตามประเภทธุรกิจที่เลือกตอนเปิดบริษัท' }}
            columns={[
              { key: 'code', label: 'รหัส' },
              { key: 'name', label: 'ชื่อบัญชี' },
              { key: 'name_th', label: 'ชื่อ (ไทย)', render: (r: CoaAccount) => r.name_th || <span className="text-muted-foreground">—</span> },
              { key: 'type', label: 'ประเภท' },
            ]}
          />
        </div>
      )}
    </StateView>
  );
}

// ───────────────────────── งบทดลอง ─────────────────────────
function TrialBalance({ initialData }: { initialData?: unknown }) {
  // Server-prefetched payload (see page.tsx) renders instantly; react-query still owns the cache and
  // refetches on invalidation exactly as before. A null/undefined prefetch = the old client-only path.
  const q = useQuery<any>({ queryKey: ['tb'], queryFn: () => api('/api/ledger/trial-balance'), initialData: initialData ?? undefined });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="รวมเดบิต" value={baht(q.data.totals.debit)} tone="primary" />
            <StatCard label="รวมเครดิต" value={baht(q.data.totals.credit)} tone="primary" />
            <StatCard
              label="สถานะ"
              value={<Badge variant={q.data.totals.balanced ? 'success' : 'destructive'}>{q.data.totals.balanced ? 'สมดุล' : 'ไม่สมดุล'}</Badge>}
            />
          </div>
          <DataTable
            rows={q.data.rows}
            emptyState={{ icon: Scale, title: 'ยังไม่มียอดในงบทดลอง', description: 'ลงยอดยกมาหรือบันทึกรายการในสมุดรายวันเพื่อให้ยอดปรากฏที่นี่' }}
            columns={[
              { key: 'account_code', label: 'รหัส' },
              { key: 'account_name', label: 'ชื่อบัญชี' },
              { key: 'account_type', label: 'ประเภท' },
              { key: 'debit', label: 'เดบิต', align: 'right', render: (r: any) => <span className="tabular">{baht(r.debit)}</span> },
              { key: 'credit', label: 'เครดิต', align: 'right', render: (r: any) => <span className="tabular">{baht(r.credit)}</span> },
              { key: 'balance', label: 'ยอดคงเหลือ', align: 'right', render: (r: any) => <span className="tabular">{baht(r.balance)}</span> },
            ]}
          />
        </div>
      )}
    </StateView>
  );
}

// ───────────────────────── สมุดรายวัน + ลงรายการ ─────────────────────────
type Line = { account_code: string; debit: string; credit: string };
const emptyLine = (): Line => ({ account_code: '', debit: '', credit: '' });

function Journal() {
  const qc = useQueryClient();
  const accounts = useQuery<{ accounts: Account[] }>({ queryKey: ['accounts'], queryFn: () => api('/api/ledger/accounts') });
  const journal = useQuery<any>({ queryKey: ['journal'], queryFn: () => api('/api/ledger/journal?limit=30') });

  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);

  const sumDebit = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0);
  const sumCredit = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(sumDebit - sumCredit) < 0.005 && sumDebit > 0;

  const post = useMutation({
    mutationFn: () =>
      api<{ entry_no: string }>('/api/ledger/journal', {
        method: 'POST',
        body: JSON.stringify({
          source: 'Manual',
          memo: memo || undefined,
          lines: lines
            .filter((l) => l.account_code && (Number(l.debit) || Number(l.credit)))
            .map((l) => ({ account_code: l.account_code, debit: Number(l.debit) || undefined, credit: Number(l.credit) || undefined })),
        }),
      }),
    onSuccess: (r) => {
      notifySuccess(`บันทึกเป็นฉบับร่าง — รออนุมัติจากผู้อื่น (maker-checker): ${r.entry_no}`);
      setMemo(''); setLines([emptyLine(), emptyLine()]);
      qc.invalidateQueries({ queryKey: ['journal'] });
      qc.invalidateQueries({ queryKey: ['je-pending'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">ลงรายการบัญชี (Manual Journal)</h3>
        <Input placeholder="คำอธิบาย (memo)" value={memo} onChange={(e) => setMemo(e.target.value)} />
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-2 font-medium">บัญชี</th>
              <th className="w-[130px] pb-2 font-medium">เดบิต</th>
              <th className="w-[130px] pb-2 font-medium">เครดิต</th>
              <th className="w-10 pb-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="py-1 pr-2">
                  <select className={selectCls} value={l.account_code} onChange={(e) => setLine(i, { account_code: e.target.value })}>
                    <option value="">— เลือกบัญชี —</option>
                    {accounts.data?.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                  </select>
                </td>
                <td className="py-1 pr-2"><Input type="number" min="0" value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: '' })} /></td>
                <td className="py-1 pr-2"><Input type="number" min="0" value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: '' })} /></td>
                <td className="py-1">{lines.length > 2 && <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><X className="size-4" /></Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
            <Plus className="size-4" /> เพิ่มบรรทัด
          </Button>
          <span className="text-sm">
            เดบิต <strong className="tabular">{baht(sumDebit)}</strong> · เครดิต <strong className="tabular">{baht(sumCredit)}</strong>{' '}
            <Badge variant={balanced ? 'success' : 'warning'}>{balanced ? 'สมดุล' : 'ยังไม่สมดุล'}</Badge>
          </span>
          <Button disabled={!balanced || post.isPending} onClick={() => post.mutate()}>
            <Save className="size-4" /> {post.isPending ? 'กำลังบันทึก…' : 'บันทึกรายการ'}
          </Button>
        </div>
      </Card>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">รายการล่าสุด</h3>
        <StateView q={journal}>
          {journal.data && (
            <div className="grid gap-3">
              {journal.data.entries.length === 0 && <Card className="gap-0 p-5"><span className="text-sm text-muted-foreground">ยังไม่มีรายการ</span></Card>}
              {journal.data.entries.map((e: any) => (
                <Card key={e.entry_no} className="gap-2 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong>{e.entry_no}</strong>
                    <span className="flex items-center gap-1 text-sm text-muted-foreground">
                      {thaiDate(e.entry_date)} · {e.source}{e.source_ref ? ` · ${e.source_ref}` : ''} · <Badge variant={statusVariant(e.status)}>{e.status}</Badge>
                    </span>
                  </div>
                  {e.memo && <div className="text-sm text-muted-foreground">{e.memo}</div>}
                  <table className="w-full text-sm">
                    <tbody>
                      {e.lines.map((l: any, j: number) => (
                        <tr key={j}>
                          <td className="py-0.5">{l.account_code}</td>
                          <td className="py-0.5 text-right tabular">{l.debit ? baht(l.debit) : ''}</td>
                          <td className="py-0.5 text-right tabular">{l.credit ? baht(l.credit) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              ))}
            </div>
          )}
        </StateView>
      </div>
    </div>
  );
}

// ─────────────── รออนุมัติ JE (GL-05 maker-checker) ───────────────
function PendingJournal() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['je-pending'], queryFn: () => api('/api/ledger/journal/pending?limit=50') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['je-pending'] }); qc.invalidateQueries({ queryKey: ['journal'] }); qc.invalidateQueries({ queryKey: ['tb'] }); };
  const approve = useMutation({ mutationFn: (no: string) => api(`/api/ledger/journal/${no}/approve`, { method: 'POST' }), onSuccess: (r: any) => { notifySuccess(`อนุมัติแล้ว ${r.entry_no}`); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const reject = useMutation({ mutationFn: (no: string) => { const reason = prompt('เหตุผลที่ไม่อนุมัติ (optional)') ?? undefined; return api(`/api/ledger/journal/${no}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); }, onSuccess: (r: any) => { notifySuccess(`ไม่อนุมัติ ${r.entry_no}`); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const entries = q.data?.entries ?? [];
  return (
    <div className="space-y-4">
      <Card className="flex-row flex-wrap items-center gap-2 p-4 text-sm">
        <ShieldCheck className="size-4 text-muted-foreground" />
        แยกหน้าที่ (maker-checker): ผู้บันทึกอนุมัติรายการของตนเองไม่ได้ — ต้องเป็นคนละคน. รายการที่ยังไม่อนุมัติจะ <strong>ไม่</strong> เข้างบทดลอง.
      </Card>
      <StateView q={q}>
        {entries.length === 0 ? (
          <Card className="gap-0 p-5"><span className="text-sm text-muted-foreground">ไม่มีรายการรออนุมัติ</span></Card>
        ) : (
          <div className="grid gap-3">
            {entries.map((e: any) => (
              <Card key={e.entry_no} className="gap-2 p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>{e.entry_no}</strong>
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    {thaiDate(e.entry_date)} · บันทึกโดย <Badge variant="outline">{e.created_by}</Badge> · <Badge variant={statusVariant(e.status)}>{e.status}</Badge>
                  </span>
                </div>
                {e.memo && <div className="text-sm text-muted-foreground">{e.memo}</div>}
                <table className="w-full text-sm">
                  <tbody>
                    {e.lines.map((l: any, j: number) => (
                      <tr key={j}><td className="py-0.5">{l.account_code}</td><td className="py-0.5 text-right tabular">{l.debit ? baht(l.debit) : ''}</td><td className="py-0.5 text-right tabular">{l.credit ? baht(l.credit) : ''}</td></tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex gap-2">
                  <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate(e.entry_no)}><Check className="size-4" /> อนุมัติ</Button>
                  <Button size="sm" variant="destructive" disabled={reject.isPending} onClick={() => reject.mutate(e.entry_no)}><X className="size-4" /> ไม่อนุมัติ</Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── งบกำไรขาดทุน ─────────────────────────
function IncomeStatement() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const q = useQuery<any>({ queryKey: ['pl', from, to], queryFn: () => api(`/api/ledger/income-statement?from=${from}&to=${to}`) });
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="pl-from">ตั้งแต่</Label>
          <Input id="pl-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pl-to">ถึง</Label>
          <Input id="pl-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="รายได้" value={baht(q.data.revenue)} tone="primary" />
            <StatCard label="ค่าใช้จ่าย" value={baht(q.data.expense)} tone="danger" />
            <StatCard label="กำไรสุทธิ" value={baht(q.data.net_income)} tone={q.data.net_income >= 0 ? 'success' : 'danger'} />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── ยอดยกมา (Opening balances) ─────────────────────────
type ObLine = { account_code: string; debit: string; credit: string };
const emptyObLine = (): ObLine => ({ account_code: '', debit: '', credit: '' });

// Parse rows pasted from Excel/Google Sheets/CSV into opening-balance lines. Resilient to the common
// shapes of an exported trial balance: an optional header row; an account-name column between the code
// and the amounts; thousands separators; a debit AND credit column (blanks kept so the column position
// isn't lost); or a single signed-amount column (positive ⇒ debit, negative ⇒ credit).
// A cell is numeric only if it actually contains a digit (an account name reads as NaN, not 0).
const num = (s: string) => {
  const t = String(s).replace(/,/g, '').trim();
  if (t === '' || !/\d/.test(t)) return NaN;
  const v = Number(t.replace(/[^\d.-]/g, ''));
  return Number.isFinite(v) ? v : NaN;
};
function parseObPaste(text: string): ObLine[] {
  const out: ObLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    // Pick ONE delimiter — a spreadsheet paste is tab-delimited, so splitting on comma too would shred a
    // "50,000" thousands separator. Prefer tab, then semicolon, then comma (plain CSV).
    const sep = raw.includes('\t') ? '\t' : raw.includes(';') ? ';' : ',';
    const cells = raw.split(sep).map((c) => c.trim());
    const code = cells[0];
    if (!code) continue;
    // Collect the trailing amount cells (numeric or blank), stopping at the first text cell (the account
    // name / the code). Blanks are retained so a debit-vs-credit column position is preserved.
    const amounts: string[] = [];
    for (let i = cells.length - 1; i >= 1; i--) {
      const cell = cells[i];
      if (cell === '' || !Number.isNaN(num(cell))) amounts.unshift(cell);
      else break;
    }
    let debit = '', credit = '';
    if (amounts.length >= 2) {
      const d = num(amounts[0]!), c = num(amounts[1]!);
      if (!Number.isNaN(d) && d !== 0) debit = String(d);
      if (!Number.isNaN(c) && c !== 0) credit = String(c);
    } else if (amounts.length === 1) {
      const v = num(amounts[0]!);
      if (!Number.isNaN(v) && v !== 0) { if (v < 0) credit = String(-v); else debit = String(v); }
    }
    if (!debit && !credit) continue; // header / blank / a zero-only line — nothing to post
    out.push({ account_code: code, debit, credit });
  }
  return out;
}

function OpeningBalances() {
  const qc = useQueryClient();
  const accounts = useQuery<{ accounts: Account[] }>({ queryKey: ['accounts'], queryFn: () => api('/api/ledger/accounts') });

  const [batchRef, setBatchRef] = useState('');
  const [lines, setLines] = useState<ObLine[]>([emptyObLine(), emptyObLine()]);
  const [errs, setErrs] = useState<{ row: number; error: string }[]>([]);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const applyPaste = () => {
    const parsed = parseObPaste(pasteText);
    if (!parsed.length) { notifyError('ไม่พบรายการที่อ่านได้ — วางคอลัมน์ รหัสบัญชี / เดบิต / เครดิต'); return; }
    // Append onto any rows the user already keyed; drop the two blank starter rows.
    setLines((ls) => { const kept = ls.filter((l) => l.account_code || l.debit || l.credit); return [...kept, ...parsed]; });
    setPasteText(''); setPasteOpen(false);
    notifySuccess(`นำเข้า ${parsed.length} รายการ — ตรวจทานก่อนลงยอด`);
  };

  const sumDebit = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0);
  const sumCredit = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);
  // net imbalance auto-posts to account 3000 (Opening Balance Equity)
  const diff = sumDebit - sumCredit;
  const equityDebit = diff < 0 ? -diff : 0;
  const equityCredit = diff > 0 ? diff : 0;

  const setLine = (i: number, patch: Partial<ObLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const post = useMutation({
    mutationFn: () =>
      api<{ batch_ref?: string; entry_no?: string; balanced?: boolean; lines_posted?: number; row_errors?: { row: number; error: string }[]; already?: boolean }>(
        '/api/ledger/opening-balances',
        {
          method: 'POST',
          body: JSON.stringify({
            batch_ref: batchRef || undefined,
            rows: lines
              .filter((l) => l.account_code && (Number(l.debit) || Number(l.credit)))
              .map((l) => ({ account_code: l.account_code, debit: Number(l.debit) || undefined, credit: Number(l.credit) || undefined })),
          }),
        },
      ),
    onSuccess: (r) => {
      setErrs(r.row_errors ?? []);
      if (r.already) {
        notifyError('batch_ref นี้ถูกใช้ลงยอดยกมาแล้ว');
        return;
      }
      notifySuccess(`ลงยอดยกมาสำเร็จ: ${r.entry_no} (${r.lines_posted ?? 0} บรรทัด)`);
      setBatchRef(''); setLines([emptyObLine(), emptyObLine()]);
      qc.invalidateQueries({ queryKey: ['tb'] });
      qc.invalidateQueries({ queryKey: ['journal'] });
    },
    onError: (e: any) => { setErrs([]); notifyError(e.message); },
  });

  const hasRows = lines.some((l) => l.account_code && (Number(l.debit) || Number(l.credit)));

  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">ลงยอดยกมา (Opening Balances)</h3>
        <p className="text-sm text-muted-foreground">ผลต่างเดบิต/เครดิตจะลงบัญชี 3000 (ส่วนทุนยอดยกมา) อัตโนมัติ</p>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="grid max-w-sm gap-1.5">
            <Label htmlFor="ob-batch">อ้างอิงชุด (batch ref)</Label>
            <Input id="ob-batch" placeholder="เช่น OB-2026 (กันลงซ้ำ)" value={batchRef} onChange={(e) => setBatchRef(e.target.value)} />
          </div>
          <Button variant="outline" size="sm" onClick={() => setPasteOpen((v) => !v)}>
            <ClipboardPaste className="size-4" /> วางจาก Excel/CSV
          </Button>
        </div>
        {pasteOpen && (
          <div className="grid gap-2 rounded-md border bg-muted/30 p-3">
            <p className="text-sm text-muted-foreground">
              คัดลอกจากงบทดลองเดิม (Excel/Google Sheets) แล้ววางที่นี่ — คอลัมน์ <strong>รหัสบัญชี</strong> ·{' '}
              <strong>เดบิต</strong> · <strong>เครดิต</strong> (มีคอลัมน์ชื่อบัญชีคั่นได้ และตัดหัวตารางให้อัตโนมัติ)
            </p>
            <textarea
              className="min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              placeholder={'1010\tเงินสด\t50000\t0\n2100\tเจ้าหนี้การค้า\t0\t30000'}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setPasteText(''); setPasteOpen(false); }}>ยกเลิก</Button>
              <Button size="sm" disabled={!pasteText.trim()} onClick={applyPaste}>นำเข้ารายการ</Button>
            </div>
          </div>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-2 font-medium">บัญชี</th>
              <th className="w-[130px] pb-2 text-right font-medium">เดบิต</th>
              <th className="w-[130px] pb-2 text-right font-medium">เครดิต</th>
              <th className="w-10 pb-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="py-1 pr-2">
                  <select className={selectCls} value={l.account_code} onChange={(e) => setLine(i, { account_code: e.target.value })}>
                    <option value="">— เลือกบัญชี —</option>
                    {accounts.data?.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                  </select>
                </td>
                <td className="py-1 pr-2"><Input className="text-right tabular" type="number" min="0" value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: '' })} /></td>
                <td className="py-1 pr-2"><Input className="text-right tabular" type="number" min="0" value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: '' })} /></td>
                <td className="py-1">{lines.length > 1 && <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><X className="size-4" /></Button>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t text-muted-foreground">
              <td className="py-1.5">3000 · ส่วนทุนยอดยกมา (อัตโนมัติ)</td>
              <td className="py-1.5 text-right tabular">{equityDebit ? baht(equityDebit) : ''}</td>
              <td className="py-1.5 text-right tabular">{equityCredit ? baht(equityCredit) : ''}</td>
              <td />
            </tr>
            <tr className="border-t font-medium">
              <td className="py-1.5 text-right">รวม</td>
              <td className="py-1.5 text-right tabular">{baht(sumDebit + equityDebit)}</td>
              <td className="py-1.5 text-right tabular">{baht(sumCredit + equityCredit)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, emptyObLine()])}>
            <Plus className="size-4" /> เพิ่มบรรทัด
          </Button>
          <span className="text-sm">
            เดบิต <strong className="tabular">{baht(sumDebit)}</strong> · เครดิต <strong className="tabular">{baht(sumCredit)}</strong>{' '}
            <Badge variant={Math.abs(diff) < 0.005 ? 'success' : 'warning'}>
              {Math.abs(diff) < 0.005 ? 'สมดุล' : `ลง 3000 ${baht(Math.abs(diff))}`}
            </Badge>
          </span>
          <Button disabled={!hasRows || post.isPending} onClick={() => { setErrs([]); post.mutate(); }}>
            <Save className="size-4" /> {post.isPending ? 'กำลังลงยอด…' : 'ลงยอดยกมา'}
          </Button>
        </div>
        {errs.length > 0 && (
          <div className="grid gap-1 text-sm text-destructive">
            {errs.map((e, j) => <div key={j}>แถว {e.row}: {e.error}</div>)}
          </div>
        )}
      </Card>
    </div>
  );
}

// ───────────────────────── งบดุล ─────────────────────────
function BalanceSheet() {
  const [asOf, setAsOf] = useState(today());
  const q = useQuery<any>({ queryKey: ['bs', asOf], queryFn: () => api(`/api/ledger/balance-sheet?as_of=${asOf}`) });
  return (
    <div className="space-y-5">
      <div className="grid max-w-[200px] gap-1.5">
        <Label htmlFor="bs-asof">ณ วันที่</Label>
        <Input id="bs-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
      </div>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="สินทรัพย์" value={baht(q.data.assets)} tone="primary" />
              <StatCard label="หนี้สิน" value={baht(q.data.liabilities)} tone="danger" />
              <StatCard label="ส่วนของเจ้าของ" value={baht(q.data.equity)} />
              <StatCard label="กำไรสะสม" value={baht(q.data.net_income)} />
            </div>
            <Card className="flex-row flex-wrap items-center gap-2 p-5 text-sm">
              <ShieldCheck className="size-4 text-muted-foreground" />
              สินทรัพย์ <span className="tabular">{baht(q.data.assets)}</span> = หนี้สิน+ทุน <span className="tabular">{baht(q.data.liabilities_plus_equity)}</span>{' '}
              <Badge variant={q.data.balanced ? 'success' : 'destructive'}>{q.data.balanced ? 'สมดุล' : 'ไม่สมดุล'}</Badge>
            </Card>
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── งบกระแสเงินสด (Statement of Cash Flows, indirect) ─────────────────────────
function CashFlow() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const q = useQuery<any>({ queryKey: ['cf', from, to], queryFn: () => api(`/api/ledger/cash-flow?from=${from}&to=${to}`) });
  const d = q.data;
  // Render a labelled cash-flow line; positive = cash in (green), negative = cash out (red).
  const flowRow = (label: string, amount: number, i: number) => (
    <tr key={i}>
      <td className="py-0.5 pr-3">{label}</td>
      <td className={`py-0.5 text-right tabular ${amount < 0 ? 'text-red-600' : ''}`}>{baht(amount)}</td>
    </tr>
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="cf-from">ตั้งแต่</Label>
          <Input id="cf-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cf-to">ถึง</Label>
          <Input id="cf-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <StateView q={q}>
        {d && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="เงินสดจากการดำเนินงาน" value={baht(d.operating?.net)} tone={d.operating?.net >= 0 ? 'success' : 'danger'} />
              <StatCard label="เงินสดจากการลงทุน" value={baht(d.investing?.net)} />
              <StatCard label="เงินสดจากการจัดหาเงิน" value={baht(d.financing?.net)} />
            </div>
            <Card className="gap-2 p-5">
              <table className="w-full text-sm">
                <tbody>
                  <tr className="text-muted-foreground"><td className="pb-1 font-medium">กิจกรรมดำเนินงาน (Operating)</td><td /></tr>
                  {flowRow('กำไรสุทธิ (Net income)', d.operating?.net_income ?? 0, -1)}
                  {(d.operating?.adjustments ?? []).map((a: any, i: number) => flowRow(`+ ${a.label ?? a.account_name}`, a.amount, i))}
                  {(d.operating?.working_capital ?? []).map((a: any, i: number) => flowRow(`Δ ${a.label ?? a.account_name}`, a.amount, 1000 + i))}
                  <tr className="border-t font-medium"><td className="py-1">เงินสดสุทธิจากการดำเนินงาน</td><td className="py-1 text-right tabular">{baht(d.operating?.net)}</td></tr>
                  {(d.investing?.lines ?? []).length > 0 && <tr className="text-muted-foreground"><td className="pt-3 pb-1 font-medium">กิจกรรมลงทุน (Investing)</td><td /></tr>}
                  {(d.investing?.lines ?? []).map((a: any, i: number) => flowRow(a.label ?? a.account_name, a.amount, 2000 + i))}
                  {(d.financing?.lines ?? []).length > 0 && <tr className="text-muted-foreground"><td className="pt-3 pb-1 font-medium">กิจกรรมจัดหาเงิน (Financing)</td><td /></tr>}
                  {(d.financing?.lines ?? []).map((a: any, i: number) => flowRow(a.label ?? a.account_name, a.amount, 3000 + i))}
                  <tr className="border-t font-semibold"><td className="py-1.5">เงินสดเปลี่ยนแปลงสุทธิ (Net change in cash)</td><td className="py-1.5 text-right tabular">{baht(d.net_change_in_cash)}</td></tr>
                  <tr><td className="py-0.5 pr-3 text-muted-foreground">เงินสดต้นงวด (Beginning)</td><td className="py-0.5 text-right tabular">{baht(d.cash_beginning)}</td></tr>
                  <tr><td className="py-0.5 pr-3 text-muted-foreground">เงินสดปลายงวด (Ending)</td><td className="py-0.5 text-right tabular">{baht(d.cash_ending)}</td></tr>
                </tbody>
              </table>
            </Card>
            <Card className="flex-row flex-wrap items-center gap-2 p-5 text-sm">
              <ShieldCheck className="size-4 text-muted-foreground" />
              งบกระแสเงินสด (วิธีทางอ้อม) — รายการปิดบัญชีสิ้นปีไม่นับรวม{' '}
              <Badge variant={d.reconciled ? 'success' : 'destructive'}>{d.reconciled ? 'กระทบยอดเงินสดตรง' : 'ไม่ตรง'}</Badge>
            </Card>
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────── แยกประเภทรายบัญชี (GL detail / account ledger) ─────────────────────
// Every posted line for ONE account over a date range, with a running balance struck from the opening
// balance — the classic GL-detail drill-down behind the trial balance (GET /api/ledger/account-ledger).
function GLDetail() {
  const accountsQ = useQuery<{ accounts: Account[] }>({ queryKey: ['accounts'], queryFn: () => api('/api/ledger/accounts') });
  const [account, setAccount] = useState('');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const q = useQuery<any>({ queryKey: ['gldetail', account, from, to], queryFn: () => api(`/api/ledger/account-ledger?account=${account}&from=${from}&to=${to}`), enabled: !!account });
  const d = q.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="gl-acct">บัญชี</Label>
          <select id="gl-acct" className={`${selectCls} min-w-[260px]`} value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">— เลือกบัญชี —</option>
            {accountsQ.data?.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
        </div>
        <div className="grid gap-1.5"><Label htmlFor="gl-from">ตั้งแต่</Label><Input id="gl-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="grid gap-1.5"><Label htmlFor="gl-to">ถึง</Label><Input id="gl-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      {!account ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">เลือกบัญชีเพื่อดูรายการเคลื่อนไหวและยอดคงเหลือสะสม</Card>
      ) : (
        <StateView q={q}>
          {d && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard label="ยอดยกมา" value={baht(d.opening_balance)} />
                <StatCard label="เดบิตรวม" value={baht(d.total_debit)} tone="primary" />
                <StatCard label="เครดิตรวม" value={baht(d.total_credit)} tone="primary" />
                <StatCard label="ยอดคงเหลือ" value={baht(d.closing_balance)} tone="success" />
              </div>
              <Card className="gap-2 p-5">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="pb-2 font-medium">วันที่</th>
                        <th className="pb-2 font-medium">เลขที่</th>
                        <th className="pb-2 font-medium">แหล่ง</th>
                        <th className="pb-2 font-medium">คำอธิบาย</th>
                        <th className="pb-2 text-right font-medium">เดบิต</th>
                        <th className="pb-2 text-right font-medium">เครดิต</th>
                        <th className="pb-2 text-right font-medium">คงเหลือ</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t text-muted-foreground"><td className="py-1.5" colSpan={6}>ยอดยกมา (opening)</td><td className="py-1.5 text-right tabular">{baht(d.opening_balance)}</td></tr>
                      {d.lines.map((l: any, i: number) => (
                        <tr key={i} className="border-t">
                          <td className="py-1.5 tabular">{thaiDate(l.date)}</td>
                          <td className="py-1.5 tabular">{l.entry_no}</td>
                          <td className="py-1.5">{l.source}{l.source_ref ? ` · ${l.source_ref}` : ''}</td>
                          <td className="py-1.5">{l.memo || <span className="text-muted-foreground">—</span>}</td>
                          <td className="py-1.5 text-right tabular">{l.debit ? baht(l.debit) : ''}</td>
                          <td className="py-1.5 text-right tabular">{l.credit ? baht(l.credit) : ''}</td>
                          <td className="py-1.5 text-right tabular font-medium">{baht(l.balance)}</td>
                        </tr>
                      ))}
                      {d.lines.length === 0 && <tr className="border-t"><td colSpan={7} className="py-4 text-center text-muted-foreground">ไม่มีรายการในช่วงนี้</td></tr>}
                      <tr className="border-t-2 font-semibold"><td className="py-1.5" colSpan={4}>ยอดคงเหลือปลายงวด (closing)</td><td className="py-1.5 text-right tabular">{baht(d.total_debit)}</td><td className="py-1.5 text-right tabular">{baht(d.total_credit)}</td><td className="py-1.5 text-right tabular">{baht(d.closing_balance)}</td></tr>
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          )}
        </StateView>
      )}
    </div>
  );
}

// ───────────────────── กระทบยอดบัญชีย่อย (Subledger tie-out, GL-14) ─────────────────────
// Run reconciles a control account's GL balance vs its sub-ledger detail (AR/AP/INV/FA); certify is
// maker-checker (certifier ≠ runner). Backend: GET/POST /api/ledger/tie-out{,/run,/:id/certify}.
function SubledgerTieout() {
  const me = useMe();
  const canRun = hasPerm(me.data, 'gl_close', 'gl_post', 'exec');
  const canCertify = hasPerm(me.data, 'gl_close', 'exec');
  const qc = useQueryClient();
  const [subledger, setSubledger] = useState<'AR' | 'AP' | 'INV' | 'FA'>('AR');
  const q = useQuery<any>({ queryKey: ['tieout'], queryFn: () => api('/api/ledger/tie-out') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['tieout'] });
  const run = useMutation({ mutationFn: () => api('/api/ledger/tie-out/run', { method: 'POST', body: JSON.stringify({ subledger }) }), onSuccess: () => { notifySuccess(`กระทบยอด ${subledger} แล้ว`); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const certify = useMutation({ mutationFn: (id: number) => { const note = prompt('หมายเหตุการรับรอง (ถ้ามี)') ?? undefined; return api(`/api/ledger/tie-out/${id}/certify`, { method: 'POST', body: JSON.stringify({ note }) }); }, onSuccess: () => { notifySuccess('รับรองการกระทบยอดแล้ว'); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const runs: any[] = q.data?.runs ?? [];
  const SUB_TH: Record<string, string> = { AR: 'ลูกหนี้ (AR)', AP: 'เจ้าหนี้ (AP)', INV: 'สินค้าคงคลัง (INV)', FA: 'สินทรัพย์ถาวร (FA)' };
  return (
    <div className="space-y-5">
      <Card className="flex-row flex-wrap items-center gap-2 p-4 text-sm">
        <ShieldCheck className="size-4 text-muted-foreground" />
        กระทบยอดบัญชีคุม (control) กับบัญชีย่อย (GL-14) — ผู้รับรองต้องไม่ใช่ผู้จัดทำ (แบ่งแยกหน้าที่).
      </Card>
      {canRun && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="tie-sub">ระบบบัญชีย่อย</Label>
            <select id="tie-sub" className={`${selectCls} min-w-[200px]`} value={subledger} onChange={(e) => setSubledger(e.target.value as 'AR' | 'AP' | 'INV' | 'FA')}>
              {(['AR', 'AP', 'INV', 'FA'] as const).map((s) => <option key={s} value={s}>{SUB_TH[s]}</option>)}
            </select>
          </div>
          <Button disabled={run.isPending} onClick={() => run.mutate()}><Scale className="size-4" /> {run.isPending ? 'กำลังกระทบยอด…' : 'กระทบยอด'}</Button>
        </div>
      )}
      <StateView q={q}>
        {runs.length === 0 ? (
          <Card className="gap-0 p-5"><span className="text-sm text-muted-foreground">ยังไม่มีการกระทบยอด</span></Card>
        ) : (
          <DataTable
            rows={runs}
            rowKey={(r: any) => r.id}
            columns={[
              { key: 'subledger', label: 'บัญชีย่อย', render: (r: any) => SUB_TH[r.subledger] ?? r.subledger },
              { key: 'control_account', label: 'บัญชีคุม' },
              { key: 'as_of_date', label: 'ณ วันที่', render: (r: any) => thaiDate(r.as_of_date) },
              { key: 'glBalance', label: 'ยอด GL', align: 'right', render: (r: any) => <span className="tabular">{baht(r.glBalance)}</span> },
              { key: 'subledgerBalance', label: 'ยอดบัญชีย่อย', align: 'right', render: (r: any) => <span className="tabular">{baht(r.subledgerBalance)}</span> },
              { key: 'variance', label: 'ผลต่าง', align: 'right', render: (r: any) => <span className={`tabular ${Math.abs(r.variance) >= 0.01 ? 'text-destructive' : ''}`}>{baht(r.variance)}</span> },
              { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              { key: 'run_by', label: 'จัดทำโดย' },
              { key: 'certified_by', label: 'รับรองโดย', render: (r: any) => r.certified_by || <span className="text-muted-foreground">—</span> },
              { key: 'act', label: '', sortable: false, render: (r: any) => (canCertify && r.status !== 'Certified' && r.run_by !== me.data?.username) ? <Button size="sm" variant="outline" disabled={certify.isPending} onClick={() => certify.mutate(r.id)}><Check className="size-4" /> รับรอง</Button> : null },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
