'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Goal, Scale, TrendingUp, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// ── API contract (apps/api/src/modules/budget — mounted at /api/ledger) ────────
interface BudgetRow { fiscal_year: number; account_code: string; cost_center_code: string | null; period: string; amount: number; status?: string; requested_by?: string | null }
interface BvaRow { account_code: string; account_name: string | null; account_type: string | null; budget: number; actual: number; variance: number; variance_pct: number | null; favorable: boolean; status: string }
interface BvaResp {
  fiscal_year: number; period: string | null; cost_center: string | null; rows: BvaRow[];
  rollup: { revenue: Roll; expense: Roll; net: Roll };
}
interface Roll { budget: number; actual: number; variance: number; favorable: boolean }

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';
const thisYear = new Date().getFullYear();

export default function BudgetPage() {
  return (
    <div>
      <PageHeader
        title="งบประมาณเทียบจริง (Budget vs Actual)"
        description="ตั้งงบประมาณรายบัญชี/ศูนย์ต้นทุน แล้วเทียบกับยอดจริงจากบัญชีแยกประเภท (เฉพาะรายการที่ลงบัญชีแล้ว) พร้อมวิเคราะห์ผลต่างเชิงบวก/ลบ"
      />
      <Tabs
        tabs={[
          { key: 'bva', label: 'งบเทียบจริง', content: <BvaTab /> },
          { key: 'set', label: 'ตั้งงบประมาณ', content: <SetBudgetTab /> },
        ]}
      />
    </div>
  );
}

function BvaTab() {
  const [fy, setFy] = useState(String(thisYear));
  const [period, setPeriod] = useState('');
  const [query, setQuery] = useState<{ fy: string; period: string } | null>({ fy: String(thisYear), period: '' });

  const q = useQuery<BvaResp>({
    queryKey: ['bva', query?.fy, query?.period],
    queryFn: () => api(`/api/ledger/budget-vs-actual?fiscal_year=${query!.fy}${query!.period ? `&period=${query!.period}` : ''}`),
    enabled: !!query,
  });

  const tone = (favorable: boolean, variance: number) => (variance === 0 ? 'secondary' : favorable ? 'success' : 'destructive');

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader><CardTitle className="text-base">เลือกงวด</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="bva-fy">ปีงบประมาณ</Label>
              <Input id="bva-fy" type="number" value={fy} onChange={(e) => setFy(e.target.value)} className="max-w-[120px]" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bva-period">งวด (YYYY-MM, ว่าง = ทั้งปี)</Label>
              <Input id="bva-period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-06" className="max-w-[160px]" />
            </div>
            <Button onClick={() => setQuery({ fy, period: /^\d{4}-\d{2}$/.test(period) ? period : '' })}>
              <Search className="size-4" /> ดูรายงาน
            </Button>
          </div>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                label="รายได้ (จริง/งบ)"
                value={baht(q.data.rollup.revenue.actual)}
                icon={TrendingUp}
                tone={q.data.rollup.revenue.favorable ? 'success' : 'warning'}
                hint={`งบ ${baht(q.data.rollup.revenue.budget)} · ผลต่าง ${baht(q.data.rollup.revenue.variance)}`}
              />
              <StatCard
                label="ค่าใช้จ่าย (จริง/งบ)"
                value={baht(q.data.rollup.expense.actual)}
                tone={q.data.rollup.expense.favorable ? 'success' : 'danger'}
                hint={`งบ ${baht(q.data.rollup.expense.budget)} · ผลต่าง ${baht(q.data.rollup.expense.variance)}`}
              />
              <StatCard
                label="สุทธิ (จริง/งบ)"
                value={baht(q.data.rollup.net.actual)}
                icon={Scale}
                tone={q.data.rollup.net.favorable ? 'success' : 'danger'}
                hint={`งบ ${baht(q.data.rollup.net.budget)} · ผลต่าง ${baht(q.data.rollup.net.variance)}`}
              />
            </div>

            <DataTable
              rows={q.data.rows}
              rowKey={(r) => r.account_code}
              emptyState={{ icon: Goal, title: 'ไม่มีข้อมูลงบ/ยอดจริงในงวดนี้', description: 'ตั้งงบประมาณในแท็บ "ตั้งงบประมาณ" หรือเลือกงวดที่มีการลงบัญชีแล้ว' }}
              columns={[
                { key: 'account_code', label: 'รหัสบัญชี', render: (r) => <span className="font-medium">{r.account_code}</span> },
                { key: 'account_name', label: 'ชื่อบัญชี', render: (r) => r.account_name ?? '—' },
                { key: 'account_type', label: 'ประเภท', render: (r) => (r.account_type ? <Badge variant="info">{r.account_type}</Badge> : '—') },
                { key: 'budget', label: 'งบประมาณ', align: 'right', render: (r) => <span className="tabular">{baht(r.budget)}</span> },
                { key: 'actual', label: 'จริง', align: 'right', render: (r) => <span className="tabular">{baht(r.actual)}</span> },
                { key: 'variance', label: 'ผลต่าง', align: 'right', render: (r) => <span className="tabular">{baht(r.variance)}</span> },
                { key: 'variance_pct', label: '%', align: 'right', render: (r) => <span className="tabular">{r.variance_pct == null ? '—' : `${r.variance_pct}%`}</span> },
                { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={tone(r.favorable, r.variance)}>{r.status}</Badge> },
              ]}
            />
          </>
        )}
      </StateView>
    </div>
  );
}

function SetBudgetTab() {
  const qc = useQueryClient();
  const [fy, setFy] = useState(String(thisYear));
  const listQ = useQuery<{ budgets: BudgetRow[]; count: number; total: number }>({
    queryKey: ['budgets', fy],
    queryFn: () => api(`/api/ledger/budgets?fiscal_year=${fy}`),
  });

  const [accountCode, setAccountCode] = useState('');
  const [costCenter, setCostCenter] = useState('');
  const [mode, setMode] = useState('annual');
  const [period, setPeriod] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');

  const upsert = useMutation({
    mutationFn: () =>
      api('/api/ledger/budgets', {
        method: 'POST',
        body: JSON.stringify({
          fiscal_year: Number(fy),
          account_code: accountCode,
          cost_center_code: costCenter || undefined,
          mode,
          period: mode === 'monthly' ? period : undefined,
          amount: Number(amount) || 0,
          notes: notes || undefined,
        }),
      }),
    onSuccess: (r: any) => {
      notifySuccess(`ส่งคำขอตั้งงบประมาณบัญชี ${r.account_code}`, `${num(r.lines)} งวด · รวม ${baht(r.total)} — รออนุมัติจากผู้มีสิทธิ์ (คนละคนกับผู้ขอ)`);
      setAccountCode(''); setAmount(''); setNotes('');
      qc.invalidateQueries({ queryKey: ['budgets', fy] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  // BUD-01 maker-checker: approve/reject a pending budget (whole account/cost-centre group) — different user.
  const decide = useMutation({
    mutationFn: ({ r, action }: { r: BudgetRow; action: 'approve' | 'reject' }) =>
      api(`/api/ledger/budgets/${action}`, { method: 'POST', body: JSON.stringify({ fiscal_year: r.fiscal_year, account_code: r.account_code, cost_center_code: r.cost_center_code ?? undefined }) }),
    onSuccess: (_r, v) => { notifySuccess(v.action === 'approve' ? 'อนุมัติงบประมาณแล้ว' : 'ปฏิเสธงบประมาณแล้ว'); qc.invalidateQueries({ queryKey: ['budgets', fy] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const rows = listQ.data?.budgets ?? [];

  return (
    <div className="space-y-5">
      <Card className="max-w-4xl gap-4">
        <CardHeader><CardTitle className="text-base">ตั้ง/แก้ไขงบประมาณ</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="bg-fy">ปีงบประมาณ</Label>
              <Input id="bg-fy" type="number" value={fy} onChange={(e) => setFy(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bg-acc">รหัสบัญชี</Label>
              <Input id="bg-acc" value={accountCode} onChange={(e) => setAccountCode(e.target.value)} placeholder="เช่น 5100" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bg-cc">ศูนย์ต้นทุน (ถ้ามี)</Label>
              <Input id="bg-cc" value={costCenter} onChange={(e) => setCostCenter(e.target.value)} placeholder="เช่น CC-01" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bg-mode">รูปแบบ</Label>
              <select id="bg-mode" className={selectCls} value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="annual">ทั้งปี (เฉลี่ย 12 งวด)</option>
                <option value="monthly">รายเดือน (งวดเดียว)</option>
              </select>
            </div>
            {mode === 'monthly' && (
              <div className="grid gap-2">
                <Label htmlFor="bg-period">งวด (YYYY-MM)</Label>
                <Input id="bg-period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-06" />
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="bg-amt">จำนวนเงิน (฿)</Label>
              <Input id="bg-amt" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="bg-notes">หมายเหตุ</Label>
              <Input id="bg-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="คำอธิบาย" />
            </div>
          </div>
          <Button
            disabled={upsert.isPending || !accountCode.trim() || !amount || (mode === 'monthly' && !/^\d{4}-\d{2}$/.test(period))}
            onClick={() => upsert.mutate()}
          >
            <Plus className="size-4" /> {upsert.isPending ? 'กำลังบันทึก…' : 'บันทึกงบประมาณ'}
          </Button>
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">งบประมาณปี {fy} {listQ.data && `· รวม ${baht(listQ.data.total)}`}</h3>
        <StateView q={listQ}>
          {listQ.data && (
            <DataTable
              rows={rows}
              rowKey={(r, i) => `${r.account_code}-${r.period}-${i}`}
              emptyState={{ icon: Goal, title: 'ยังไม่มีงบประมาณในปีนี้', description: 'เพิ่มงบประมาณรายบัญชีจากแบบฟอร์มด้านบน' }}
              columns={[
                { key: 'account_code', label: 'รหัสบัญชี', render: (r) => <span className="font-medium">{r.account_code}</span> },
                { key: 'cost_center_code', label: 'ศูนย์ต้นทุน', render: (r) => r.cost_center_code ?? '—' },
                { key: 'period', label: 'งวด' },
                { key: 'amount', label: 'จำนวนเงิน', align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={r.status === 'Approved' ? 'success' : r.status === 'PendingApproval' ? 'warning' : r.status === 'Rejected' ? 'destructive' : 'secondary'}>{r.status === 'Approved' ? 'อนุมัติแล้ว' : r.status === 'PendingApproval' ? 'รออนุมัติ' : r.status === 'Rejected' ? 'ปฏิเสธ' : (r.status ?? '—')}</Badge> },
                { key: 'act', label: '', align: 'right', render: (r) => r.status === 'PendingApproval' ? (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ r, action: 'approve' })}>อนุมัติ</Button>
                    <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ r, action: 'reject' })}>ปฏิเสธ</Button>
                  </div>
                ) : null },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}
