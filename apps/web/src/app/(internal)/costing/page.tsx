'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator, Coins, ShieldCheck, Save, Boxes, SlidersHorizontal, PackageCheck, ClipboardList, Truck } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
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
import { statusVariant } from '@/components/ui';

const methodVariant = (m: string) =>
  m === 'FIFO' ? 'info' : m === 'AVG' ? 'secondary' : m === 'STD' ? 'warning' : 'muted';

export default function CostingPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('mx.costing_title')}
        description={t('mx.costing_desc')}
      />
      <Tabs
        tabs={[
          { key: 'valuation', label: t('mx.costing_tab_valuation'), content: <ValuationTab /> },
          { key: 'config', label: t('mx.costing_tab_config'), content: <ConfigTab /> },
          { key: 'atp', label: t('mx.costing_tab_atp'), content: <AtpTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Valuation ─────────────────────────
function ValuationTab() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['costing-valuation'], queryFn: () => api('/api/costing/valuation') });
  const items: any[] = q.data?.items ?? [];

  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('mx.costing_total_value')} value={baht(q.data.total_value)} icon={Coins} tone="primary" />
            <StatCard label={t('mx.costing_gl_1200')} value={baht(q.data.gl_1200)} icon={Calculator} tone="info" />
            <StatCard label={t('mx.costing_item_count')} value={num(items.length)} icon={Boxes} tone="default" />
            <StatCard
              label={t('mx.costing_ties_label')}
              value={<Badge variant={q.data.ties ? 'success' : 'destructive'}>{q.data.ties ? t('mx.costing_ties_yes') : t('mx.costing_ties_no')}</Badge>}
              icon={ShieldCheck}
              tone={q.data.ties ? 'success' : 'danger'}
            />
          </div>
          <DataTable
            rows={items}
            columns={[
              { key: 'item_id', label: t('mx.costing_col_item') },
              { key: 'method', label: t('mx.costing_col_method'), render: (r: any) => <Badge variant={methodVariant(r.method)}>{r.method}</Badge> },
              { key: 'qty', label: t('mx.costing_col_qty'), align: 'right', render: (r: any) => <span className="tabular">{num(r.qty)}</span> },
              { key: 'unit_cost', label: t('mx.costing_col_unit_cost'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.unit_cost)}</span> },
              { key: 'value', label: t('mx.costing_col_value'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.value)}</span> },
            ]}
            emptyState={{
              icon: Boxes,
              title: t('mx.costing_empty_val_title'),
              description: t('mx.costing_empty_val_desc'),
            }}
          />
        </div>
      )}
    </StateView>
  );
}

// ───────────────────────── Config ─────────────────────────
function ConfigTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['costing-config'], queryFn: () => api('/api/costing/config') });

  const [itemId, setItemId] = useState('');
  const [method, setMethod] = useState<'FIFO' | 'AVG' | 'STD'>('FIFO');
  const [standardCost, setStandardCost] = useState('');

  const save = useMutation({
    mutationFn: () =>
      api<{ item_id: string | null; method: string }>('/api/costing/config', {
        method: 'PUT',
        body: JSON.stringify({
          item_id: itemId || null,
          method,
          standard_cost: method === 'STD' && standardCost !== '' ? Number(standardCost) : null,
        }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('mx.costing_saved', { item: r.item_id ?? t('mx.costing_default'), method: r.method }));
      qc.invalidateQueries({ queryKey: ['costing-config'] });
      qc.invalidateQueries({ queryKey: ['costing-valuation'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const config: any[] = q.data?.config ?? [];

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('mx.costing_tab_config')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('mx.costing_config_hint')}</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="cfg-item">{t('mx.costing_col_item')}</Label>
              <Input id="cfg-item" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder={t('mx.costing_default_ph')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cfg-method">{t('mx.costing_col_method')}</Label>
              <select
                id="cfg-method"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={method}
                onChange={(e) => setMethod(e.target.value as any)}
              >
                <option value="FIFO">{t('mx.costing_fifo_option')}</option>
                <option value="AVG">{t('mx.costing_avg_option')}</option>
                <option value="STD">{t('mx.costing_std_option')}</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cfg-std">{t('mx.costing_std_cost')}</Label>
              <Input
                id="cfg-std"
                type="number"
                min="0"
                value={standardCost}
                onChange={(e) => setStandardCost(e.target.value)}
                disabled={method !== 'STD'}
                placeholder={method === 'STD' ? '0.00' : '—'}
              />
            </div>
          </div>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            <Save className="size-4" /> {save.isPending ? t('mx.costing_saving') : t('mx.costing_save_config')}
          </Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={config}
            columns={[
              { key: 'item_id', label: t('mx.costing_col_item'), render: (r: any) => r.item_id ?? t('mx.costing_default_ph') },
              { key: 'method', label: t('mx.costing_col_method'), render: (r: any) => <Badge variant={methodVariant(r.method)}>{r.method}</Badge> },
              { key: 'standard_cost', label: t('mx.costing_std_cost'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.standard_cost)}</span> },
              { key: 'avg_cost', label: t('mx.costing_avg_cost'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.avg_cost)}</span> },
              { key: 'on_hand', label: t('mx.costing_on_hand'), align: 'right', render: (r: any) => <span className="tabular">{num(r.on_hand)}</span> },
            ]}
            emptyState={{
              icon: SlidersHorizontal,
              title: t('mx.costing_empty_cfg_title'),
              description: t('mx.costing_empty_cfg_desc'),
            }}
          />
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── ATP / order-promising (INV-09) ─────────────────────────
interface AtpResult { item_id: string; on_hand: number; allocated: number; safety: number; scheduled_receipts: { po_no: string; qty: number; expected_date: string | null }[]; atp_qty: number }
interface CheckResult { can_promise: boolean; atp_qty: number; requested: number; shortfall: number; first_available_date: string | null }
interface Allocation { id: number; item_id: string; ref_doc: string; qty: number; need_by: string | null; status: string }
interface AllocsResp { allocations: Allocation[]; count: number; open_qty: number }

function AtpTab() {
  const { t } = useLang();
  const qc = useQueryClient();

  // Check ATP
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('');
  const [needBy, setNeedBy] = useState('2026-12-31');
  const [atp, setAtp] = useState<AtpResult | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);

  // Reserve
  const [refDoc, setRefDoc] = useState('');

  const runCheck = useMutation({
    mutationFn: async () => {
      const [a, c] = await Promise.all([
        api<AtpResult>(`/api/costing/atp?item_id=${encodeURIComponent(itemId)}&need_by=${encodeURIComponent(needBy)}`),
        api<CheckResult>('/api/costing/atp/check', { method: 'POST', body: JSON.stringify({ item_id: itemId, qty: Number(qty) || 0, date: needBy }) }),
      ]);
      return { a, c };
    },
    onSuccess: ({ a, c }) => { setAtp(a); setCheck(c); },
    onError: (e: any) => notifyError(e.message),
  });

  const allocations = useQuery<AllocsResp>({ queryKey: ['atp-allocations'], queryFn: () => api('/api/costing/allocations') });

  const reserve = useMutation({
    mutationFn: () => api<{ item_id: string; ref_doc: string; qty: number; adjusted: boolean }>('/api/costing/allocate', {
      method: 'POST',
      body: JSON.stringify({ item_id: itemId, qty: Number(qty) || 0, ref_doc: refDoc, need_by: needBy }),
    }),
    onSuccess: (r) => {
      notifySuccess(`${t('mx.alloc_ok', { item: r.item_id, qty: num(r.qty), ref: r.ref_doc })}${r.adjusted ? ` (${t('mx.alloc_adjusted')})` : ''}`);
      setRefDoc('');
      qc.invalidateQueries({ queryKey: ['atp-allocations'] });
      if (itemId) runCheck.mutate();
    },
    onError: (e: any) => notifyError(e.message),
  });

  const lifecycle = useMutation({
    mutationFn: ({ ref, action }: { ref: string; action: 'release' | 'fulfill' }) =>
      api<{ ref_doc: string; released_qty?: number; fulfilled_qty?: number }>(`/api/costing/allocations/${encodeURIComponent(ref)}/${action}`, { method: 'POST' }),
    onSuccess: (r, v) => {
      notifySuccess(v.action === 'release'
        ? t('mx.alloc_released_ok', { ref: r.ref_doc, qty: num(r.released_qty ?? 0) })
        : t('mx.alloc_fulfilled_ok', { ref: r.ref_doc, qty: num(r.fulfilled_qty ?? 0) }));
      qc.invalidateQueries({ queryKey: ['atp-allocations'] });
      if (itemId) runCheck.mutate();
    },
    onError: (e: any) => notifyError(e.message),
  });

  const allocs = allocations.data?.allocations ?? [];

  return (
    <div className="space-y-5">
      {/* Check + reserve */}
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('mx.atp_check_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('mx.atp_hint')}</p>
          <div className="grid items-end gap-3 sm:grid-cols-4">
            <div className="grid gap-2">
              <Label htmlFor="atp-item">{t('mx.atp_item')}</Label>
              <Input id="atp-item" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="WIDGET" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="atp-qty">{t('mx.atp_qty')}</Label>
              <Input id="atp-qty" type="number" min="0" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="atp-date">{t('mx.atp_date')}</Label>
              <Input id="atp-date" type="date" value={needBy} onChange={(e) => setNeedBy(e.target.value)} />
            </div>
            <Button disabled={runCheck.isPending || !itemId.trim() || !(Number(qty) > 0)} onClick={() => runCheck.mutate()}>
              <PackageCheck className="size-4" /> {t('mx.atp_check_btn')}
            </Button>
          </div>

          {check && atp && (
            <div className="space-y-4 rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant={check.can_promise ? 'success' : 'destructive'} className="gap-1">
                  {check.can_promise ? <PackageCheck className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
                  {check.can_promise ? t('mx.atp_result_can') : t('mx.atp_result_cannot')}
                </Badge>
                {!check.can_promise && check.shortfall > 0 && (
                  <span className="text-sm text-muted-foreground">{t('mx.atp_shortfall')}: <span className="tabular font-medium text-destructive">{num(check.shortfall)}</span></span>
                )}
                {check.first_available_date && (
                  <span className="text-sm text-muted-foreground">{t('mx.atp_first_avail')}: <span className="font-medium">{check.first_available_date}</span></span>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <StatCard label={t('mx.atp_available')} value={num(atp.atp_qty)} icon={PackageCheck} tone="primary" />
                <StatCard label={t('mx.atp_on_hand')} value={num(atp.on_hand)} />
                <StatCard label={t('mx.atp_allocated')} value={num(atp.allocated)} tone="warning" />
                <StatCard label={t('mx.atp_safety')} value={num(atp.safety)} />
              </div>
              {atp.scheduled_receipts.length > 0 && (
                <div>
                  <h4 className="mb-2 text-sm font-semibold text-muted-foreground">{t('mx.atp_scheduled')}</h4>
                  <DataTable
                    rows={atp.scheduled_receipts}
                    rowKey={(r) => r.po_no}
                    columns={[
                      { key: 'po_no', label: t('mx.atp_col_po') },
                      { key: 'qty', label: t('mx.atp_qty'), align: 'right', render: (r) => <span className="tabular">{num(r.qty)}</span> },
                      { key: 'expected_date', label: t('mx.atp_col_expected'), render: (r) => r.expected_date ?? '—' },
                    ]}
                  />
                </div>
              )}
              {/* Reserve against a doc — uses the same item/qty/need-by */}
              <div className="flex flex-wrap items-end gap-3 border-t pt-4">
                <div className="grid grow gap-2">
                  <Label htmlFor="atp-ref">{t('mx.alloc_ref')}</Label>
                  <Input id="atp-ref" value={refDoc} onChange={(e) => setRefDoc(e.target.value)} placeholder="SO-1234" />
                </div>
                <Button variant="outline" disabled={reserve.isPending || !refDoc.trim() || !itemId.trim() || !(Number(qty) > 0)} onClick={() => reserve.mutate()}>
                  <ClipboardList className="size-4" /> {t('mx.alloc_btn')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Reservations register */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground">{t('mx.alloc_list_title')}</h3>
          {allocations.data && <Badge variant="secondary">{t('mx.alloc_open_qty')}: {num(allocations.data.open_qty)}</Badge>}
        </div>
        <StateView q={allocations}>
          {allocations.data && (
            <DataTable
              rows={allocs}
              rowKey={(r) => String(r.id)}
              emptyState={{ icon: Truck, title: t('mx.alloc_list_title'), description: t('mx.alloc_empty') }}
              columns={[
                { key: 'ref_doc', label: t('mx.alloc_ref'), render: (r: Allocation) => <span className="font-medium">{r.ref_doc}</span> },
                { key: 'item_id', label: t('mx.atp_item') },
                { key: 'qty', label: t('mx.atp_qty'), align: 'right', render: (r: Allocation) => <span className="tabular">{num(r.qty)}</span> },
                { key: 'need_by', label: t('mx.atp_date'), render: (r: Allocation) => r.need_by ?? '—' },
                { key: 'status', label: t('mx.costing_col_method'), render: (r: Allocation) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                {
                  key: 'actions',
                  label: '',
                  align: 'right',
                  render: (r: Allocation) =>
                    r.status !== 'Open' ? null : (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" disabled={lifecycle.isPending} onClick={() => lifecycle.mutate({ ref: r.ref_doc, action: 'fulfill' })}>{t('mx.alloc_fulfill')}</Button>
                        <Button size="sm" variant="outline" disabled={lifecycle.isPending} onClick={() => lifecycle.mutate({ ref: r.ref_doc, action: 'release' })}>{t('mx.alloc_release')}</Button>
                      </div>
                    ),
                },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}
