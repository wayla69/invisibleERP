'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleDollarSign, Coins, PlayCircle, ScrollText, FileSignature, Plus, Trash2, Layers } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';
import { Select } from '@/components/form-controls';

const currentPeriod = () => new Date().toISOString().slice(0, 7); // YYYY-MM

interface Schedule {
  schedule_no: string;
  source_ref: string | null;
  total_amount: number;
  start_period: string;
  end_period: string;
  months: number;
  status: string;
  recognized_amount: number;
  remaining_amount: number;
  deferral_journal_no: string | null;
}
// TFRS 15 / IFRS 15 contracts (REV-19)
type PoMethod = 'point_in_time' | 'over_time';
interface ContractRow { id: number; contract_no: string; contract_date: string | null; total_price: number; status: string; currency: string }
interface ContractsResp { contracts: ContractRow[]; count: number }
interface Obligation { id: number; name: string; ssp: number; allocated_price: number; method: PoMethod; start_date: string | null; end_date: string | null; satisfied_pct: number; status: string }
interface ScheduleLine { id: number; obligation_id: number; period: string; planned_amount: number; recognized_amount: number; recognized: boolean }
interface ContractDetailT {
  id: number; contract_no: string; contract_date: string | null; currency: string; total_price: number; status: string; description: string | null;
  obligations: Obligation[]; schedule: ScheduleLine[];
}
interface PoForm { name: string; ssp: string; method: PoMethod; start_date: string; end_date: string }
interface SchedulesResp { schedules: Schedule[]; count: number }
interface DeferredResp {
  as_of: string | null;
  deferred_balance: number;
  gl_unearned: number;
  reconciled: boolean;
  by_schedule: { schedule_no: string; total: number; recognized: number; remaining: number }[];
}

export default function RevenuePage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('fnx.rev.title')}
        description={t('fnx.rev.desc')}
      />
      <Tabs
        tabs={[
          { key: 'contracts', label: t('fnx.rev.tab_contracts'), content: <ContractsTab /> },
          { key: 'deferred', label: t('fnx.rev.tab_deferred'), content: <DeferredTab /> },
          { key: 'schedules', label: t('fnx.rev.tab_schedules'), content: <SchedulesTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── สัญญา TFRS 15 (5-step) ─────────────────────────
function ContractsTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<ContractsResp>({ queryKey: ['rev-contracts'], queryFn: () => api('/api/revenue/contracts') });
  const contracts = q.data?.contracts ?? [];
  const [selected, setSelected] = useState<number | null>(null);

  // Create-contract form
  const [totalPrice, setTotalPrice] = useState('');
  const [desc, setDesc] = useState('');
  const [contractDate, setContractDate] = useState('2026-01-01');
  const [pos, setPos] = useState<PoForm[]>([{ name: '', ssp: '', method: 'point_in_time', start_date: '', end_date: '' }]);

  const setPo = (i: number, patch: Partial<PoForm>) => setPos((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addPo = () => setPos((rows) => [...rows, { name: '', ssp: '', method: 'point_in_time', start_date: '', end_date: '' }]);
  const removePo = (i: number) => setPos((rows) => (rows.length > 1 ? rows.filter((_, idx) => idx !== i) : rows));

  const create = useMutation({
    mutationFn: () =>
      api<{ contract_no: string }>('/api/revenue/contracts', {
        method: 'POST',
        body: JSON.stringify({
          total_price: Number(totalPrice) || 0,
          description: desc || undefined,
          contract_date: contractDate,
          obligations: pos.map((p) => ({
            name: p.name,
            ssp: Number(p.ssp) || 0,
            method: p.method,
            ...(p.method === 'over_time' ? { start_date: p.start_date, end_date: p.end_date } : {}),
          })),
        }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('fnx.rev.c_created_ok', { no: r.contract_no }));
      setTotalPrice(''); setDesc('');
      setPos([{ name: '', ssp: '', method: 'point_in_time', start_date: '', end_date: '' }]);
      qc.invalidateQueries({ queryKey: ['rev-contracts'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const canCreate =
    Number(totalPrice) > 0 &&
    pos.every((p) => p.name.trim() && Number(p.ssp) > 0 && (p.method === 'point_in_time' || (p.start_date && p.end_date)));

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t('fnx.rev.stat_count')} value={num(contracts.length)} icon={FileSignature} tone="primary" />
            <StatCard label={t('fnx.rev.c_total')} value={baht(contracts.reduce((a, c) => a + c.total_price, 0))} icon={Coins} />
            <StatCard label={t('fnx.rev.stat_recognized')} value={num(contracts.filter((c) => c.status === 'Completed').length)} tone="success" />
          </div>
        )}
      </StateView>

      {/* Create contract */}
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('fnx.rev.c_new')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="rc-total">{t('fnx.rev.c_total')}</Label>
              <Input id="rc-total" type="number" min="0" value={totalPrice} onChange={(e) => setTotalPrice(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rc-date">{t('fnx.rev.c_date')}</Label>
              <Input id="rc-date" type="date" value={contractDate} onChange={(e) => setContractDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rc-desc">{t('fnx.rev.c_desc')}</Label>
              <Input id="rc-desc" value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-muted-foreground">{t('fnx.rev.c_obligations')}</h4>
            {pos.map((p, i) => (
              <div key={i} className="grid items-end gap-3 rounded-lg border p-3 sm:grid-cols-12">
                <div className="grid gap-2 sm:col-span-3">
                  <Label htmlFor={`po-name-${i}`}>{t('fnx.rev.c_po_name')}</Label>
                  <Input id={`po-name-${i}`} value={p.name} onChange={(e) => setPo(i, { name: e.target.value })} />
                </div>
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor={`po-ssp-${i}`}>{t('fnx.rev.c_po_ssp')}</Label>
                  <Input id={`po-ssp-${i}`} type="number" min="0" value={p.ssp} onChange={(e) => setPo(i, { ssp: e.target.value })} placeholder="0" />
                </div>
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor={`po-method-${i}`}>{t('fnx.rev.c_po_method')}</Label>
                  <Select id={`po-method-${i}`} value={p.method} onChange={(e) => setPo(i, { method: e.target.value as PoMethod })}>
                    <option value="point_in_time">{t('fnx.rev.c_m_point')}</option>
                    <option value="over_time">{t('fnx.rev.c_m_over')}</option>
                  </Select>
                </div>
                {p.method === 'over_time' && (
                  <>
                    <div className="grid gap-2 sm:col-span-2">
                      <Label htmlFor={`po-start-${i}`}>{t('fnx.rev.c_po_start')}</Label>
                      <Input id={`po-start-${i}`} type="date" value={p.start_date} onChange={(e) => setPo(i, { start_date: e.target.value })} />
                    </div>
                    <div className="grid gap-2 sm:col-span-2">
                      <Label htmlFor={`po-end-${i}`}>{t('fnx.rev.c_po_end')}</Label>
                      <Input id={`po-end-${i}`} type="date" value={p.end_date} onChange={(e) => setPo(i, { end_date: e.target.value })} />
                    </div>
                  </>
                )}
                <div className="sm:col-span-1">
                  <Button variant="ghost" size="icon" disabled={pos.length === 1} onClick={() => removePo(i)} title={t('fnx.rev.c_remove')}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={addPo}>
              <Plus className="size-4" /> {t('fnx.rev.c_add_po')}
            </Button>
          </div>

          <Button disabled={create.isPending || !canCreate} onClick={() => create.mutate()}>
            <FileSignature className="size-4" /> {create.isPending ? t('fnx.rev.recognizing') : t('fnx.rev.c_create_btn')}
          </Button>
        </CardContent>
      </Card>

      {/* Contracts table */}
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={contracts}
            rowKey={(r) => r.contract_no}
            onRowClick={(r: ContractRow) => setSelected((id) => (id === r.id ? null : r.id))}
            emptyText={t('fnx.rev.c_empty')}
            columns={[
              { key: 'contract_no', label: t('fnx.rev.col_schedule_no'), render: (r) => <span className="font-medium">{r.contract_no}</span> },
              { key: 'contract_date', label: t('fnx.rev.c_date') },
              { key: 'total_price', label: t('fnx.rev.c_total'), align: 'right', render: (r) => <span className="tabular">{baht(r.total_price)}</span> },
              { key: 'currency', label: t('fnx.rev.col_ref') },
              { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            ]}
          />
        )}
      </StateView>

      {selected != null && <ContractDetail contractId={selected} />}
    </div>
  );
}

function ContractDetail({ contractId }: { contractId: number }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<ContractDetailT>({ queryKey: ['rev-contract', contractId], queryFn: () => api(`/api/revenue/contracts/${contractId}`) });

  const refetch = () => {
    qc.invalidateQueries({ queryKey: ['rev-contract', contractId] });
    qc.invalidateQueries({ queryKey: ['rev-contracts'] });
    qc.invalidateQueries({ queryKey: ['rev-schedules'] });
    qc.invalidateQueries({ queryKey: ['rev-deferred'] });
  };

  const allocate = useMutation({
    mutationFn: () => api<{ sum_allocated: number }>(`/api/revenue/contracts/${contractId}/allocate`, { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('fnx.rev.c_allocated_ok', { sum: baht(r.sum_allocated) })); refetch(); },
    onError: (e: Error) => notifyError(e.message),
  });
  const schedule = useMutation({
    mutationFn: () => api(`/api/revenue/contracts/${contractId}/schedule`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('fnx.rev.c_scheduled_ok')); refetch(); },
    onError: (e: Error) => notifyError(e.message),
  });
  const activate = useMutation({
    mutationFn: () => api<{ deferred_revenue: number }>(`/api/revenue/contracts/${contractId}/activate`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r) => { notifySuccess(t('fnx.rev.c_activated_ok', { amt: baht(r.deferred_revenue) })); refetch(); },
    onError: (e: Error) => notifyError(e.message),
  });

  const busy = allocate.isPending || schedule.isPending || activate.isPending;
  const c = q.data;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Layers className="size-4" />
          {c ? t('fnx.rev.c_detail', { no: c.contract_no }) : '…'}
          {c && <Badge variant={statusVariant(c.status)}>{c.status}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Five-step actions */}
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => allocate.mutate()}>{t('fnx.rev.c_step_allocate')}</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => schedule.mutate()}>{t('fnx.rev.c_step_schedule')}</Button>
          <Button variant="outline" size="sm" disabled={busy || c?.status === 'Active' || c?.status === 'Completed'} onClick={() => activate.mutate()}>{t('fnx.rev.c_step_activate')}</Button>
        </div>

        <StateView q={q}>
          {c && (
            <div className="space-y-5">
              <div>
                <h4 className="mb-3 text-sm font-semibold text-muted-foreground">{t('fnx.rev.c_obligations')}</h4>
                <DataTable
                  rows={c.obligations}
                  rowKey={(r) => String(r.id)}
                  columns={[
                    { key: 'name', label: t('fnx.rev.c_po_name'), render: (r) => <span className="font-medium">{r.name}</span> },
                    { key: 'method', label: t('fnx.rev.c_po_method'), render: (r) => <Badge variant="info">{r.method === 'over_time' ? t('fnx.rev.c_m_over') : t('fnx.rev.c_m_point')}</Badge> },
                    { key: 'ssp', label: t('fnx.rev.c_po_ssp'), align: 'right', render: (r) => <span className="tabular">{baht(r.ssp)}</span> },
                    { key: 'allocated_price', label: t('fnx.rev.c_allocated'), align: 'right', render: (r) => <span className="tabular">{baht(r.allocated_price)}</span> },
                    { key: 'satisfied_pct', label: t('fnx.rev.c_satisfied'), align: 'right', render: (r) => <span className="tabular">{num(r.satisfied_pct)}%</span> },
                    { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                  ]}
                />
              </div>
              {c.schedule.length > 0 && (
                <div>
                  <h4 className="mb-3 text-sm font-semibold text-muted-foreground">{t('fnx.rev.c_schedule_rows')}</h4>
                  <DataTable
                    rows={c.schedule}
                    rowKey={(r) => String(r.id)}
                    columns={[
                      { key: 'period', label: t('fnx.rev.col_start') },
                      { key: 'planned_amount', label: t('fnx.rev.c_planned'), align: 'right', render: (r) => <span className="tabular">{baht(r.planned_amount)}</span> },
                      { key: 'recognized_amount', label: t('fnx.rev.col_recognized'), align: 'right', render: (r) => <span className="tabular">{baht(r.recognized_amount)}</span> },
                      { key: 'recognized', label: t('fnx.rev.c_recognized_flag'), render: (r) => <Badge variant={r.recognized ? 'success' : 'secondary'}>{r.recognized ? t('fnx.rev.recon_ok') : '—'}</Badge> },
                    ]}
                  />
                </div>
              )}
            </div>
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

// ───────────────────────── รายได้รอตัดบัญชี + เดินรายการรับรู้ ─────────────────────────
function DeferredTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<DeferredResp>({ queryKey: ['rev-deferred'], queryFn: () => api('/api/revenue/deferred') });
  const [period, setPeriod] = useState(currentPeriod());
  const [msg, setMsg] = useState('');

  const recognize = useMutation({
    mutationFn: () =>
      api<{ period: string; recognized_count: number; total_recognized: number }>(
        `/api/revenue/recognize?period=${encodeURIComponent(period)}`,
        { method: 'POST' },
      ),
    onSuccess: (r) => {
      setMsg(`✅ ${t('fnx.rev.recognize_ok', { count: r.recognized_count, total: baht(r.total_recognized), period: r.period })}`);
      qc.invalidateQueries({ queryKey: ['rev-deferred'] });
      qc.invalidateQueries({ queryKey: ['rev-schedules'] });
    },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('fnx.rev.run_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="rev-period">{t('fnx.rev.period_label')}</Label>
              <Input
                id="rev-period"
                className="max-w-[160px]"
                placeholder="2026-06"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
              />
            </div>
            <Button
              disabled={recognize.isPending || !/^\d{4}-\d{2}$/.test(period)}
              onClick={() => recognize.mutate()}
            >
              <PlayCircle className="size-4" /> {recognize.isPending ? t('fnx.rev.recognizing') : t('fnx.rev.recognize_btn')}
            </Button>
          </div>
          <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label={t('fnx.rev.stat_deferred')} value={baht(q.data.deferred_balance)} icon={Coins} tone="primary" />
              <StatCard label={t('fnx.rev.stat_gl2400')} value={baht(q.data.gl_unearned)} icon={CircleDollarSign} />
              <StatCard
                label={t('fnx.rev.stat_recon')}
                value={<Badge variant={q.data.reconciled ? 'success' : 'destructive'}>{q.data.reconciled ? t('fnx.rev.recon_ok') : t('fnx.rev.recon_off')}</Badge>}
              />
            </div>
            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('fnx.rev.by_schedule')}</h3>
              <DataTable
                rows={q.data.by_schedule}
                rowKey={(r) => r.schedule_no}
                columns={[
                  { key: 'schedule_no', label: t('fnx.rev.col_schedule_no') },
                  { key: 'total', label: t('fnx.rev.col_total'), align: 'right', render: (r) => <span className="tabular">{baht(r.total)}</span> },
                  { key: 'recognized', label: t('fnx.rev.col_recognized'), align: 'right', render: (r) => <span className="tabular">{baht(r.recognized)}</span> },
                  { key: 'remaining', label: t('fnx.rev.col_remaining'), align: 'right', render: (r) => <span className="tabular">{baht(r.remaining)}</span> },
                ]}
                emptyText={t('fnx.rev.empty_deferred')}
              />
            </div>
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── ตารางรับรู้รายได้ ─────────────────────────
function SchedulesTab() {
  const { t } = useLang();
  const q = useQuery<SchedulesResp>({ queryKey: ['rev-schedules'], queryFn: () => api('/api/revenue/schedules') });
  return (
    <ModulePage
      query={q}
      stats={
        q.data && (
          <>
            <StatCard label={t('fnx.rev.stat_count')} value={q.data.count} icon={ScrollText} tone="primary" />
            <StatCard
              label={t('fnx.rev.stat_total')}
              value={baht(q.data.schedules.reduce((a, s) => a + s.total_amount, 0))}
              icon={Coins}
            />
            <StatCard
              label={t('fnx.rev.stat_recognized')}
              value={baht(q.data.schedules.reduce((a, s) => a + s.recognized_amount, 0))}
              tone="success"
            />
            <StatCard
              label={t('fnx.rev.stat_remaining')}
              value={baht(q.data.schedules.reduce((a, s) => a + s.remaining_amount, 0))}
              tone="warning"
            />
          </>
        )
      }
    >
      {q.data && (
        <DataTable
          rows={q.data.schedules}
          rowKey={(r) => r.schedule_no}
          columns={[
            { key: 'schedule_no', label: t('fnx.rev.col_schedule_no'), render: (r) => <span className="font-medium">{r.schedule_no}</span> },
            { key: 'source_ref', label: t('fnx.rev.col_ref'), render: (r) => r.source_ref ?? '—' },
            { key: 'start_period', label: t('fnx.rev.col_start') },
            { key: 'end_period', label: t('fnx.rev.col_end') },
            { key: 'months', label: t('fnx.rev.col_months'), align: 'right', render: (r) => <span className="tabular">{r.months}</span> },
            { key: 'total_amount', label: t('fnx.rev.col_total'), align: 'right', render: (r) => <span className="tabular">{baht(r.total_amount)}</span> },
            { key: 'recognized_amount', label: t('fnx.rev.col_recognized'), align: 'right', render: (r) => <span className="tabular">{baht(r.recognized_amount)}</span> },
            { key: 'remaining_amount', label: t('fnx.rev.col_remaining'), align: 'right', render: (r) => <span className="tabular">{baht(r.remaining_amount)}</span> },
            { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
          ]}
          emptyText={t('fnx.rev.empty_schedules')}
        />
      )}
    </ModulePage>
  );
}
