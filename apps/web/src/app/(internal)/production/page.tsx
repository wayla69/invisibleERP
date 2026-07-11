'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Play, ClipboardCheck, Network, Route, ListChecks, ClipboardList, FileText, Gauge } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLang } from '@/lib/i18n';
import { Select } from '@/components/form-controls';
import { DocSelect } from '@/components/doc-select';


export default function ProductionPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('mf.prod_title')} description={t('mf.prod_desc')} />
      <Tabs tabs={[
        { key: 'routings', label: t('mf.prod_tab_routings'), content: <Routings /> },
        { key: 'shopfloor', label: t('mf.prod_tab_shopfloor'), content: <ShopFloor /> },
        { key: 'qa', label: t('mf.prod_tab_qa'), content: <Quality /> },
        { key: 'mrp', label: t('mf.prod_tab_mrp'), content: <Mrp /> },
      ]} />
    </div>
  );
}

// ───────────── Routings ─────────────
type Op = { op_no: string; work_center: string; description: string; setup_min: string; run_min_per_unit: string; labor_rate: string };
const emptyOp = (): Op => ({ op_no: '', work_center: '', description: '', setup_min: '', run_min_per_unit: '', labor_rate: '' });
function Routings() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['routings'], queryFn: () => api('/api/routings') });
  const [code, setCode] = useState('');
  const [product, setProduct] = useState('');
  const [ops, setOps] = useState<Op[]>([emptyOp()]);
  const create = useMutation({
    mutationFn: () => api('/api/routings', { method: 'POST', body: JSON.stringify({
      routing_code: code, product_item_id: product || undefined,
      operations: ops.filter((o) => o.op_no).map((o) => ({ op_no: Number(o.op_no), work_center: o.work_center || undefined, description: o.description || undefined, setup_min: Number(o.setup_min) || 0, run_min_per_unit: Number(o.run_min_per_unit) || 0, labor_rate: Number(o.labor_rate) || 0 })),
    }) }),
    onSuccess: () => { notifySuccess(t('mf.prod_routing_saved')); setCode(''); setProduct(''); setOps([emptyOp()]); qc.invalidateQueries({ queryKey: ['routings'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const setOp = (i: number, p: Partial<Op>) => setOps((a) => a.map((o, j) => (j === i ? { ...o, ...p } : o)));
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('mf.prod_routing_create')}</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('mf.prod_routing_code')}</Label><Input value={code} onChange={(e) => setCode(e.target.value)} className="w-40" /></div>
          <div className="grid gap-1.5"><Label>{t('mf.col_product')}</Label><Input value={product} onChange={(e) => setProduct(e.target.value)} className="w-40" /></div>
        </div>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-muted-foreground"><th className="pb-2 font-medium">{t('mf.prod_col_seq')}</th><th className="pb-2 font-medium">{t('mf.prod_col_workcenter')}</th><th className="pb-2 font-medium">{t('mf.prod_col_job')}</th><th className="pb-2 font-medium">{t('mf.prod_col_setup')}</th><th className="pb-2 font-medium">{t('mf.prod_col_minperunit')}</th><th className="pb-2 font-medium">{t('mf.prod_col_laborrate')}</th></tr></thead>
          <tbody>
            {ops.map((o, i) => (
              <tr key={i}>
                <td className="py-1 pr-2"><Input type="number" value={o.op_no} onChange={(e) => setOp(i, { op_no: e.target.value })} className="w-16" /></td>
                <td className="py-1 pr-2"><Input value={o.work_center} onChange={(e) => setOp(i, { work_center: e.target.value })} /></td>
                <td className="py-1 pr-2"><Input value={o.description} onChange={(e) => setOp(i, { description: e.target.value })} /></td>
                <td className="py-1 pr-2"><Input type="number" value={o.setup_min} onChange={(e) => setOp(i, { setup_min: e.target.value })} className="w-20" /></td>
                <td className="py-1 pr-2"><Input type="number" value={o.run_min_per_unit} onChange={(e) => setOp(i, { run_min_per_unit: e.target.value })} className="w-20" /></td>
                <td className="py-1 pr-2"><Input type="number" value={o.labor_rate} onChange={(e) => setOp(i, { labor_rate: e.target.value })} className="w-24" /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setOps((a) => [...a, emptyOp()])}><Plus className="size-4" /> {t('mf.prod_add_op')}</Button>
          <Button onClick={() => create.mutate()} disabled={!code || create.isPending}>{t('fin.save')}</Button>
        </div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.routings} columns={[{ key: 'routing_code', label: t('mf.col_code') }, { key: 'product_item_id', label: t('mf.col_product') }, { key: 'name', label: t('mf.col_name') }]} emptyState={{ icon: Route, title: t('mf.prod_routing_empty_title'), description: t('mf.prod_routing_empty_desc') }} />}</StateView>
    </div>
  );
}

// ───────────── Shop-floor ─────────────
function ShopFloor() {
  const { t } = useLang();
  const [woNo, setWoNo] = useState('');
  const [routing, setRouting] = useState('');
  // Pending lists — the WO and routing are picked from dropdowns, not typed.
  const wosQ = useQuery<any>({ queryKey: ['wos-for-picker'], queryFn: () => api('/api/manufacturing/work-orders'), retry: false });
  const woOptions = (wosQ.data?.work_orders ?? []).map((w: any) => ({ value: w.wo_no, label: [w.product_name, w.status].filter(Boolean).join(' · ') || undefined }));
  const routingsQ = useQuery<any>({ queryKey: ['routings-for-picker'], queryFn: () => api('/api/routings'), retry: false });
  const routingOptions = (routingsQ.data?.routings ?? []).map((r: any) => ({ value: r.routing_code, label: r.name || r.product_item_id || undefined }));
  const q = useQuery<any>({ queryKey: ['wo-ops', woNo], queryFn: () => api(`/api/manufacturing/work-orders/${woNo}/operations`), enabled: false });
  const gen = useMutation({
    mutationFn: () => api(`/api/manufacturing/work-orders/${woNo}/routing/${routing}`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => { notifySuccess(t('mf.prod_ops_created')); q.refetch(); }, onError: (e: any) => notifyError(e.message),
  });
  const report = useMutation({
    mutationFn: (p: { opNo: number; completed: number; scrap: number }) => api(`/api/manufacturing/work-orders/${woNo}/operations/${p.opNo}/report`, { method: 'POST', body: JSON.stringify({ completed_qty: p.completed, scrap_qty: p.scrap }) }),
    onSuccess: () => { notifySuccess(t('mf.prod_progress_saved')); q.refetch(); }, onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('mf.prod_wono_label')}</Label><DocSelect className="w-64" value={woNo} onValueChange={setWoNo} options={woOptions} placeholder={t('common.doc_select_ph')} emptyText={t('common.doc_none')} allowManual manualPlaceholder="WO-..." /></div>
          <Button variant="outline" onClick={() => q.refetch()} disabled={!woNo}>{t('mf.prod_view_ops')}</Button>
          <div className="grid gap-1.5"><Label>{t('mf.prod_gen_from_routing')}</Label><DocSelect className="w-56" value={routing} onValueChange={setRouting} options={routingOptions} placeholder={t('common.doc_select_ph')} emptyText={t('common.doc_none')} allowManual manualPlaceholder="RT-..." /></div>
          <Button onClick={() => gen.mutate()} disabled={!woNo || !routing}><Network className="size-4" /> {t('mf.prod_gen_ops')}</Button>
        </div>
      </Card>
      {q.data && (
        <DataTable rows={q.data.operations} columns={[
          { key: 'op_no', label: t('mf.prod_col_seq') }, { key: 'work_center', label: t('mf.prod_col_workcenter') }, { key: 'description', label: t('mf.prod_col_job') },
          { key: 'planned_qty', label: t('mf.prod_col_plan'), align: 'right' }, { key: 'completed_qty', label: t('mf.prod_col_done'), align: 'right' }, { key: 'scrap_qty', label: t('mf.prod_col_scrap'), align: 'right' },
          { key: 'labor_cost', label: t('mf.prod_col_labor'), align: 'right', render: (r: any) => baht(r.labor_cost) }, { key: 'status', label: t('fin.col_status') },
          { key: 'act', label: t('mf.prod_col_report'), sortable: false, render: (r: any) => <ReportBtn onReport={(c, sc) => report.mutate({ opNo: r.op_no, completed: c, scrap: sc })} /> },
        ]} emptyState={{ icon: ListChecks, title: t('mf.prod_ops_empty_title'), description: t('mf.prod_ops_empty_desc') }} />
      )}
    </div>
  );
}
function ReportBtn({ onReport }: { onReport: (completed: number, scrap: number) => void }) {
  const { t } = useLang();
  const [c, setC] = useState(''); const [s, setS] = useState('');
  return (
    <div className="flex items-center gap-1">
      <Input type="number" value={c} onChange={(e) => setC(e.target.value)} placeholder={t('mf.prod_col_done')} className="h-8 w-16" />
      <Input type="number" value={s} onChange={(e) => setS(e.target.value)} placeholder={t('mf.prod_col_scrap')} className="h-8 w-16" />
      <Button size="sm" variant="outline" onClick={() => { onReport(Number(c) || 0, Number(s) || 0); setC(''); setS(''); }}>OK</Button>
    </div>
  );
}

// ───────────── Quality ─────────────
function Quality() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['qa'], queryFn: () => api('/api/quality') });
  const [f, setF] = useState({ ref_type: 'WO', ref_doc: '', item_id: '', qty_inspected: '', qty_passed: '', disposition: 'Accept', unit_cost: '' });
  // Ref-doc pending list — source switches with the WO/GR type toggle.
  const qaWosQ = useQuery<any>({ queryKey: ['wos-for-picker'], queryFn: () => api('/api/manufacturing/work-orders'), retry: false, enabled: f.ref_type === 'WO' });
  const qaGrsQ = useQuery<any>({ queryKey: ['grs-for-picker'], queryFn: () => api('/api/procurement/grs?limit=100'), retry: false, enabled: f.ref_type === 'GR' });
  const refOptions = f.ref_type === 'WO'
    ? (qaWosQ.data?.work_orders ?? []).map((w: any) => ({ value: w.wo_no, label: [w.product_name, w.status].filter(Boolean).join(' · ') || undefined }))
    : (qaGrsQ.data?.grs ?? []).map((g: any) => ({ value: g.gr_no, label: [g.po_no, g.vendor_name].filter(Boolean).join(' · ') || undefined }));
  const ins = useMutation({
    mutationFn: () => api('/api/quality/inspect', { method: 'POST', body: JSON.stringify({ ref_type: f.ref_type, ref_doc: f.ref_doc || undefined, item_id: f.item_id || undefined, qty_inspected: Number(f.qty_inspected) || 0, qty_passed: Number(f.qty_passed) || 0, disposition: f.disposition, unit_cost: Number(f.unit_cost) || 0 }) }),
    onSuccess: (r: any) => { notifySuccess(r.scrap_value > 0 ? t('mf.qa_scrap_recorded', { amt: baht(r.scrap_value), entry: r.entry_no }) : t('mf.qa_recorded')); qc.invalidateQueries({ queryKey: ['qa'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('mf.qa_form_title')}</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5"><Label>{t('mf.col_type')}</Label><Select value={f.ref_type} onChange={(e) => setF({ ...f, ref_type: e.target.value, ref_doc: '' })}><option value="WO">{t('mf.qa_ref_wo')}</option><option value="GR">{t('mf.qa_ref_gr')}</option></Select></div>
          <div className="grid gap-1.5"><Label>{t('mf.qa_ref_doc')}</Label><DocSelect value={f.ref_doc} onValueChange={(v) => setF({ ...f, ref_doc: v })} options={refOptions} placeholder={t('common.doc_select_ph')} emptyText={t('common.doc_none')} allowManual /></div>
          <div className="grid gap-1.5"><Label>{t('mf.col_product')}</Label><Input value={f.item_id} onChange={(e) => setF({ ...f, item_id: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('mf.qa_inspected_label')}</Label><Input type="number" value={f.qty_inspected} onChange={(e) => setF({ ...f, qty_inspected: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('mf.qa_passed')}</Label><Input type="number" value={f.qty_passed} onChange={(e) => setF({ ...f, qty_passed: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>{t('mf.qa_disposition')}</Label><Select value={f.disposition} onChange={(e) => setF({ ...f, disposition: e.target.value })}><option value="Accept">{t('mf.qa_disp_accept')}</option><option value="Rework">{t('mf.qa_disp_rework')}</option><option value="Quarantine">{t('mf.qa_disp_quarantine')}</option><option value="Scrap">{t('mf.qa_disp_scrap')}</option></Select></div>
          {f.disposition === 'Scrap' && <div className="grid gap-1.5"><Label>{t('mf.col_unit_cost')}</Label><Input type="number" value={f.unit_cost} onChange={(e) => setF({ ...f, unit_cost: e.target.value })} /></div>}
        </div>
        <div className="flex items-center gap-3"><Button onClick={() => ins.mutate()} disabled={!f.qty_inspected || ins.isPending}><ClipboardCheck className="size-4" /> {t('fin.save')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.inspections} columns={[
        { key: 'insp_no', label: t('dash.col_no') }, { key: 'ref_type', label: t('mf.col_type') }, { key: 'ref_doc', label: t('mf.col_ref') }, { key: 'item_id', label: t('mf.col_product') },
        { key: 'qty_inspected', label: t('mf.qa_col_inspected'), align: 'right' }, { key: 'qty_failed', label: t('mf.qa_col_failed'), align: 'right' }, { key: 'disposition', label: t('mf.qa_col_result') },
        { key: 'scrap_value', label: t('mf.qa_col_scrap_value'), align: 'right', render: (r: any) => baht(r.scrap_value) },
      ]} emptyState={{ icon: ClipboardList, title: t('mf.qa_empty_title'), description: t('mf.qa_empty_desc') }} />}</StateView>
    </div>
  );
}

// ───────────── MRP ─────────────
type Dem = { item_id: string; qty: string };
type Wc = { code: string; available_minutes: string };
function Mrp() {
  const { t } = useLang();
  const [rows, setRows] = useState<Dem[]>([{ item_id: '', qty: '' }]);
  const [lotSizing, setLotSizing] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [prNo, setPrNo] = useState<string | null>(null);

  // Rough-cut capacity (RCCP) — work centres + available minutes, run against the same demand
  const [wcs, setWcs] = useState<Wc[]>([{ code: '', available_minutes: '' }]);
  const [cap, setCap] = useState<any>(null);

  const demand = () => rows.filter((r) => r.item_id && r.qty).map((r) => ({ item_id: r.item_id, qty: Number(r.qty) }));

  const run = useMutation({
    mutationFn: () => api<any>('/api/mrp/run', { method: 'POST', body: JSON.stringify({ demand: demand(), lot_sizing: lotSizing }) }),
    onSuccess: (r) => { setRes(r); setPrNo(null); notifySuccess(t('mf.mrp_planned', { make: r.summary.make_orders, buy: r.summary.buy_orders })); }, onError: (e: any) => notifyError(e.message),
  });
  const planToPr = useMutation({
    mutationFn: () => api<any>('/api/mrp/plan-to-pr', { method: 'POST', body: JSON.stringify({ demand: demand(), lot_sizing: lotSizing }) }),
    onSuccess: (r) => {
      setRes({ planned_make: r.planned_make, planned_buy: r.planned_buy, summary: r.summary });
      setPrNo(r.pr_no ?? null);
      notifySuccess(r.pr_no ? t('mf.mrp_pr_created', { pr: r.pr_no }) : t('mf.mrp_pr_none'));
    },
    onError: (e: any) => notifyError(e.message),
  });
  const capacity = useMutation({
    mutationFn: () => api<any>('/api/mrp/capacity', {
      method: 'POST',
      body: JSON.stringify({ demand: demand(), work_centers: wcs.filter((w) => w.code).map((w) => ({ code: w.code, available_minutes: Number(w.available_minutes) || 0 })) }),
    }),
    onSuccess: (r) => { setCap(r); notifySuccess(t('mf.mrp_cap_ok', { n: r.summary.centers, over: r.summary.overloaded })); }, onError: (e: any) => notifyError(e.message),
  });

  const setRow = (i: number, p: Partial<Dem>) => setRows((a) => a.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const setWc = (i: number, p: Partial<Wc>) => setWcs((a) => a.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const hasDemand = demand().length > 0;
  const buyCols: any[] = [
    { key: 'item_id', label: t('mf.col_material') },
    { key: 'gross_qty', label: t('mf.mrp_col_gross'), align: 'right' },
    { key: 'on_hand', label: t('mf.mrp_col_onhand'), align: 'right' },
    { key: 'qty', label: t('mf.mrp_col_toorder'), align: 'right', render: (r: any) => <span className="tabular">{num(r.ordered_qty ?? r.qty)}</span> },
  ];
  if (lotSizing) buyCols.push({ key: 'lot_policy', label: t('mf.mrp_col_lot'), render: (r: any) => (r.lot_policy ? <Badge variant="secondary">{r.lot_policy}</Badge> : '—') });

  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('mf.mrp_demand_title')}</h3>
        {rows.map((r, i) => (
          <div key={i} className="flex gap-3">
            <Input placeholder={t('mf.mrp_item_ph')} value={r.item_id} onChange={(e) => setRow(i, { item_id: e.target.value })} className="w-56" />
            <Input type="number" placeholder={t('inv.col_qty')} value={r.qty} onChange={(e) => setRow(i, { qty: e.target.value })} className="w-32" />
          </div>
        ))}
        <label className="flex w-fit items-center gap-2 text-sm">
          <input type="checkbox" checked={lotSizing} onChange={(e) => setLotSizing(e.target.checked)} className="size-4" />
          {t('mf.mrp_lot_sizing')}
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setRows((a) => [...a, { item_id: '', qty: '' }])}><Plus className="size-4" /> {t('mf.add')}</Button>
          <Button onClick={() => run.mutate()} disabled={run.isPending || !hasDemand}><Play className="size-4" /> {t('mf.mrp_run')}</Button>
          <Button variant="outline" onClick={() => planToPr.mutate()} disabled={planToPr.isPending || !hasDemand}><FileText className="size-4" /> {t('mf.mrp_plan_to_pr')}</Button>
          {prNo && <Badge variant="success">{t('mf.mrp_pr_badge', { pr: prNo })}</Badge>}
        </div>
      </Card>
      {res && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="gap-2 p-5"><h4 className="font-semibold">{t('mf.mrp_make_title')}</h4><DataTable rows={res.planned_make} columns={[{ key: 'item_id', label: t('mf.col_product') }, { key: 'qty', label: t('inv.col_qty'), align: 'right' }]} emptyState={{ title: t('mf.mrp_no_make') }} /></Card>
          <Card className="gap-2 p-5"><h4 className="font-semibold">{t('mf.mrp_buy_title')}</h4><DataTable rows={res.planned_buy} columns={buyCols} emptyState={{ title: t('mf.mrp_no_buy') }} /></Card>
        </div>
      )}

      {/* Rough-cut capacity (RCCP) */}
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('mf.mrp_capacity_title')}</h3>
        <p className="text-sm text-muted-foreground">{t('mf.mrp_capacity_hint')}</p>
        {wcs.map((w, i) => (
          <div key={i} className="flex gap-3">
            <Input placeholder={t('mf.mrp_wc_code')} value={w.code} onChange={(e) => setWc(i, { code: e.target.value })} className="w-56" />
            <Input type="number" placeholder={t('mf.mrp_wc_minutes')} value={w.available_minutes} onChange={(e) => setWc(i, { available_minutes: e.target.value })} className="w-40" />
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setWcs((a) => [...a, { code: '', available_minutes: '' }])}><Plus className="size-4" /> {t('mf.mrp_add_wc')}</Button>
          <Button onClick={() => capacity.mutate()} disabled={capacity.isPending || !hasDemand}><Gauge className="size-4" /> {t('mf.mrp_capacity_run')}</Button>
        </div>
        {cap && (
          <DataTable
            rows={cap.work_centers}
            rowKey={(r: any) => r.work_center}
            columns={[
              { key: 'work_center', label: t('mf.mrp_wc_code') },
              { key: 'load_minutes', label: t('mf.mrp_col_load'), align: 'right', render: (r: any) => <span className="tabular">{num(r.load_minutes)}</span> },
              { key: 'available_minutes', label: t('mf.mrp_col_avail'), align: 'right', render: (r: any) => <span className="tabular">{r.available_minutes == null ? '—' : num(r.available_minutes)}</span> },
              { key: 'utilization_pct', label: t('mf.mrp_col_util'), align: 'right', render: (r: any) => (r.utilization_pct == null ? '—' : <span className="tabular">{num(r.utilization_pct)}%</span>) },
              { key: 'overloaded', label: t('mf.mrp_col_over'), render: (r: any) => <Badge variant={r.overloaded ? 'destructive' : 'success'}>{r.overloaded ? t('mf.mrp_over_yes') : t('mf.mrp_over_no')}</Badge> },
            ]}
            emptyState={{ icon: Gauge, title: t('mf.mrp_capacity_title'), description: t('mf.mrp_cap_empty') }}
          />
        )}
      </Card>
    </div>
  );
}
