'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Save, Scale, ShieldCheck, X } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
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

export default function AccountingPage() {
  return (
    <div>
      <PageHeader
        title="บัญชีแยกประเภท"
        description="บัญชีคู่ (double-entry) — ทุกการขายลงบัญชีอัตโนมัติ เดบิตต้องเท่าเครดิตเสมอ"
      />
      <Tabs
        tabs={[
          { key: 'tb', label: 'งบทดลอง', content: <TrialBalance /> },
          { key: 'journal', label: 'สมุดรายวัน', content: <Journal /> },
          { key: 'approve', label: 'รออนุมัติ (JE)', content: <PendingJournal /> },
          { key: 'pl', label: 'งบกำไรขาดทุน', content: <IncomeStatement /> },
          { key: 'bs', label: 'งบดุล', content: <BalanceSheet /> },
          { key: 'cf', label: 'งบกระแสเงินสด', content: <CashFlow /> },
          { key: 'opening', label: 'ยอดยกมา', content: <OpeningBalances /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── งบทดลอง ─────────────────────────
function TrialBalance() {
  const q = useQuery<any>({ queryKey: ['tb'], queryFn: () => api('/api/ledger/trial-balance') });
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

function OpeningBalances() {
  const qc = useQueryClient();
  const accounts = useQuery<{ accounts: Account[] }>({ queryKey: ['accounts'], queryFn: () => api('/api/ledger/accounts') });

  const [batchRef, setBatchRef] = useState('');
  const [lines, setLines] = useState<ObLine[]>([emptyObLine(), emptyObLine()]);
  const [errs, setErrs] = useState<{ row: number; error: string }[]>([]);

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
        <div className="grid max-w-sm gap-1.5">
          <Label htmlFor="ob-batch">อ้างอิงชุด (batch ref)</Label>
          <Input id="ob-batch" placeholder="เช่น OB-2026 (กันลงซ้ำ)" value={batchRef} onChange={(e) => setBatchRef(e.target.value)} />
        </div>
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
