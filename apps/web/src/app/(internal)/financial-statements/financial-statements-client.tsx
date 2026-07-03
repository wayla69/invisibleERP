'use client';

// งบการเงิน (Financial Statements) — the three primary statements rendered in full, statement-formatted
// detail (account-level line items + subtotals), not just the summary KPIs shown on the /accounting tabs.
// All figures come straight from the posted GL via the existing endpoints:
//   • งบดุล            → GET /api/ledger/balance-sheet?as_of=&ledger=        (now returns per-account `lines`)
//   • งบกำไรขาดทุน     → GET /api/ledger/income-statement?from=&to=&ledger=  (+ /by-branch)
//   • งบกระแสเงินสด    → GET /api/ledger/cash-flow{,-direct,-forecast}
// Read-only; multi-GAAP ledger selectable (TFRS / TAX / IFRS). CSV export per statement.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ShieldCheck } from 'lucide-react';

import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';
const yearStart = () => today().slice(0, 4) + '-01-01';

const selectCls =
  'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

function downloadCsv(name: string, rows: (string | number)[][]) {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const blob = new Blob(['﻿' + rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function FinancialStatementsClient() {
  const [ledger, setLedger] = useState('');
  const ledgersQ = useQuery<any>({ queryKey: ['ledgers'], queryFn: () => api('/api/ledger/ledgers') });
  const ledgers: any[] = ledgersQ.data?.ledgers ?? [];
  const lp = ledger ? `&ledger=${encodeURIComponent(ledger)}` : '';

  const tabs = [
    { key: 'bs', label: 'งบดุล', content: <BalanceSheet lp={lp} /> },
    { key: 'pl', label: 'งบกำไรขาดทุน', content: <IncomeStatement lp={lp} ledger={ledger} /> },
    { key: 'cf', label: 'งบกระแสเงินสด', content: <CashFlow lp={lp} /> },
  ];

  return (
    <div>
      <PageHeader
        title="งบการเงิน"
        description="งบดุล · งบกำไรขาดทุน · งบกระแสเงินสด — สร้างจากบัญชีแยกประเภทที่โพสต์แล้ว (TFRS)"
        actions={
          ledgers.length > 1 ? (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">บัญชีมาตรฐาน</span>
              <select className={selectCls} value={ledger} onChange={(e) => setLedger(e.target.value)}>
                {ledgers.map((l) => (
                  <option key={l.code} value={l.is_leading ? '' : l.code}>
                    {l.code}
                    {l.gaap ? ` · ${l.gaap}` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : undefined
        }
      />
      <Tabs tabs={tabs} urlParam="tab" />
    </div>
  );
}

// ───────────────────────── งบดุล (Balance Sheet) ─────────────────────────
function BalanceSheet({ lp }: { lp: string }) {
  const [asOf, setAsOf] = useState(today());
  const q = useQuery<any>({ queryKey: ['bs', asOf, lp], queryFn: () => api(`/api/ledger/balance-sheet?as_of=${asOf}${lp}`) });
  const d = q.data;

  const sections = useMemo(() => {
    const lines: any[] = d?.lines ?? [];
    const pick = (t: string) => lines.filter((l) => l.account_type === t).sort((a, b) => String(a.account_code).localeCompare(String(b.account_code)));
    return { assets: pick('Asset'), liabilities: pick('Liability'), equity: pick('Equity') };
  }, [d]);

  const Section = ({ title, rows, subtotal, extra }: { title: string; rows: any[]; subtotal: number; extra?: { label: string; amount: number } }) => (
    <Card className="gap-2 p-5">
      <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((l) => (
            <tr key={l.account_code}>
              <td className="py-0.5 pr-3 text-muted-foreground tabular">{l.account_code}</td>
              <td className="py-0.5 pr-3">{l.account_name ?? l.account_code}</td>
              <td className="py-0.5 text-right tabular">{baht(l.balance)}</td>
            </tr>
          ))}
          {extra && (
            <tr>
              <td className="py-0.5 pr-3" />
              <td className="py-0.5 pr-3 italic text-muted-foreground">{extra.label}</td>
              <td className="py-0.5 text-right tabular">{baht(extra.amount)}</td>
            </tr>
          )}
          {rows.length === 0 && !extra && (
            <tr>
              <td colSpan={3} className="py-2 text-center text-muted-foreground">ไม่มีรายการ</td>
            </tr>
          )}
          <tr className="border-t font-semibold">
            <td className="py-1" />
            <td className="py-1">รวม{title}</td>
            <td className="py-1 text-right tabular">{baht(subtotal)}</td>
          </tr>
        </tbody>
      </table>
    </Card>
  );

  const exportCsv = () => {
    if (!d) return;
    const rows: (string | number)[][] = [['section', 'code', 'account', 'amount']];
    sections.assets.forEach((l) => rows.push(['Asset', l.account_code, l.account_name, l.balance]));
    sections.liabilities.forEach((l) => rows.push(['Liability', l.account_code, l.account_name, l.balance]));
    sections.equity.forEach((l) => rows.push(['Equity', l.account_code, l.account_name, l.balance]));
    rows.push(['Equity', '', 'กำไร(ขาดทุน)งวดปัจจุบัน', d.net_income]);
    downloadCsv(`balance-sheet-${asOf}.csv`, rows);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid max-w-[200px] gap-1.5">
          <Label htmlFor="bs-asof">ณ วันที่</Label>
          <Input id="bs-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={!d}>
          <Download className="size-4" /> ส่งออก CSV
        </Button>
      </div>
      <StateView q={q}>
        {d && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="สินทรัพย์รวม" value={baht(d.assets)} tone="primary" />
              <StatCard label="หนี้สินรวม" value={baht(d.liabilities)} tone="danger" />
              <StatCard label="ส่วนของเจ้าของรวม" value={baht(d.equity + d.net_income)} />
              <StatCard
                label="สถานะ"
                value={<Badge variant={d.balanced ? 'success' : 'destructive'}>{d.balanced ? 'สมดุล' : 'ไม่สมดุล'}</Badge>}
              />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Section title="สินทรัพย์" rows={sections.assets} subtotal={d.assets} />
              <div className="space-y-4">
                <Section title="หนี้สิน" rows={sections.liabilities} subtotal={d.liabilities} />
                <Section
                  title="ส่วนของเจ้าของ"
                  rows={sections.equity}
                  extra={{ label: 'กำไร(ขาดทุน)งวดปัจจุบัน', amount: d.net_income }}
                  subtotal={d.equity + d.net_income}
                />
              </div>
            </div>
            <Card className="flex-row flex-wrap items-center gap-2 p-5 text-sm">
              <ShieldCheck className="size-4 text-muted-foreground" />
              สินทรัพย์ <span className="tabular">{baht(d.assets)}</span> = หนี้สิน+ทุน{' '}
              <span className="tabular">{baht(d.liabilities_plus_equity)}</span>{' '}
              <Badge variant={d.balanced ? 'success' : 'destructive'}>{d.balanced ? 'สมดุล' : 'ไม่สมดุล'}</Badge>
            </Card>
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── งบกำไรขาดทุน (Income Statement) ─────────────────────────
function IncomeStatement({ lp, ledger }: { lp: string; ledger: string }) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [byBranch, setByBranch] = useState(false);

  const q = useQuery<any>({ queryKey: ['pl', from, to, lp], queryFn: () => api(`/api/ledger/income-statement?from=${from}&to=${to}${lp}`), enabled: !byBranch });
  const branchQ = useQuery<any>({ queryKey: ['pl-branch', from, to], queryFn: () => api(`/api/ledger/income-statement/by-branch?from=${from}&to=${to}`), enabled: byBranch });
  const d = q.data;

  const rev = useMemo(() => (d?.lines ?? []).filter((l: any) => l.account_type === 'Revenue').map((l: any) => ({ ...l, amount: (l.credit ?? 0) - (l.debit ?? 0) })), [d]);
  const exp = useMemo(() => (d?.lines ?? []).filter((l: any) => l.account_type === 'Expense').map((l: any) => ({ ...l, amount: (l.debit ?? 0) - (l.credit ?? 0) })), [d]);

  const exportCsv = () => {
    if (!d) return;
    const rows: (string | number)[][] = [['section', 'code', 'account', 'amount']];
    rev.forEach((l: any) => rows.push(['Revenue', l.account_code, l.account_name, l.amount]));
    exp.forEach((l: any) => rows.push(['Expense', l.account_code, l.account_name, l.amount]));
    rows.push(['', '', 'กำไรสุทธิ', d.net_income]);
    downloadCsv(`income-statement-${from}_${to}.csv`, rows);
  };

  const LineTable = ({ title, rows, subtotal, tone }: { title: string; rows: any[]; subtotal: number; tone?: string }) => (
    <Card className="gap-2 p-5">
      <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((l) => (
            <tr key={l.account_code}>
              <td className="py-0.5 pr-3 text-muted-foreground tabular">{l.account_code}</td>
              <td className="py-0.5 pr-3">{l.account_name ?? l.account_code}</td>
              <td className="py-0.5 text-right tabular">{baht(l.amount)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="py-2 text-center text-muted-foreground">ไม่มีรายการ</td>
            </tr>
          )}
          <tr className={`border-t font-semibold ${tone ?? ''}`}>
            <td className="py-1" />
            <td className="py-1">รวม{title}</td>
            <td className="py-1 text-right tabular">{baht(subtotal)}</td>
          </tr>
        </tbody>
      </table>
    </Card>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="pl-from">ตั้งแต่</Label>
            <Input id="pl-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pl-to">ถึง</Label>
            <Input id="pl-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button variant="ghost" size="sm" onClick={() => setFrom(yearStart())}>ตั้งแต่ต้นปี</Button>
        </div>
        <div className="flex items-center gap-2">
          <Button variant={byBranch ? 'default' : 'outline'} size="sm" onClick={() => setByBranch((v) => !v)} disabled={!!ledger && byBranch}>
            แยกตามสาขา
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={byBranch || !d}>
            <Download className="size-4" /> ส่งออก CSV
          </Button>
        </div>
      </div>

      {byBranch ? (
        <StateView q={branchQ}>
          {branchQ.data && (
            <div className="grid gap-3">
              {Object.entries(branchQ.data.branches ?? {}).length === 0 && (
                <Card className="p-6 text-center text-sm text-muted-foreground">ยังไม่มีรายการรายได้/ค่าใช้จ่ายในช่วงนี้</Card>
              )}
              {Object.entries(branchQ.data.branches ?? {}).map(([key, b]: [string, any]) => (
                <Card key={key} className="gap-2 p-5">
                  <div className="flex items-center justify-between">
                    <strong>{key === 'unassigned' ? 'ไม่ระบุสาขา' : `สาขา #${key}`}</strong>
                    <Badge variant={b.net >= 0 ? 'success' : 'destructive'}>กำไรสุทธิ {baht(b.net)}</Badge>
                  </div>
                  <div className="flex gap-6 text-sm text-muted-foreground">
                    <span>รายได้ <span className="tabular text-foreground">{baht(b.revenue)}</span></span>
                    <span>ค่าใช้จ่าย <span className="tabular text-foreground">{baht(b.expense)}</span></span>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </StateView>
      ) : (
        <StateView q={q}>
          {d && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <StatCard label="รายได้รวม" value={baht(d.revenue)} tone="primary" />
                <StatCard label="ค่าใช้จ่ายรวม" value={baht(d.expense)} tone="danger" />
                <StatCard label="กำไรสุทธิ" value={baht(d.net_income)} tone={d.net_income >= 0 ? 'success' : 'danger'} />
              </div>
              <LineTable title="รายได้" rows={rev} subtotal={d.revenue} />
              <LineTable title="ค่าใช้จ่าย" rows={exp} subtotal={d.expense} />
              <Card className="flex-row items-center justify-between p-5">
                <span className="font-semibold">กำไร(ขาดทุน)สุทธิ</span>
                <span className={`text-lg font-semibold tabular ${d.net_income >= 0 ? 'text-success' : 'text-destructive'}`}>{baht(d.net_income)}</span>
              </Card>
            </div>
          )}
        </StateView>
      )}
    </div>
  );
}

// ───────────────────────── งบกระแสเงินสด (Statement of Cash Flows) ─────────────────────────
function CashFlow({ lp }: { lp: string }) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [method, setMethod] = useState<'indirect' | 'direct' | 'forecast'>('indirect');

  const q = useQuery<any>({
    queryKey: ['cf', method, from, to, lp],
    queryFn: () =>
      method === 'forecast'
        ? api(`/api/ledger/cash-flow-forecast?weeks=8${lp}`)
        : api(`/api/ledger/cash-flow${method === 'direct' ? '-direct' : ''}?from=${from}&to=${to}${lp}`),
  });
  const d = q.data;

  const flowRow = (label: string, amount: number, key: string | number) => (
    <tr key={key}>
      <td className="py-0.5 pr-3">{label}</td>
      <td className={`py-0.5 text-right tabular ${amount < 0 ? 'text-destructive' : ''}`}>{baht(amount)}</td>
    </tr>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1">
          {(['indirect', 'direct', 'forecast'] as const).map((m) => (
            <Button key={m} size="sm" variant={method === m ? 'default' : 'outline'} onClick={() => setMethod(m)}>
              {m === 'indirect' ? 'ทางอ้อม' : m === 'direct' ? 'ทางตรง' : 'พยากรณ์'}
            </Button>
          ))}
        </div>
        {method !== 'forecast' && (
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
        )}
      </div>

      <StateView q={q}>
        {d && method === 'indirect' && (
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
                  {flowRow('กำไรสุทธิ (Net income)', d.operating?.net_income ?? 0, 'ni')}
                  {(d.operating?.adjustments ?? []).map((a: any, i: number) => flowRow(`+ ${a.label ?? a.account_name}`, a.amount, `adj${i}`))}
                  {(d.operating?.working_capital ?? []).map((a: any, i: number) => flowRow(`Δ ${a.label ?? a.account_name}`, a.amount, `wc${i}`))}
                  <tr className="border-t font-medium"><td className="py-1">เงินสดสุทธิจากการดำเนินงาน</td><td className="py-1 text-right tabular">{baht(d.operating?.net)}</td></tr>
                  {(d.investing?.lines ?? []).length > 0 && <tr className="text-muted-foreground"><td className="pt-3 pb-1 font-medium">กิจกรรมลงทุน (Investing)</td><td /></tr>}
                  {(d.investing?.lines ?? []).map((a: any, i: number) => flowRow(a.label ?? a.account_name, a.amount, `inv${i}`))}
                  {(d.financing?.lines ?? []).length > 0 && <tr className="text-muted-foreground"><td className="pt-3 pb-1 font-medium">กิจกรรมจัดหาเงิน (Financing)</td><td /></tr>}
                  {(d.financing?.lines ?? []).map((a: any, i: number) => flowRow(a.label ?? a.account_name, a.amount, `fin${i}`))}
                  <tr className="border-t font-semibold"><td className="py-1.5">เงินสดเปลี่ยนแปลงสุทธิ</td><td className="py-1.5 text-right tabular">{baht(d.net_change_in_cash)}</td></tr>
                  <tr><td className="py-0.5 pr-3 text-muted-foreground">เงินสดต้นงวด</td><td className="py-0.5 text-right tabular">{baht(d.cash_beginning)}</td></tr>
                  <tr><td className="py-0.5 pr-3 text-muted-foreground">เงินสดปลายงวด</td><td className="py-0.5 text-right tabular">{baht(d.cash_ending)}</td></tr>
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

        {d && method === 'direct' && (
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
                  {flowRow('รับจากลูกค้า', d.operating?.receipts_from_customers ?? 0, 'r')}
                  {flowRow('จ่ายผู้ขาย/ซัพพลายเออร์', d.operating?.payments_to_suppliers ?? 0, 'p')}
                  {flowRow('ภาษี & เงินเดือน', d.operating?.tax_and_payroll ?? 0, 't')}
                  {flowRow('ดำเนินงานอื่นๆ', d.operating?.other_operating ?? 0, 'o')}
                  <tr className="border-t font-medium"><td className="py-1">เงินสดสุทธิจากการดำเนินงาน</td><td className="py-1 text-right tabular">{baht(d.operating?.net)}</td></tr>
                  {flowRow('กิจกรรมลงทุน (Investing)', d.investing?.net ?? 0, 'i')}
                  {flowRow('กิจกรรมจัดหาเงิน (Financing)', d.financing?.net ?? 0, 'f')}
                  <tr className="border-t font-semibold"><td className="py-1.5">เงินสดเปลี่ยนแปลงสุทธิ</td><td className="py-1.5 text-right tabular">{baht(d.net_change_in_cash)}</td></tr>
                  <tr><td className="py-0.5 pr-3 text-muted-foreground">เงินสดต้นงวด</td><td className="py-0.5 text-right tabular">{baht(d.cash_beginning)}</td></tr>
                  <tr><td className="py-0.5 pr-3 text-muted-foreground">เงินสดปลายงวด</td><td className="py-0.5 text-right tabular">{baht(d.cash_ending)}</td></tr>
                </tbody>
              </table>
            </Card>
            <Card className="flex-row flex-wrap items-center gap-2 p-5 text-sm">
              <ShieldCheck className="size-4 text-muted-foreground" />
              งบกระแสเงินสด (วิธีทางตรง) — จำแนกตามลักษณะการรับ/จ่ายเงินสด{' '}
              <Badge variant={d.reconciled ? 'success' : 'destructive'}>{d.reconciled ? 'กระทบยอดเงินสดตรง' : 'ไม่ตรง'}</Badge>
            </Card>
          </div>
        )}

        {d && method === 'forecast' && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="เงินสดปัจจุบัน" value={baht(d.opening_cash)} tone="primary" />
              <StatCard label="คาดว่าจะรับ" value={baht(d.total_expected_inflow)} tone="success" />
              <StatCard label="คาดว่าจะจ่าย" value={baht(d.total_expected_outflow)} tone="danger" />
              <StatCard label="เงินสดปลายงวดคาดการณ์" value={baht(d.projected_closing_cash)} tone={d.projected_closing_cash >= 0 ? 'success' : 'danger'} />
            </div>
            <Card className="gap-2 p-5">
              <h3 className="text-sm font-semibold text-muted-foreground">พยากรณ์กระแสเงินสด 8 สัปดาห์ (จาก AR/AP ที่ครบกำหนด)</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="pb-2 font-medium">สัปดาห์</th>
                    <th className="pb-2 text-right font-medium">รับ</th>
                    <th className="pb-2 text-right font-medium">จ่าย</th>
                    <th className="pb-2 text-right font-medium">สุทธิ</th>
                    <th className="pb-2 text-right font-medium">ยอดคงเหลือคาดการณ์</th>
                  </tr>
                </thead>
                <tbody>
                  {(d.periods ?? []).map((p: any) => (
                    <tr key={p.week} className="border-t">
                      <td className="py-1">{p.week === 0 ? 'ครบกำหนด/เกินกำหนด' : `สัปดาห์ +${p.week}`}</td>
                      <td className="py-1 text-right tabular">{p.inflow ? baht(p.inflow) : '—'}</td>
                      <td className="py-1 text-right tabular">{p.outflow ? baht(p.outflow) : '—'}</td>
                      <td className={`py-1 text-right tabular ${p.net < 0 ? 'text-destructive' : ''}`}>{baht(p.net)}</td>
                      <td className={`py-1 text-right tabular font-medium ${p.projected_balance < 0 ? 'text-destructive' : ''}`}>{baht(p.projected_balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}
      </StateView>
    </div>
  );
}
