'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, CalendarRange, Check, ClipboardCheck, Coins, FolderTree, Landmark, MapPin, Play, QrCode, ScanLine, SearchX, WifiOff, X } from 'lucide-react';
import { api, apiDownload } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
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
import { QrScanButton } from '@/components/qr-scanner';
import { submitScan, useOnline, useScanOutbox } from '@/lib/scan-outbox';
import { useLang } from '@/lib/i18n';

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function AssetsPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('mx.as_title')}
        description={t('mx.as_subtitle')}
      />
      <Tabs
        tabs={[
          { key: 'register', label: t('mx.as_tab_register'), content: <Register /> },
          { key: 'capitalize', label: t('mx.as_tab_capitalize'), content: <Capitalize /> },
          { key: 'qr', label: t('mx.as_tab_qr'), content: <QrTags /> },
          { key: 'audit', label: t('mx.as_tab_audit'), content: <AssetAudit /> },
          { key: 'custody', label: t('mx.as_tab_custody'), content: <CustodyApprovals /> },
          { key: 'categories', label: t('mx.as_tab_categories'), content: <Categories /> },
          { key: 'runs', label: t('mx.as_tab_runs'), content: <DepreciationRuns /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Register + per-asset schedule drill-in ─────────────────────────
function Register() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const q = useQuery<any>({
    queryKey: ['assets', status],
    queryFn: () => api(`/api/assets${status ? `?status=${status}` : ''}`),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {[
          { v: '', label: t('mx.as_filter_all') },
          { v: 'active', label: t('mx.as_filter_active') },
          { v: 'fully_depreciated', label: t('mx.as_filter_fully_depreciated') },
          { v: 'disposed', label: t('mx.as_filter_disposed') },
        ].map((f) => (
          <Button key={f.v} variant={status === f.v ? 'default' : 'outline'} size="sm" onClick={() => setStatus(f.v)}>
            {f.label}
          </Button>
        ))}
      </div>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('mx.as_stat_count')} value={num(q.data.count)} icon={Boxes} tone="primary" />
              <StatCard label={t('mx.as_stat_total_cost')} value={baht(q.data.total_cost)} icon={Coins} />
              <StatCard label={t('mx.as_stat_accum_dep')} value={baht(q.data.total_accum_dep)} tone="warning" />
              <StatCard label={t('mx.as_stat_nbv')} value={baht(q.data.total_nbv)} icon={Landmark} tone="success" />
            </div>

            <DataTable
              rows={q.data.assets}
              onRowClick={(r: any) => setSelected(r.asset_no)}
              columns={[
                { key: 'asset_no', label: t('mx.as_col_code') },
                { key: 'name', label: t('mx.as_col_asset_name') },
                { key: 'acquire_date', label: t('mx.as_col_acquire_date'), render: (r: any) => thaiDate(r.acquire_date) },
                { key: 'acquire_cost', label: t('mx.as_col_acquire_cost'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.acquire_cost)}</span> },
                { key: 'accumulated_depreciation', label: t('mx.as_col_accum_dep'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.accumulated_depreciation)}</span> },
                { key: 'net_book_value', label: t('mx.as_col_nbv'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.net_book_value)}</span> },
                { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              ]}
              emptyState={
                status
                  ? {
                      icon: SearchX,
                      title: t('mx.as_empty_filter_title'),
                      description: t('mx.as_empty_filter_desc'),
                      action: (
                        <Button variant="outline" size="sm" onClick={() => setStatus('')}>
                          {t('inv.clear_filter')}
                        </Button>
                      ),
                    }
                  : { icon: Boxes, title: t('mx.as_empty_title'), description: t('mx.as_empty_desc') }
              }
            />
          </div>
        )}
      </StateView>

      {selected && <ScheduleDrill assetNo={selected} onClose={() => setSelected(null)} />}
      {selected && <RevaluationPanel assetNo={selected} onChange={() => qc.invalidateQueries({ queryKey: ['assets'] })} />}
      {selected && q.data && <DisposalPanel asset={(q.data.assets ?? []).find((a: any) => a.asset_no === selected)} onChange={() => qc.invalidateQueries({ queryKey: ['assets'] })} />}
    </div>
  );
}

// Disposal with maker-checker (FA-09): a request posts a Draft JE + flags the asset disposal_pending; a
// DIFFERENT user must approve before it is effective (status → disposed). Requester self-approval → SOD.
function DisposalPanel({ asset, onChange }: { asset: any; onChange: () => void }) {
  const { t } = useLang();
  const [proceeds, setProceeds] = useState('');
  const refresh = () => onChange();
  if (!asset) return null;

  const request = useMutation({
    mutationFn: () => api<any>(`/api/assets/${asset.asset_no}/dispose`, { method: 'PATCH', body: JSON.stringify({ proceeds: Number(proceeds) || 0 }) }),
    onSuccess: (r: any) => { notifySuccess(t('mx.as_disp_requested', { result: r.gain_loss >= 0 ? t('mx.as_gain') : t('mx.as_loss'), amount: baht(Math.abs(r.gain_loss)) })); setProceeds(''); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const approve = useMutation({
    mutationFn: () => api<any>(`/api/assets/${asset.asset_no}/dispose/approve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('mx.as_disp_approved')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: () => api<any>(`/api/assets/${asset.asset_no}/dispose/reject`, { method: 'POST', body: JSON.stringify({ reason: window.prompt(t('mx.as_reject_reason_prompt')) || undefined }) }),
    onSuccess: () => { notifySuccess(t('mx.as_disp_rejected')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const busy = approve.isPending || reject.isPending;

  return (
    <Card className="gap-4 p-5">
      <h3 className="text-base font-semibold">{t('mx.as_disp_heading')} · {asset.asset_no}</h3>
      {asset.status === 'disposed' ? (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
          <Badge variant="secondary">{t('mx.as_disposed_badge')}</Badge> {t('mx.as_proceeds_received')} {baht(asset.disposal_proceeds)} · {asset.disposal_gain_loss >= 0 ? t('mx.as_gain') : t('mx.as_loss')} {baht(Math.abs(asset.disposal_gain_loss))}
          {asset.disposal_approved_by && <span className="text-muted-foreground"> · {t('mx.as_approved_by')} {asset.disposal_approved_by}</span>}
        </div>
      ) : asset.disposal_pending ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <Badge variant="warning">{t('mx.as_disp_pending_badge')}</Badge>
          <span>{t('mx.as_proceeds_received')} {baht(asset.disposal_proceeds)} · {asset.disposal_gain_loss >= 0 ? t('mx.as_gain') : t('mx.as_loss')} {baht(Math.abs(asset.disposal_gain_loss))} · {t('mx.as_requested_by')} {asset.disposal_requested_by}</span>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => approve.mutate()}>{t('fin.approve')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => reject.mutate()}>{t('mx.as_reject')}</Button>
          </div>
          <p className="w-full text-xs text-muted-foreground">{t('mx.as_disp_sod_note')}</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('mx.as_proceeds_label')}</Label><Input type="number" min="0" value={proceeds} onChange={(e) => setProceeds(e.target.value)} className="w-44" /></div>
          <span className="text-xs text-muted-foreground">{t('mx.as_current_nbv')} {baht(asset.net_book_value)}</span>
          <Button disabled={!proceeds || request.isPending} onClick={() => request.mutate()}>{t('mx.as_disp_submit')}</Button>
        </div>
      )}
    </Card>
  );
}

// Revaluation / impairment with maker-checker (FA-08): request defers the carrying-value change as a
// Draft; a DIFFERENT user approves before it is effective. Preparer self-approval → SOD_VIOLATION.
function RevaluationPanel({ assetNo, onChange }: { assetNo: string; onChange: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [newValue, setNewValue] = useState('');
  const [reason, setReason] = useState('');
  const q = useQuery<any>({ queryKey: ['asset-revals', assetNo], queryFn: () => api(`/api/assets/${assetNo}/revaluations`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['asset-revals', assetNo] }); onChange(); };
  const pending = (q.data?.revaluations ?? []).find((r: any) => r.status === 'PendingApproval');

  const request = useMutation({
    mutationFn: () => api<any>(`/api/assets/${assetNo}/revalue`, { method: 'POST', body: JSON.stringify({ new_value: Number(newValue), reason: reason || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(t('mx.as_reval_requested', { kind: r.kind === 'impairment' ? t('mx.as_impairment') : t('mx.as_uplift'), amount: baht(r.delta) })); setNewValue(''); setReason(''); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const approve = useMutation({
    mutationFn: () => api<any>(`/api/assets/${assetNo}/revalue/approve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('mx.as_reval_approved')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: () => api<any>(`/api/assets/${assetNo}/revalue/reject`, { method: 'POST', body: JSON.stringify({ reason: window.prompt(t('mx.as_reject_reason_prompt')) || undefined }) }),
    onSuccess: () => { notifySuccess(t('mx.as_reval_rejected')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const busy = approve.isPending || reject.isPending;

  return (
    <Card className="gap-4 p-5">
      <h3 className="text-base font-semibold">{t('mx.as_reval_heading')} · {assetNo}</h3>
      {pending ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <Badge variant="warning">{t('mx.as_pending_badge')}</Badge>
          <span>{pending.kind === 'impairment' ? t('mx.as_impairment') : t('mx.as_uplift')}: {baht(pending.old_value)} → {baht(pending.new_value)} · {t('mx.as_requested_by')} {pending.actioned_by}</span>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => approve.mutate()}>{t('fin.approve')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => reject.mutate()}>{t('mx.as_reject')}</Button>
          </div>
          <p className="w-full text-xs text-muted-foreground">{t('mx.as_reval_sod_note')}</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('mx.as_new_value_label')}</Label><Input type="number" min="0" value={newValue} onChange={(e) => setNewValue(e.target.value)} className="w-40" /></div>
          <div className="grid gap-1.5"><Label>{t('mx.as_reason_label')}</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} className="w-56" placeholder={t('mx.as_reason_placeholder')} /></div>
          <Button disabled={!newValue || request.isPending} onClick={() => request.mutate()}>{t('mx.as_submit_request')}</Button>
        </div>
      )}
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.revaluations}
            emptyState={{ title: t('mx.as_reval_empty') }}
            dense
            columns={[
              { key: 'reval_date', label: t('dash.col_date'), render: (r: any) => (r.reval_date ? thaiDate(r.reval_date) : '—') },
              { key: 'kind', label: t('mx.as_col_kind'), render: (r: any) => <Badge variant={r.kind === 'impairment' ? 'destructive' : 'success'}>{r.kind === 'impairment' ? t('mx.as_impairment') : t('mx.as_uplift')}</Badge> },
              { key: 'old_value', label: t('mx.as_col_old'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.old_value)}</span> },
              { key: 'new_value', label: t('mx.as_col_new'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.new_value)}</span> },
              { key: 'delta', label: t('mx.as_col_delta'), align: 'right', render: (r: any) => <span className={`tabular ${r.delta < 0 ? 'text-destructive' : 'text-success'}`}>{baht(r.delta)}</span> },
              { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={r.status === 'Posted' ? 'success' : r.status === 'Rejected' ? 'destructive' : 'warning'}>{r.status === 'Posted' ? t('mx.as_status_posted') : r.status === 'Rejected' ? t('mx.as_status_rejected') : t('mx.as_status_pending')}</Badge> },
              { key: 'by', label: t('mx.as_col_by'), render: (r: any) => <span className="text-xs text-muted-foreground">{r.actioned_by ?? '—'}{r.approved_by ? ` → ${r.approved_by}` : ''}</span> },
            ]}
          />
        )}
      </StateView>
    </Card>
  );
}

function ScheduleDrill({ assetNo, onClose }: { assetNo: string; onClose: () => void }) {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['asset-schedule', assetNo], queryFn: () => api(`/api/assets/${assetNo}/schedule`) });
  return (
    <Card className="gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{t('mx.as_schedule_heading')} · {assetNo}</h3>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground">
              {q.data.asset?.name} · {t('mx.as_useful_life')} {num(q.data.asset?.useful_life_months)} {t('mx.as_months')} · {t('mx.as_cost')} {baht(q.data.asset?.acquire_cost)}
            </div>
            <DataTable
              rows={q.data.schedule}
              columns={[
                { key: 'period', label: t('mx.as_col_period') },
                { key: 'amount', label: t('mx.as_col_depreciation'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'accumulated_after', label: t('mx.as_col_accum_after'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.accumulated_after)}</span> },
                { key: 'nbv_after', label: t('mx.as_col_nbv_after'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.nbv_after)}</span> },
              ]}
              emptyState={{ title: t('mx.as_schedule_empty') }}
              dense
            />
          </div>
        )}
      </StateView>
    </Card>
  );
}

// ───────────────────────── Procure-to-Capitalize: register an asset from a GR (FA-10) ─────────────────────────
// A capital goods-receipt line is capitalised onto the asset register via a maker-checker request: a preparer
// raises it (no GL), and a DIFFERENT user approves before the asset + acquisition JE are created.
function Capitalize() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [grNo, setGrNo] = useState('');
  const [lookup, setLookup] = useState('');
  const [form, setForm] = useState<{ gr_item_id: number; name: string; life: string } | null>(null);

  const elig = useQuery<any>({ queryKey: ['fa-eligible', lookup], queryFn: () => api(`/api/assets/registrations/eligible?gr_no=${encodeURIComponent(lookup)}`), enabled: !!lookup });
  const queue = useQuery<any>({ queryKey: ['fa-registrations'], queryFn: () => api('/api/assets/registrations?status=PendingApproval') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['fa-eligible'] }); qc.invalidateQueries({ queryKey: ['fa-registrations'] }); qc.invalidateQueries({ queryKey: ['assets'] }); };

  const register = useMutation({
    mutationFn: (b: any) => api<any>('/api/assets/registrations', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: (r: any) => { notifySuccess(t('mx.as_cap_requested', { regNo: r.reg_no, amount: baht(r.acquire_cost) })); setForm(null); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const approve = useMutation({
    mutationFn: (regNo: string) => api<any>(`/api/assets/registrations/${regNo}/approve`, { method: 'POST' }),
    onSuccess: (r: any) => { notifySuccess(t('mx.as_cap_approved', { assetNo: r.asset_no })); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (regNo: string) => api<any>(`/api/assets/registrations/${regNo}/reject`, { method: 'POST', body: JSON.stringify({ reason: window.prompt(t('mx.as_reject_reason_prompt')) || undefined }) }),
    onSuccess: () => { notifySuccess(t('mx.as_cap_rejected')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('mx.as_cap_search_heading')}</h3>
        <p className="text-sm text-muted-foreground">{t('mx.as_cap_search_desc')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5"><Label htmlFor="gr-no">{t('mx.as_gr_no_label')}</Label><Input id="gr-no" placeholder="GR-YYYYMMDD-NNN" value={grNo} onChange={(e) => setGrNo(e.target.value)} className="w-56" /></div>
          <Button disabled={!grNo} onClick={() => setLookup(grNo.trim())}>{t('mx.as_search')}</Button>
        </div>
      </Card>

      {lookup && (
        <StateView q={elig}>
          {elig.data && (
            <Card className="gap-3 p-5">
              <h3 className="text-base font-semibold">{t('mx.as_cap_eligible_heading')} · {elig.data.gr_no} <span className="text-sm font-normal text-muted-foreground">(PO {elig.data.po_no})</span></h3>
              <DataTable
                rows={elig.data.eligible}
                emptyState={{ icon: Boxes, title: t('mx.as_cap_eligible_empty_title'), description: t('mx.as_cap_eligible_empty_desc') }}
                dense
                columns={[
                  { key: 'item_id', label: t('mx.as_col_item_id') },
                  { key: 'item_description', label: t('mx.as_col_description') },
                  { key: 'received_qty', label: t('mx.as_col_received'), align: 'right', render: (r: any) => <span className="tabular">{num(r.received_qty)}</span> },
                  { key: 'unit_cost', label: t('mx.as_col_unit_cost'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.unit_cost)}</span> },
                  { key: 'suggested_cost', label: t('mx.as_col_total_value'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.suggested_cost)}</span> },
                  { key: 'act', label: '', align: 'right', render: (r: any) => <Button size="sm" variant="outline" onClick={() => setForm({ gr_item_id: r.gr_item_id, name: r.item_description || r.item_id, life: '60' })}>{t('mx.as_capitalize_action')}</Button> },
                ]}
              />
              {form && (
                <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-muted/40 p-3">
                  <div className="grid gap-1.5"><Label>{t('mx.as_asset_name_label')}</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-64" /></div>
                  <div className="grid gap-1.5"><Label>{t('mx.as_life_months_label')}</Label><Input type="number" min="1" value={form.life} onChange={(e) => setForm({ ...form, life: e.target.value })} className="w-36" /></div>
                  <Button disabled={!form.name || !form.life || register.isPending} onClick={() => register.mutate({ gr_no: elig.data.gr_no, gr_item_id: form.gr_item_id, name: form.name, useful_life_months: Number(form.life) })}>{t('mx.as_submit_request')}</Button>
                  <Button variant="ghost" onClick={() => setForm(null)}>{t('fin.cancel')}</Button>
                </div>
              )}
            </Card>
          )}
        </StateView>
      )}

      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('mx.as_cap_queue_heading')}</h3>
        <p className="text-xs text-muted-foreground">{t('mx.as_cap_queue_sod_note')}</p>
        <StateView q={queue}>
          {queue.data && (
            <DataTable
              rows={queue.data.registrations}
              emptyState={{ icon: Landmark, title: t('mx.as_cap_queue_empty') }}
              dense
              columns={[
                { key: 'reg_no', label: t('mx.as_col_reg_no') },
                { key: 'name', label: t('mx.as_col_asset_name') },
                { key: 'gr_no', label: t('mx.as_col_gr_po'), render: (r: any) => <span className="text-xs text-muted-foreground">{r.gr_no}{r.po_no ? ` · ${r.po_no}` : ''}</span> },
                { key: 'acquire_cost', label: t('mx.as_col_value'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.acquire_cost)}</span> },
                { key: 'useful_life_months', label: t('mx.as_col_life_months'), align: 'right', render: (r: any) => <span className="tabular">{num(r.useful_life_months)}</span> },
                { key: 'requested_by', label: t('mx.as_col_requested_by'), render: (r: any) => <span className="text-xs text-muted-foreground">{r.requested_by ?? '—'}</span> },
                { key: 'act', label: '', align: 'right', render: (r: any) => (
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="outline" disabled={approve.isPending} onClick={() => approve.mutate(r.reg_no)}>{t('fin.approve')}</Button>
                    <Button size="sm" variant="ghost" disabled={reject.isPending} onClick={() => reject.mutate(r.reg_no)}>{t('mx.as_reject')}</Button>
                  </div>
                ) },
              ]}
            />
          )}
        </StateView>
      </Card>
    </div>
  );
}

// ───────────────────────── QR asset tags + scan-to-update ─────────────────────────
function QrTags() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['assets', ''], queryFn: () => api('/api/assets') });
  const [assetNo, setAssetNo] = useState('');
  const single = useQuery<any>({
    queryKey: ['asset-qr', assetNo],
    queryFn: () => api(`/api/assets/${assetNo}/qr`),
    enabled: !!assetNo,
  });
  const [busy, setBusy] = useState(false);

  const [scanCode, setScanCode] = useState('');
  const [scanLoc, setScanLoc] = useState('');
  const scan = useMutation({
    mutationFn: () => api<any>('/api/assets/scan-update', { method: 'POST', body: JSON.stringify({ code: scanCode, location: scanLoc || undefined }) }),
    onSuccess: (r: any) => {
      // FA-11: a move is now a maker-checker request; confirming the same location is an instant verification.
      if (r.status === 'pending') notifySuccess(t('mx.as_custody_requested', { assetNo: r.asset_no, location: r.to_location ?? '—', reqNo: r.request_no }));
      else notifySuccess(t('mx.as_scan_verified', { assetNo: r.asset_no, location: r.location ?? '—' }));
      setScanCode(''); setScanLoc(''); qc.invalidateQueries({ queryKey: ['assets'] }); qc.invalidateQueries({ queryKey: ['asset-custody'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  async function downloadLabels() {
    setBusy(true);
    try { await apiDownload('/api/assets/qr/labels', 'asset_tags.pdf'); }
    catch (e: any) { notifyError(e.message); }
    finally { setBusy(false); }
  }

  const assets = q.data?.assets ?? [];

  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('mx.as_qr_print_heading')}</h3>
        <p className="text-sm text-muted-foreground">{t('mx.as_qr_print_desc')}</p>
        <div>
          <Button disabled={busy} onClick={downloadLabels}><QrCode className="size-4" /> {busy ? t('mx.as_generating') : t('mx.as_qr_download_all')}</Button>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="gap-3 p-5">
          <h3 className="text-base font-semibold">{t('mx.as_qr_single_heading')}</h3>
          <div className="grid gap-1.5 max-w-sm">
            <Label htmlFor="qr-asset">{t('mx.as_asset_label')}</Label>
            <select id="qr-asset" className={selectCls} value={assetNo} onChange={(e) => setAssetNo(e.target.value)}>
              <option value="">{t('mx.as_select_option')}</option>
              {assets.map((a: any) => <option key={a.asset_no} value={a.asset_no}>{a.asset_no} — {a.name}</option>)}
            </select>
          </div>
          {single.data?.data_url && (
            <div className="flex flex-col items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={single.data.data_url} alt="QR" width={200} height={200} />
              <code className="break-all text-center text-xs text-muted-foreground">{single.data.payload}</code>
            </div>
          )}
        </Card>

        <Card className="gap-3 p-5">
          <h3 className="text-base font-semibold">{t('mx.as_scan_heading')}</h3>
          <p className="text-sm text-muted-foreground">{t('mx.as_scan_desc')}</p>
          <div className="grid gap-1.5">
            <Label htmlFor="scan-code">{t('mx.as_scan_code_label')}</Label>
            <div className="flex items-center gap-2">
              <Input id="scan-code" className="flex-1" placeholder="ASSET_ID:FA-0001|…" value={scanCode} onChange={(e) => setScanCode(e.target.value)} />
              <QrScanButton onScan={setScanCode} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="scan-loc">{t('mx.as_scan_loc_label')}</Label>
            <Input id="scan-loc" placeholder={t('mx.as_scan_loc_placeholder')} value={scanLoc} onChange={(e) => setScanLoc(e.target.value)} />
          </div>
          <div>
            <Button disabled={!scanCode || scan.isPending} onClick={() => scan.mutate()}><ScanLine className="size-4" /> {scan.isPending ? t('mx.as_updating') : t('mx.as_update')}</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ───────────────────────── Asset audit (physical count by scan) ─────────────────────────
function AssetAudit() {
  const { t } = useLang();
  const qc = useQueryClient();
  const online = useOnline();
  const outbox = useScanOutbox();
  const [loc, setLoc] = useState('');
  const [auditNo, setAuditNo] = useState('');
  const [scanCode, setScanCode] = useState('');
  const [lastResult, setLastResult] = useState<string>('');

  const recent = useQuery<any>({ queryKey: ['asset-audits'], queryFn: () => api('/api/assets/audits?limit=20'), enabled: !auditNo });
  const audit = useQuery<any>({ queryKey: ['asset-audit', auditNo], queryFn: () => api(`/api/assets/audits/${auditNo}`), enabled: !!auditNo });

  const open = useMutation({
    mutationFn: () => api<any>('/api/assets/audits', { method: 'POST', body: JSON.stringify({ location: loc || undefined }) }),
    onSuccess: (r) => { setAuditNo(r.audit_no); notifySuccess(t('mx.as_audit_opened', { no: r.audit_no, n: r.expected_count })); },
    onError: (e: any) => notifyError(e.message),
  });
  const close = useMutation({
    mutationFn: () => api<any>(`/api/assets/audits/${auditNo}/close`, { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('mx.as_audit_closed', { n: r.custody_requests_raised })); setAuditNo(''); qc.invalidateQueries({ queryKey: ['asset-custody'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  async function doScan(code: string) {
    if (!code || !auditNo) return;
    setScanCode('');
    const r = await submitScan(`/api/assets/audits/${auditNo}/scan`, { code }, `audit ${auditNo}`);
    outbox.refresh();
    if (r.queued) { setLastResult(t('mx.as_audit_queued')); }
    else { const res: any = r.result; setLastResult(`${res?.asset_no ?? code} · ${res?.result ?? ''}`); qc.invalidateQueries({ queryKey: ['asset-audit', auditNo] }); }
  }

  if (!auditNo) {
    return (
      <div className="space-y-4">
        <Card className="max-w-md gap-3 p-5">
          <h3 className="text-base font-semibold">{t('mx.as_audit_new')}</h3>
          <p className="text-sm text-muted-foreground">{t('mx.as_audit_desc')}</p>
          <div className="grid gap-1.5">
            <Label htmlFor="audit-loc">{t('mx.as_audit_location')}</Label>
            <Input id="audit-loc" placeholder={t('mx.as_audit_location_ph')} value={loc} onChange={(e) => setLoc(e.target.value)} />
          </div>
          <Button disabled={open.isPending} onClick={() => open.mutate()}><ClipboardCheck className="size-4" /> {t('mx.as_audit_start')}</Button>
        </Card>
        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('mx.as_audit_recent')}</h3>
          <StateView q={recent}>
            {recent.data && (
              <DataTable
                rows={recent.data.audits}
                columns={[
                  { key: 'audit_no', label: t('dash.col_no') },
                  { key: 'location', label: t('mx.as_audit_location'), render: (r: any) => r.location ?? t('mx.as_audit_all_loc') },
                  { key: 'expected_count', label: t('mx.as_audit_expected'), align: 'right' },
                  { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                  { key: 'act', label: '', render: (r: any) => r.status === 'Open' ? <Button size="sm" variant="outline" onClick={() => setAuditNo(r.audit_no)}>{t('mx.as_audit_resume')}</Button> : <Button size="sm" variant="ghost" onClick={() => setAuditNo(r.audit_no)}>{t('iv.stk_view')}</Button> },
                ]}
                emptyState={{ icon: ClipboardCheck, title: t('mx.as_audit_empty') }}
              />
            )}
          </StateView>
        </div>
      </div>
    );
  }

  const sum = audit.data?.summary ?? { found: 0, missing: 0, misplaced: 0, unknown: 0 };
  const isOpen = audit.data?.status === 'Open';
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">{auditNo} · {audit.data?.location ?? t('mx.as_audit_all_loc')}</h3>
          <div className="flex items-center gap-2">
            {!online && <Badge variant="warning"><WifiOff className="mr-1 size-3" /> {t('qr.offline')}</Badge>}
            {outbox.count > 0 && <Badge variant="info">{t('qr.pending_sync', { n: outbox.count })}</Badge>}
            <Button variant="ghost" size="sm" onClick={() => setAuditNo('')}>{t('iv.stk_close')}</Button>
            {isOpen && <Button variant="default" disabled={close.isPending} onClick={() => close.mutate()}><PackageCheckIcon /> {t('mx.as_audit_finish')}</Button>}
          </div>
        </div>
        {isOpen && (
          <div className="flex items-center gap-2">
            <Input className="flex-1" placeholder="ASSET_ID:FA-0001|…" value={scanCode} onChange={(e) => setScanCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') doScan(scanCode); }} />
            <Button variant="outline" onClick={() => doScan(scanCode)}>{t('iv.scan_add')}</Button>
            <QrScanButton continuous onScan={doScan} />
          </div>
        )}
        {lastResult && <p className="text-sm text-muted-foreground"><ScanLine className="mr-1 inline size-4" />{lastResult}</p>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label={t('mx.as_audit_found')} value={String(sum.found)} icon={Check} />
          <StatCard label={t('mx.as_audit_missing')} value={String(sum.missing)} icon={SearchX} />
          <StatCard label={t('mx.as_audit_misplaced')} value={String(sum.misplaced)} icon={MapPin} />
          <StatCard label={t('mx.as_audit_unknown')} value={String(sum.unknown)} icon={Boxes} />
        </div>
      </Card>
      <StateView q={audit}>
        {audit.data && (audit.data.missing.length > 0 || audit.data.misplaced.length > 0) && (
          <Card className="gap-3 p-5">
            {audit.data.misplaced.length > 0 && (
              <div>
                <h4 className="mb-2 text-sm font-semibold text-warning">{t('mx.as_audit_misplaced')} ({audit.data.misplaced.length})</h4>
                <DataTable rows={audit.data.misplaced} columns={[{ key: 'asset_no', label: t('mx.as_asset_label') }, { key: 'register_location', label: t('mx.as_audit_reg_loc') }]} />
                <p className="mt-1 text-xs text-muted-foreground">{t('mx.as_audit_misplaced_note')}</p>
              </div>
            )}
            {audit.data.missing.length > 0 && (
              <div>
                <h4 className="mb-2 text-sm font-semibold text-destructive">{t('mx.as_audit_missing')} ({audit.data.missing.length})</h4>
                <DataTable rows={audit.data.missing} columns={[{ key: 'asset_no', label: t('mx.as_asset_label') }, { key: 'name', label: t('mx.as_asset_name_label') }]} />
              </div>
            )}
          </Card>
        )}
      </StateView>
    </div>
  );
}

function PackageCheckIcon() { return <ClipboardCheck className="size-4" />; }

// ───────────────────────── Custody-change approvals (FA-11 maker-checker) ─────────────────────────
function CustodyApprovals() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['asset-custody'], queryFn: () => api('/api/assets/custody?status=PendingApproval') });
  const approve = useMutation({
    mutationFn: (reqNo: string) => api<any>(`/api/assets/custody/${reqNo}/approve`, { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('mx.as_custody_approved', { assetNo: r.asset_no, location: r.location ?? '—' })); qc.invalidateQueries({ queryKey: ['asset-custody'] }); qc.invalidateQueries({ queryKey: ['assets'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (reqNo: string) => api<any>(`/api/assets/custody/${reqNo}/reject`, { method: 'POST', body: JSON.stringify({ reason: 'rejected' }) }),
    onSuccess: () => { notifySuccess(t('mx.as_custody_rejected')); qc.invalidateQueries({ queryKey: ['asset-custody'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('mx.as_custody_sod_note')}</p>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.requests}
            columns={[
              { key: 'request_no', label: t('dash.col_no') },
              { key: 'asset_no', label: t('mx.as_asset_label') },
              { key: 'move', label: t('mx.as_custody_move'), render: (r: any) => <span className="text-sm">{r.from_location ?? '—'} → <b>{r.to_location ?? '—'}</b></span> },
              { key: 'source', label: t('mx.as_custody_source'), render: (r: any) => <Badge variant={r.source === 'audit' ? 'info' : 'secondary'}>{r.source}</Badge> },
              { key: 'requested_by', label: t('mx.as_custody_requested_by') },
              { key: 'act', label: '', render: (r: any) => (
                <div className="flex justify-end gap-2">
                  <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate(r.request_no)}><Check className="size-4" /> {t('mx.as_cap_approve')}</Button>
                  <Button size="sm" variant="outline" disabled={reject.isPending} onClick={() => reject.mutate(r.request_no)}><X className="size-4" /> {t('mx.as_cap_reject')}</Button>
                </div>
              ) },
            ]}
            emptyState={{ icon: ClipboardCheck, title: t('mx.as_custody_empty'), description: t('mx.as_custody_empty_desc') }}
          />
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── Categories ─────────────────────────
function Categories() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['asset-categories'], queryFn: () => api('/api/assets/categories') });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <StatCard label={t('mx.as_cat_count')} value={num(q.data.count)} icon={Boxes} tone="primary" className="max-w-xs" />
          <DataTable
            rows={q.data.categories}
            columns={[
              { key: 'code', label: t('mx.as_col_code') },
              { key: 'name', label: t('mx.as_col_category_name') },
              { key: 'default_useful_life_years', label: t('mx.as_col_life_years'), align: 'right', render: (r: any) => <span className="tabular">{num(r.default_useful_life_years)}</span> },
              { key: 'asset_account', label: t('mx.as_col_asset_account') },
              { key: 'accum_dep_account', label: t('mx.as_col_accum_dep_account') },
              { key: 'dep_expense_account', label: t('mx.as_col_dep_expense_account') },
            ]}
            emptyState={{ icon: FolderTree, title: t('mx.as_cat_empty_title'), description: t('mx.as_cat_empty_desc') }}
          />
        </div>
      )}
    </StateView>
  );
}

// ───────────────────────── Depreciation runs + run action ─────────────────────────
function DepreciationRuns() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['dep-runs'], queryFn: () => api('/api/assets/depreciation/runs') });
  const [period, setPeriod] = useState('2026-06');

  const run = useMutation({
    mutationFn: () => api<any>('/api/assets/depreciation/run', { method: 'POST', body: JSON.stringify({ period }) }),
    onSuccess: (r) => {
      if (r.already) notifySuccess(t('mx.as_run_already', { period }));
      else if (!r.asset_count) notifySuccess(t('mx.as_run_none', { period }));
      else notifySuccess(t('mx.as_run_done', { count: num(r.asset_count), total: baht(r.total_depreciation), runs: r.runs?.length ?? 1 }));
      qc.invalidateQueries({ queryKey: ['dep-runs'] });
      qc.invalidateQueries({ queryKey: ['assets'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-5">
      <Card className="gap-4 p-5">
        <h3 className="text-base font-semibold">{t('mx.as_run_heading')}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="dep-period">{t('mx.as_period_label')}</Label>
            <input id="dep-period" className={`${selectCls} max-w-[160px]`} value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-06" />
          </div>
          <Button disabled={run.isPending || !/^\d{4}-\d{2}$/.test(period)} onClick={() => run.mutate()}>
            <Play className="size-4" /> {run.isPending ? t('mx.as_computing') : t('mx.as_run_action')}
          </Button>
        </div>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.runs}
            columns={[
              { key: 'run_no', label: t('mx.as_col_run_no') },
              { key: 'period', label: t('mx.as_col_period') },
              { key: 'asset_count', label: t('mx.as_col_asset_count'), align: 'right', render: (r: any) => <span className="tabular">{num(r.asset_count)}</span> },
              { key: 'total_depreciation', label: t('mx.as_col_total_dep'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.total_depreciation)}</span> },
              { key: 'journal_no', label: t('mx.as_col_journal_no'), render: (r: any) => r.journal_no ?? '—' },
              { key: 'posted_at', label: t('mx.as_col_posted_at'), render: (r: any) => thaiDate(r.posted_at) },
            ]}
            emptyState={{ icon: CalendarRange, title: t('mx.as_run_empty_title'), description: t('mx.as_run_empty_desc') }}
          />
        )}
      </StateView>
    </div>
  );
}
