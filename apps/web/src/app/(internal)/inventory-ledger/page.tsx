'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Boxes, CheckCircle2, Layers, PackagePlus, Scale, Send, TriangleAlert, Wallet, History as HistoryIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Perpetual inventory valuation sub-ledger (INV-06): valued receipts/issues/adjustments + moving-average or
// FIFO/FEFO cost layers, with a GL reconciliation tie-out (sub-ledger value ↔ account 1200).

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

const METHOD_KEYS: Record<string, string> = { moving_avg: 'iv.led_method_moving_avg', fifo: 'iv.led_method_fifo', fefo: 'iv.led_method_fefo' };
function methodLabel(t: (k: string) => string, m: string) { const k = METHOD_KEYS[m]; return k ? t(k) : m; }

interface ValItem { item_id: string; item_description?: string; location_id: string; on_hand_qty: number; avg_cost: number; total_value: number; costing_method: string }
interface ValResp { items: ValItem[]; count: number; total_value: number }
interface ReconResp { sub_ledger_value: number; gl_inventory: number; difference: number; reconciled: boolean }

export default function InventoryLedgerPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('iv.led_title')}
        description={t('iv.led_desc')}
      />
      <Tabs
        tabs={[
          { key: 'valuation', label: t('iv.led_tab_valuation'), content: <Valuation /> },
          { key: 'receipt', label: t('iv.led_tab_receipt'), content: <ReceiptForm /> },
          { key: 'issue', label: t('iv.led_tab_issue'), content: <IssueForm /> },
          { key: 'adjust', label: t('iv.led_tab_adjust'), content: <AdjustForm /> },
          { key: 'writeoffs', label: t('iv.led_tab_writeoffs'), content: <WriteOffsView /> },
          { key: 'layers', label: t('iv.led_tab_layers'), content: <LayersView /> },
          { key: 'moves', label: t('iv.led_tab_moves'), content: <MovesView /> },
        ]}
      />
    </div>
  );
}

// Shared <datalist> of known tracked items so the issue/adjust forms autocomplete item ids.
function useItemList() {
  const q = useQuery<ValResp>({ queryKey: ['inv-valuation'], queryFn: () => api('/api/inventory/valuation') });
  return q.data?.items ?? [];
}
function ItemDatalist({ id, items }: { id: string; items: ValItem[] }) {
  const seen = new Set<string>();
  return (
    <datalist id={id}>
      {items.filter((i) => !seen.has(i.item_id) && seen.add(i.item_id)).map((i) => (
        <option key={i.item_id} value={i.item_id}>{i.item_description ?? i.item_id}</option>
      ))}
    </datalist>
  );
}

// ───────────────────────── Valuation + reconciliation ─────────────────────────
function Valuation() {
  const { t } = useLang();
  const val = useQuery<ValResp>({ queryKey: ['inv-valuation'], queryFn: () => api('/api/inventory/valuation'), placeholderData: keepPreviousData });
  const rec = useQuery<ReconResp>({ queryKey: ['inv-reconcile'], queryFn: () => api('/api/inventory/reconciliation') });
  const d = val.data;
  const r = rec.data;

  return (
    <StateView q={val}>
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={t('iv.led_stat_total')} value={`฿${num(d?.total_value ?? 0)}`} icon={Wallet} tone="primary" hint={t('iv.led_stat_total_hint')} />
          <StatCard label={t('iv.led_stat_count')} value={num(d?.count ?? 0)} icon={Boxes} />
          <StatCard label={t('iv.led_stat_gl')} value={r ? `฿${num(r.gl_inventory)}` : '—'} icon={Scale} hint={t('iv.led_stat_gl_hint')} />
          <StatCard
            label={r?.reconciled ? t('iv.led_stat_recon_ok') : t('iv.led_stat_recon_off')}
            value={r ? `฿${num(r.difference)}` : '—'}
            icon={r?.reconciled ? CheckCircle2 : TriangleAlert}
            tone={r ? (r.reconciled ? 'success' : 'danger') : undefined}
            hint={r?.reconciled ? 'sub-ledger = GL' : t('iv.led_stat_recon_check')}
          />
        </div>

        {d && (
          <DataTable
            rows={d.items}
            rowKey={(r2) => `${r2.item_id}@${r2.location_id}`}
            emptyState={{ icon: Wallet, title: t('iv.led_val_empty_title'), description: t('iv.led_val_empty_desc') }}
            columns={[
              { key: 'item_id', label: t('inv.col_code'), render: (r2) => <span className="font-medium">{r2.item_id}</span> },
              { key: 'item_description', label: t('iv.led_item') },
              { key: 'location_id', label: t('iv.led_location') },
              { key: 'on_hand_qty', label: t('iv.led_onhand'), align: 'right', render: (r2) => <span className="tabular">{num(r2.on_hand_qty)}</span> },
              { key: 'avg_cost', label: t('iv.led_unit_cost'), align: 'right', render: (r2) => <span className="tabular">฿{num(r2.avg_cost)}</span> },
              { key: 'total_value', label: t('iv.led_total_value'), align: 'right', render: (r2) => <span className="tabular font-medium">฿{num(r2.total_value)}</span> },
              { key: 'costing_method', label: t('iv.led_costing_method'), render: (r2) => <Badge variant="outline">{methodLabel(t, r2.costing_method)}</Badge> },
            ]}
          />
        )}
      </div>
    </StateView>
  );
}

// ───────────────────────── Receipt (valued goods-in) ─────────────────────────
function ReceiptForm() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [form, setForm] = useState({ item_id: '', item_description: '', location_id: 'WH-MAIN', qty: '', unit_cost: '', costing_method: 'moving_avg', lot_no: '', expiry_date: '', ref_type: '', ref_id: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const layered = form.costing_method === 'fifo' || form.costing_method === 'fefo';

  const submit = useMutation({
    mutationFn: () => api<any>('/api/inventory/receipts', {
      method: 'POST',
      body: JSON.stringify({
        item_id: form.item_id.trim(),
        item_description: form.item_description.trim() || undefined,
        location_id: form.location_id.trim() || undefined,
        qty: Number(form.qty),
        unit_cost: Number(form.unit_cost),
        costing_method: form.costing_method,
        lot_no: layered && form.lot_no.trim() ? form.lot_no.trim() : undefined,
        expiry_date: layered && form.expiry_date ? form.expiry_date : undefined,
        ref_type: form.ref_type.trim() || undefined,
        ref_id: form.ref_id.trim() || undefined,
      }),
    }),
    onSuccess: (r) => {
      notifySuccess(r.deduped ? t('iv.led_rc_dedup', { move_no: r.move_no }) : t('iv.led_rc_ok', { move_no: r.move_no, balance: num(r.balance_qty), cost: num(r.avg_cost) }));
      setForm((f) => ({ ...f, qty: '', unit_cost: '', lot_no: '', expiry_date: '', ref_id: '' }));
      invalidateLedger(qc);
    },
    onError: (e: any) => notifyError(e.message),
  });

  const canSubmit = !!form.item_id.trim() && Number(form.qty) > 0 && Number(form.unit_cost) >= 0;

  return (
    <Card className="max-w-2xl gap-3 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="rc-item" label={t('iv.led_item_code')} required><Input id="rc-item" value={form.item_id} onChange={set('item_id')} placeholder={t('iv.led_rc_item_ph')} /></Field>
        <Field id="rc-desc" label={t('iv.led_desc_opt')}><Input id="rc-desc" value={form.item_description} onChange={set('item_description')} /></Field>
        <Field id="rc-qty" label={t('inv.col_qty')} required><Input id="rc-qty" type="number" min="0" step="any" value={form.qty} onChange={set('qty')} /></Field>
        <Field id="rc-cost" label={t('iv.led_unit_cost_baht')} required><Input id="rc-cost" type="number" min="0" step="any" value={form.unit_cost} onChange={set('unit_cost')} /></Field>
        <Field id="rc-loc" label={t('iv.led_location')}><Input id="rc-loc" value={form.location_id} onChange={set('location_id')} /></Field>
        <Field id="rc-method" label={t('iv.led_method_label')} hint={t('iv.led_method_hint')}>
          <select id="rc-method" className={selectCls} value={form.costing_method} onChange={set('costing_method')}>
            <option value="moving_avg">{t('iv.led_opt_moving_avg')}</option>
            <option value="fifo">{t('iv.led_opt_fifo')}</option>
            <option value="fefo">{t('iv.led_opt_fefo')}</option>
          </select>
        </Field>
        {layered && <Field id="rc-lot" label={t('iv.led_lot_opt')}><Input id="rc-lot" value={form.lot_no} onChange={set('lot_no')} placeholder={t('iv.led_lot_ph')} /></Field>}
        {layered && <Field id="rc-exp" label={t('iv.led_expiry_opt')} hint={t('iv.led_expiry_hint')}><Input id="rc-exp" type="date" value={form.expiry_date} onChange={set('expiry_date')} /></Field>}
        <Field id="rc-rt" label={t('iv.led_ref_type_opt')} hint={t('iv.led_ref_type_hint')}><Input id="rc-rt" value={form.ref_type} onChange={set('ref_type')} placeholder="GRN" /></Field>
        <Field id="rc-ri" label={t('iv.led_ref_no_opt')}><Input id="rc-ri" value={form.ref_id} onChange={set('ref_id')} placeholder="GRN-001" /></Field>
      </div>
      <p className="text-xs text-muted-foreground">{t('iv.led_rc_gl')}</p>
      <Button className="w-fit" disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>
        <PackagePlus className="size-4" /> {submit.isPending ? t('iv.led_saving') : t('iv.led_rc_submit')}
      </Button>
    </Card>
  );
}

// ───────────────────────── Issue (valued goods-out → COGS) ─────────────────────────
function IssueForm() {
  const { t } = useLang();
  const qc = useQueryClient();
  const items = useItemList();
  const [form, setForm] = useState({ item_id: '', location_id: 'WH-MAIN', qty: '', ref_type: '', ref_id: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = useMutation({
    mutationFn: () => api<any>('/api/inventory/issues', {
      method: 'POST',
      body: JSON.stringify({ item_id: form.item_id.trim(), location_id: form.location_id.trim() || undefined, qty: Number(form.qty), ref_type: form.ref_type.trim() || undefined, ref_id: form.ref_id.trim() || undefined }),
    }),
    onSuccess: (r) => {
      notifySuccess(t('iv.led_is_ok', { move_no: r.move_no, value: num(r.value), balance: num(r.balance_qty) }));
      setForm((f) => ({ ...f, qty: '', ref_id: '' }));
      invalidateLedger(qc);
    },
    onError: (e: any) => notifyError(e.message),
  });
  const canSubmit = !!form.item_id.trim() && Number(form.qty) > 0;

  return (
    <Card className="max-w-2xl gap-3 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="is-item" label={t('iv.led_item_code')} required><Input id="is-item" list="inv-items" value={form.item_id} onChange={set('item_id')} placeholder={t('iv.led_item_ph')} /></Field>
        <Field id="is-qty" label={t('iv.led_issue_qty')} required><Input id="is-qty" type="number" min="0" step="any" value={form.qty} onChange={set('qty')} /></Field>
        <Field id="is-loc" label={t('iv.led_location')}><Input id="is-loc" value={form.location_id} onChange={set('location_id')} /></Field>
        <Field id="is-rt" label={t('iv.led_ref_opt')}><Input id="is-rt" value={form.ref_id} onChange={set('ref_id')} placeholder="WO / MI" /></Field>
      </div>
      <ItemDatalist id="inv-items" items={items} />
      <p className="text-xs text-muted-foreground">{t('iv.led_is_gl')}</p>
      <Button className="w-fit" disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>
        <Send className="size-4" /> {submit.isPending ? t('iv.led_saving') : t('iv.led_is_submit')}
      </Button>
    </Card>
  );
}

// ───────────────────────── Adjustment (count variance / shrinkage) ─────────────────────────
function AdjustForm() {
  const { t } = useLang();
  const qc = useQueryClient();
  const items = useItemList();
  const [form, setForm] = useState({ item_id: '', location_id: 'WH-MAIN', qty_delta: '', reason: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = useMutation({
    mutationFn: () => api<any>('/api/inventory/adjustments', {
      method: 'POST',
      body: JSON.stringify({ item_id: form.item_id.trim(), location_id: form.location_id.trim() || undefined, qty_delta: Number(form.qty_delta), reason: form.reason.trim() }),
    }),
    onSuccess: (r) => {
      if (r.status === 'pending_approval') notifySuccess(t('iv.led_aj_pending', { value: num(Math.abs(r.estimated_value)) }));
      else notifySuccess(t('iv.led_aj_ok', { move_no: r.move_no, value: num(r.value), balance: num(r.balance_qty) }));
      setForm((f) => ({ ...f, qty_delta: '', reason: '' }));
      invalidateLedger(qc);
      qc.invalidateQueries({ queryKey: ['inv-writeoffs'] });
    },
    onError: (e: any) => notifyError(e.message),
  });
  const canSubmit = !!form.item_id.trim() && Number(form.qty_delta) !== 0 && !!form.reason.trim();

  return (
    <Card className="max-w-2xl gap-3 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="aj-item" label={t('iv.led_item_code')} required><Input id="aj-item" list="inv-items-aj" value={form.item_id} onChange={set('item_id')} placeholder={t('iv.led_item_ph')} /></Field>
        <Field id="aj-delta" label={t('iv.led_delta')} required hint={t('iv.led_delta_hint')}><Input id="aj-delta" type="number" step="any" value={form.qty_delta} onChange={set('qty_delta')} placeholder="-10" /></Field>
        <Field id="aj-loc" label={t('iv.led_location')}><Input id="aj-loc" value={form.location_id} onChange={set('location_id')} /></Field>
        <Field id="aj-reason" label={t('iv.led_reason')} required hint={t('iv.led_reason_hint')}><Input id="aj-reason" value={form.reason} onChange={set('reason')} placeholder={t('iv.led_reason_ph')} /></Field>
      </div>
      <ItemDatalist id="inv-items-aj" items={items} />
      <p className="text-xs text-muted-foreground">{t('iv.led_aj_gl1')} <strong>{t('iv.led_aj_gl2')}</strong> {t('iv.led_aj_gl3')}</p>
      <Button className="w-fit" disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>
        <Scale className="size-4" /> {submit.isPending ? t('iv.led_saving') : t('iv.led_aj_submit')}
      </Button>
    </Card>
  );
}

// ───────────── Write-off approvals (INV-07 maker-checker) ─────────────
const WO_STATUS_KEYS: Record<string, string> = { PendingApproval: 'iv.led_wo_pending', Posted: 'iv.led_wo_posted', Rejected: 'iv.led_wo_rejected' };
function woStatusLabel(t: (k: string) => string, s: string) { const k = WO_STATUS_KEYS[s]; return k ? t(k) : s; }
const woStatusTone = (s: string): 'warning' | 'success' | 'destructive' | 'secondary' =>
  s === 'PendingApproval' ? 'warning' : s === 'Posted' ? 'success' : s === 'Rejected' ? 'destructive' : 'secondary';

function WriteOffsView() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['inv-writeoffs'], queryFn: () => api('/api/inventory/writeoffs'), placeholderData: keepPreviousData });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['inv-writeoffs'] }); invalidateLedger(qc); };
  const approve = useMutation({
    mutationFn: (id: number) => api<any>(`/api/inventory/writeoffs/${id}/approve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('iv.led_wo_approved')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (id: number) => api<any>(`/api/inventory/writeoffs/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason: window.prompt(t('iv.led_wo_reject_prompt')) || undefined }) }),
    onSuccess: () => { notifySuccess(t('iv.led_wo_rejected_msg')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const busy = approve.isPending || reject.isPending;
  const d = q.data;

  return (
    <StateView q={q}>
      {d && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('iv.led_wo_note')} · <strong>{t('iv.led_wo_pending_count', { count: num(d.pending) })}</strong></p>
          <DataTable
            rows={d.writeoffs}
            rowKey={(r: any) => r.request_id}
            emptyState={{ icon: Scale, title: t('iv.led_wo_empty_title'), description: t('iv.led_wo_empty_desc') }}
            columns={[
              { key: 'item_id', label: t('iv.led_item_code'), render: (r: any) => <span className="font-medium">{r.item_id}</span> },
              { key: 'qty_delta', label: t('inv.col_qty'), align: 'right', render: (r: any) => <span className="tabular text-destructive">{num(r.qty_delta)}</span> },
              { key: 'est_value', label: t('iv.led_est_value'), align: 'right', render: (r: any) => <span className="tabular">฿{num(r.est_value)}</span> },
              { key: 'reason', label: t('iv.led_reason') },
              { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={woStatusTone(r.status)}>{woStatusLabel(t, r.status)}</Badge> },
              { key: 'by', label: t('iv.led_requester_approver'), render: (r: any) => <span className="text-xs text-muted-foreground">{r.requested_by ?? '—'}{r.approved_by ? ` → ${r.approved_by}` : ''}</span> },
              { key: 'act', label: '', align: 'right', render: (r: any) => r.status === 'PendingApproval' ? (
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => approve.mutate(r.request_id)}>{t('fin.approve')}</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => reject.mutate(r.request_id)}>{t('iv.led_reject_btn')}</Button>
                </div>
              ) : (r.move_no ? <span className="font-mono text-xs text-muted-foreground">{r.move_no}</span> : null) },
            ]}
          />
        </div>
      )}
    </StateView>
  );
}

// ───────────────────────── Cost layers (FIFO/FEFO) ─────────────────────────
function LayersView() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['inv-layers'], queryFn: () => api('/api/inventory/layers') });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable
          rows={q.data.layers}
          rowKey={(r: any, i: number) => `${r.item_id}-${i}`}
          emptyState={{ icon: Layers, title: t('iv.led_layers_empty_title'), description: t('iv.led_layers_empty_desc') }}
          columns={[
            { key: 'item_id', label: t('inv.col_code'), render: (r: any) => <span className="font-medium">{r.item_id}</span> },
            { key: 'location_id', label: t('iv.led_location') },
            { key: 'lot_no', label: 'Lot', render: (r: any) => r.lot_no ?? '—' },
            { key: 'expiry_date', label: t('iv.led_expiry'), render: (r: any) => (r.expiry_date ? thaiDate(r.expiry_date) : '—') },
            { key: 'remaining_qty', label: t('iv.led_onhand'), align: 'right', render: (r: any) => <span className="tabular">{num(r.remaining_qty)}</span> },
            { key: 'unit_cost', label: t('iv.led_unit_cost'), align: 'right', render: (r: any) => <span className="tabular">฿{num(r.unit_cost)}</span> },
            { key: 'layer_value', label: t('iv.led_layer_value'), align: 'right', render: (r: any) => <span className="tabular font-medium">฿{num(r.layer_value)}</span> },
          ]}
        />
      )}
    </StateView>
  );
}

// ───────────────────────── Valued move ledger (audit trail) ─────────────────────────
const MOVE_KEYS: Record<string, string> = { receipt: 'iv.led_move_receipt', issue: 'iv.led_move_issue', adjust: 'iv.led_move_adjust', transfer: 'iv.led_move_transfer' };
function moveLabel(t: (k: string) => string, m: string) { const k = MOVE_KEYS[m]; return k ? t(k) : m; }
function MovesView() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['inv-moves'], queryFn: () => api('/api/inventory/moves?limit=200') });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable
          rows={q.data.moves}
          rowKey={(r: any, i: number) => `${r.move_no}-${i}`}
          emptyState={{ icon: HistoryIcon, title: t('iv.led_moves_empty_title'), description: t('iv.led_moves_empty_desc') }}
          columns={[
            { key: 'move_no', label: t('dash.col_no') },
            { key: 'move_date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.move_date) },
            { key: 'move_type', label: t('iv.led_type'), render: (r: any) => <Badge variant="outline">{moveLabel(t, r.move_type)}</Badge> },
            { key: 'item_id', label: t('iv.led_item') },
            { key: 'qty', label: t('inv.col_qty'), align: 'right', render: (r: any) => <span className={cn('tabular', Number(r.qty) < 0 && 'text-destructive')}>{num(r.qty)}</span> },
            { key: 'total_cost', label: t('iv.led_value'), align: 'right', render: (r: any) => <span className="tabular">฿{num(r.total_cost)}</span> },
            { key: 'gl_entry_no', label: 'JE', render: (r: any) => r.gl_entry_no ?? '—' },
          ]}
        />
      )}
    </StateView>
  );
}

// ── helpers ──
function Field({ id, label, required, hint, children }: { id: string; label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required && <span className="ml-0.5 text-destructive" aria-hidden>*</span>}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function invalidateLedger(qc: ReturnType<typeof useQueryClient>) {
  for (const k of ['inv-valuation', 'inv-reconcile', 'inv-layers', 'inv-moves']) qc.invalidateQueries({ queryKey: [k] });
}
