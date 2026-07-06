'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Calculator, Plus, Tag, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht } from '@/lib/format';
import { cn } from '@/lib/utils';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const sel = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

// Enum value → i18n key. The raw value ([0]) is what we submit; [1] is an i18n key, rendered via t().
const TYPE_OPTS: [string, string][] = [['percent', 'hx.pr.type.percent'], ['amount', 'hx.pr.type.amount'], ['fixed', 'hx.pr.type.fixed'], ['bogo', 'hx.pr.type.bogo'], ['qty_break', 'hx.pr.type.qty_break']];
const SCOPE_OPTS: [string, string][] = [['item', 'hx.pr.scope.item'], ['category', 'hx.pr.scope.category'], ['all', 'hx.pr.scope.all']];
const CHANNEL_OPTS: [string, string][] = [['any', 'hx.pr.chan.any'], ['dine_in', 'hx.pr.chan.dine_in'], ['takeaway', 'hx.pr.chan.takeaway'], ['delivery', 'hx.pr.chan.delivery']];
// Returns the i18n key for the matching option (or the raw value as a fallback); call t() on the result.
const labelOf = (opts: [string, string][], v: string) => opts.find(([k]) => k === v)?.[1] ?? v;

/** Labelled form field — a label tied to its control, with an optional helper line. */
function Field({ label, htmlFor, hint, className, children }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function LabeledSelect({ id, value, onChange, options }: { id: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  const { t } = useLang();
  return (
    <select id={id} className={cn(sel, 'w-full')} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
    </select>
  );
}

export default function PricingPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('hx.pr.title')} description={t('hx.pr.desc')} />
      <Tabs tabs={[
        { key: 'rules', label: t('hx.pr.tab_rules'), content: <Rules /> },
        { key: 'quote', label: t('hx.pr.tab_quote'), content: <QuotePreview /> },
        { key: 'combo', label: t('hx.pr.tab_combo'), content: <Combos /> },
      ]} />
    </div>
  );
}

function Rules() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['price-rules'], queryFn: () => api('/api/pricing/rules') });
  const [f, setF] = useState<any>({ name: '', type: 'percent', scope: 'item', target_id: '', channel: 'any', dow: '', time_start: '', time_end: '', value: '', min_qty: '1', priority: '100', stackable: false });
  const set = (p: Record<string, unknown>) => setF((cur: any) => ({ ...cur, ...p }));
  const save = useMutation({
    mutationFn: () => api('/api/pricing/rules', { method: 'POST', body: JSON.stringify({ name: f.name, type: f.type, scope: f.scope, target_id: f.target_id || undefined, channel: f.channel, dow: f.dow || undefined, time_start: f.time_start || undefined, time_end: f.time_end || undefined, value: f.value ? Number(f.value) : 0, min_qty: Number(f.min_qty) || 1, priority: Number(f.priority) || 100, stackable: f.stackable }) }),
    // G6 (SoD R10): a new rule is staged inactive and needs a different user to activate it.
    onSuccess: () => { notifySuccess(t('hx.pr.rule_pending')); setF({ ...f, name: '', target_id: '', value: '' }); qc.invalidateQueries({ queryKey: ['price-rules'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/pricing/rules/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['price-rules'] }) });
  // G6 maker-checker: a different user activates/rejects a staged rule (API enforces author ≠ approver).
  const approve = useMutation({ mutationFn: (id: number) => api(`/api/pricing/rules/${id}/approve`, { method: 'POST' }), onSuccess: () => { notifySuccess(t('hx.pr.rule_activated')); qc.invalidateQueries({ queryKey: ['price-rules'] }); }, onError: (e: any) => notifyError(e.message) });
  const reject = useMutation({ mutationFn: (id: number) => api(`/api/pricing/rules/${id}/reject`, { method: 'POST', body: JSON.stringify({}) }), onSuccess: () => { notifySuccess(t('hx.pr.rule_rejected')); qc.invalidateQueries({ queryKey: ['price-rules'] }); }, onError: (e: any) => notifyError(e.message) });

  // The "value" field means different things per type — hint accordingly.
  const valueHint = f.type === 'percent' ? t('hx.pr.hint_percent')
    : f.type === 'amount' ? t('hx.pr.hint_amount') : f.type === 'fixed' ? t('hx.pr.hint_fixed') : t('hx.pr.hint_default');
  const targetDisabled = f.scope === 'all';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('hx.pr.add_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            onSubmit={(e) => { e.preventDefault(); if (f.name && !save.isPending) save.mutate(); }}
          >
            <Field label={<>{t('hx.pr.f_name')} <span className="text-destructive">*</span></>} htmlFor="pr-name" className="sm:col-span-2 lg:col-span-1">
              <Input id="pr-name" placeholder={t('hx.pr.name_ph')} value={f.name} onChange={(e) => set({ name: e.target.value })} required />
            </Field>
            <Field label={t('hx.pr.f_type')} htmlFor="pr-type">
              <LabeledSelect id="pr-type" value={f.type} onChange={(v) => set({ type: v })} options={TYPE_OPTS} />
            </Field>
            <Field label={t('hx.pr.f_scope')} htmlFor="pr-scope">
              <LabeledSelect id="pr-scope" value={f.scope} onChange={(v) => set({ scope: v })} options={SCOPE_OPTS} />
            </Field>
            <Field label={t('hx.pr.f_target')} htmlFor="pr-target" hint={targetDisabled ? t('hx.pr.target_all_hint') : undefined}>
              <Input id="pr-target" placeholder={t('hx.pr.target_ph')} value={f.target_id} disabled={targetDisabled} onChange={(e) => set({ target_id: e.target.value })} />
            </Field>
            <Field label={t('hx.pr.f_channel')} htmlFor="pr-channel">
              <LabeledSelect id="pr-channel" value={f.channel} onChange={(v) => set({ channel: v })} options={CHANNEL_OPTS} />
            </Field>
            <Field label={t('hx.pr.f_value')} htmlFor="pr-value" hint={valueHint}>
              <Input id="pr-value" type="number" inputMode="decimal" step="0.01" placeholder="0" value={f.value} onChange={(e) => set({ value: e.target.value })} />
            </Field>
            <Field label={t('hx.pr.f_minqty')} htmlFor="pr-minqty" hint={t('hx.pr.minqty_hint')}>
              <Input id="pr-minqty" type="number" inputMode="numeric" min={1} placeholder="1" value={f.min_qty} onChange={(e) => set({ min_qty: e.target.value })} />
            </Field>
            <Field label={t('hx.pr.f_dow')} htmlFor="pr-dow" hint={t('hx.pr.dow_hint')}>
              <Input id="pr-dow" placeholder={t('hx.pr.dow_ph')} value={f.dow} onChange={(e) => set({ dow: e.target.value })} />
            </Field>
            <Field label={t('hx.pr.f_tstart')} htmlFor="pr-tstart" hint={t('hx.pr.tstart_hint')}>
              <Input id="pr-tstart" type="time" value={f.time_start} onChange={(e) => set({ time_start: e.target.value })} />
            </Field>
            <Field label={t('hx.pr.f_tend')} htmlFor="pr-tend">
              <Input id="pr-tend" type="time" value={f.time_end} onChange={(e) => set({ time_end: e.target.value })} />
            </Field>
            <Field label={t('hx.pr.f_priority')} htmlFor="pr-priority" hint={t('hx.pr.priority_hint')}>
              <Input id="pr-priority" type="number" inputMode="numeric" placeholder="100" value={f.priority} onChange={(e) => set({ priority: e.target.value })} />
            </Field>
            <div className="flex items-end">
              <label className="flex h-9 items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-primary" checked={f.stackable} onChange={(e) => set({ stackable: e.target.checked })} />
                {t('hx.pr.stackable_label')}
              </label>
            </div>
          </form>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={!f.name || save.isPending} onClick={() => save.mutate()}>
              <Plus className="size-4" /> {save.isPending ? t('hx.common.saving') : t('hx.pr.save_rule')}
            </Button>
            {!f.name && <span className="text-xs text-muted-foreground">{t('hx.pr.name_required')}</span>}
          </div>
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.rules}
            rowKey={(r: any) => r.id}
            emptyState={{ icon: Tag, title: t('hx.pr.empty_title'), description: t('hx.pr.empty_desc') }}
            columns={[
              { key: 'name', label: t('hx.pr.col_name') },
              { key: 'type', label: t('hx.pr.col_type'), render: (r: any) => t(labelOf(TYPE_OPTS, r.type)) },
              { key: 'scope', label: t('hx.pr.col_scope'), render: (r: any) => t(labelOf(SCOPE_OPTS, r.scope)) },
              { key: 'target_id', label: t('hx.pr.col_target'), render: (r: any) => r.target_id || '—' },
              { key: 'channel', label: t('hx.pr.col_channel'), render: (r: any) => t(labelOf(CHANNEL_OPTS, r.channel)) },
              { key: 'value', label: t('hx.pr.col_value'), align: 'right', render: (r: any) => <span className="tabular">{r.value ?? '—'}</span> },
              { key: 'window', label: t('hx.pr.col_window'), render: (r: any) => r.time_start ? `${r.time_start}–${r.time_end}` : '—' },
              { key: 'stackable', label: t('hx.pr.col_stack'), align: 'center', render: (r: any) => r.stackable ? <Badge>{t('hx.pr.yes')}</Badge> : <span className="text-muted-foreground">—</span> },
              // G6 (SoD R10): a staged (PendingApproval) rule is inactive until a DIFFERENT user activates it.
              { key: 'status', label: t('hx.pr.col_status'), sortable: false, render: (r: any) => r.status === 'PendingApproval'
                ? <div className="flex items-center gap-1.5"><Badge variant="warning">{t('hx.pr.st_pending')}</Badge><Button size="sm" className="h-7" disabled={approve.isPending} onClick={() => approve.mutate(r.id)}>{t('hx.pr.approve')}</Button><Button size="sm" variant="outline" className="h-7" disabled={reject.isPending} onClick={() => reject.mutate(r.id)}>{t('hx.pr.reject')}</Button></div>
                : r.status === 'Rejected' ? <Badge variant="secondary">{t('hx.pr.st_rejected')}</Badge>
                : <Badge variant={r.active ? 'default' : 'secondary'}>{r.active ? t('hx.pr.st_active') : t('hx.pr.st_inactive')}</Badge> },
              { key: 'act', label: '', sortable: false, render: (r: any) => <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" aria-label={t('hx.pr.del_rule_aria', { name: r.name })} disabled={del.isPending} onClick={() => del.mutate(r.id)}><Trash2 className="size-4" /></Button> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

interface QLine { sku: string; qty: number; unit_price: number }
function QuotePreview() {
  const { t } = useLang();
  const [lines, setLines] = useState<QLine[]>([{ sku: '', qty: 1, unit_price: 0 }]);
  const [ctx, setCtx] = useState({ channel: 'any', party_size: '', service_charge_pct: '', rounding: '' });
  const [res, setRes] = useState<any>(null);
  const setLine = (i: number, p: Partial<QLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const run = useMutation({
    mutationFn: () => api('/api/pricing/quote', { method: 'POST', body: JSON.stringify({ channel: ctx.channel, party_size: ctx.party_size ? Number(ctx.party_size) : undefined, service_charge_pct: ctx.service_charge_pct ? Number(ctx.service_charge_pct) : undefined, rounding: ctx.rounding ? Number(ctx.rounding) : undefined, lines: lines.filter((l) => l.sku).map((l) => ({ sku: l.sku, qty: Number(l.qty), unit_price: Number(l.unit_price) })) }) }),
    onSuccess: (r: any) => { setRes(r); }, onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('hx.pr.quote_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="hidden grid-cols-[2fr_1fr_1fr_auto] gap-2 px-1 text-xs font-medium text-muted-foreground sm:grid">
              <span>SKU</span><span className="text-right">{t('hx.pr.qty')}</span><span className="text-right">{t('hx.pr.unit_price')}</span><span className="w-9" />
            </div>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-center">
                <Input className="col-span-2 sm:col-span-1" placeholder="SKU" aria-label={t('hx.pr.sku_aria', { n: i + 1 })} value={l.sku} onChange={(e) => setLine(i, { sku: e.target.value })} />
                <Input type="number" inputMode="numeric" className="text-right tabular" placeholder={t('hx.pr.qty')} aria-label={t('hx.pr.qty_aria', { n: i + 1 })} value={l.qty} onChange={(e) => setLine(i, { qty: +e.target.value })} />
                <Input type="number" inputMode="decimal" className="text-right tabular" placeholder={t('hx.pr.unit_price')} aria-label={t('hx.pr.unit_price_aria', { n: i + 1 })} value={l.unit_price} onChange={(e) => setLine(i, { unit_price: +e.target.value })} />
                <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" aria-label={t('hx.pr.del_line_aria', { n: i + 1 })} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
              </div>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, { sku: '', qty: 1, unit_price: 0 }])}><Plus className="size-4" /> {t('hx.pr.add_line')}</Button>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t('hx.pr.f_channel')} htmlFor="q-channel">
              <LabeledSelect id="q-channel" value={ctx.channel} onChange={(v) => setCtx({ ...ctx, channel: v })} options={CHANNEL_OPTS} />
            </Field>
            <Field label={t('hx.pr.f_party')} htmlFor="q-party" hint={t('hx.pr.party_hint')}>
              <Input id="q-party" type="number" inputMode="numeric" placeholder="—" value={ctx.party_size} onChange={(e) => setCtx({ ...ctx, party_size: e.target.value })} />
            </Field>
            <Field label={t('hx.pr.f_svc')} htmlFor="q-svc">
              <Input id="q-svc" type="number" inputMode="decimal" placeholder="—" value={ctx.service_charge_pct} onChange={(e) => setCtx({ ...ctx, service_charge_pct: e.target.value })} />
            </Field>
            <Field label={t('hx.pr.f_round')} htmlFor="q-round" hint={t('hx.pr.round_hint')}>
              <Input id="q-round" type="number" inputMode="decimal" placeholder="—" value={ctx.rounding} onChange={(e) => setCtx({ ...ctx, rounding: e.target.value })} />
            </Field>
          </div>
          <Button disabled={run.isPending || !lines.some((l) => l.sku)} onClick={() => run.mutate()}>
            <Calculator className="size-4" /> {run.isPending ? t('hx.pr.calculating') : t('hx.pr.calculate')}
          </Button>
        </CardContent>
      </Card>
      {res && (
        <Card className="gap-2 p-5">
          <DataTable
            rows={res.lines}
            rowKey={(r: any, i) => `${r.sku}-${i}`}
            columns={[
              { key: 'sku', label: 'SKU' },
              { key: 'qty', label: t('hx.pr.qty'), align: 'right', render: (r: any) => <span className="tabular">{r.qty}</span> },
              { key: 'gross', label: t('hx.pr.col_gross'), align: 'right', render: (r: any) => baht(r.gross) },
              { key: 'discount', label: t('hx.pr.col_discount'), align: 'right', render: (r: any) => baht(r.discount) },
              { key: 'net', label: t('hx.pr.col_net'), align: 'right', render: (r: any) => baht(r.net) },
              { key: 'applied_rules', label: t('hx.pr.col_applied'), render: (r: any) => (r.applied_rules || []).join(', ') || '—' },
            ]}
          />
          <div className="space-y-0.5 text-right text-sm">
            <div>{t('hx.pr.discount_summary', { line: baht(res.line_discount_total), order: baht(res.order_discount) })}</div>
            <div>{t('hx.pr.charge_summary', { service: baht(res.service_charge), rounding: baht(res.rounding_adjustment) })}</div>
            <div className="text-xl">{t('hx.pr.grand_total')} <strong>{baht(res.total)}</strong></div>
          </div>
        </Card>
      )}
    </div>
  );
}

function Combos() {
  const { t } = useLang();
  const [sku, setSku] = useState('');
  const [comps, setComps] = useState<{ component_sku: string; qty: number; unit_price_override?: number }[]>([{ component_sku: '', qty: 1 }]);
  const loaded = useQuery<any>({ queryKey: ['combo', sku], queryFn: () => api(`/api/pricing/combos/${sku}`), enabled: false });
  const save = useMutation({
    mutationFn: () => api(`/api/pricing/combos/${sku}`, { method: 'PUT', body: JSON.stringify({ components: comps.filter((c) => c.component_sku).map((c) => ({ component_sku: c.component_sku, qty: Number(c.qty), unit_price_override: c.unit_price_override != null ? Number(c.unit_price_override) : undefined })) }) }),
    onSuccess: (r: any) => notifySuccess(t('hx.pr.combo_saved', { sku: r.combo_sku, n: r.components })), onError: (e: any) => notifyError(e.message),
  });
  const setComp = (i: number, p: any) => setComps((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('hx.pr.combo_title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label={t('hx.pr.combo_sku')} htmlFor="cb-sku" className="w-full sm:max-w-[220px]">
            <Input id="cb-sku" placeholder={t('hx.pr.combo_sku_ph')} value={sku} onChange={(e) => setSku(e.target.value)} />
          </Field>
          <Button variant="outline" disabled={!sku} onClick={async () => { const r = await loaded.refetch(); if (r.data?.components?.length) setComps(r.data.components); }}>{t('hx.pr.load_combo')}</Button>
        </div>
        <div className="space-y-2">
          <div className="hidden grid-cols-[2fr_1fr_1fr_auto] gap-2 px-1 text-xs font-medium text-muted-foreground sm:grid">
            <span>{t('hx.pr.comp_sku')}</span><span className="text-right">{t('hx.pr.qty')}</span><span className="text-right">{t('hx.pr.price_opt')}</span><span className="w-9" />
          </div>
          {comps.map((c, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-center">
              <Input className="col-span-2 sm:col-span-1" placeholder={t('hx.pr.comp_sku')} aria-label={t('hx.pr.comp_sku_aria', { n: i + 1 })} value={c.component_sku} onChange={(e) => setComp(i, { component_sku: e.target.value })} />
              <Input type="number" inputMode="numeric" className="text-right tabular" placeholder={t('hx.pr.qty')} aria-label={t('hx.pr.comp_qty_aria', { n: i + 1 })} value={c.qty} onChange={(e) => setComp(i, { qty: +e.target.value })} />
              <Input type="number" inputMode="decimal" className="text-right tabular" placeholder={t('hx.pr.price_opt')} aria-label={t('hx.pr.comp_price_aria', { n: i + 1 })} value={c.unit_price_override ?? ''} onChange={(e) => setComp(i, { unit_price_override: e.target.value ? +e.target.value : undefined })} />
              <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" aria-label={t('hx.pr.del_comp_aria', { n: i + 1 })} onClick={() => setComps((cs) => cs.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setComps((cs) => [...cs, { component_sku: '', qty: 1 }])}><Plus className="size-4" /> {t('hx.pr.add_comp')}</Button>
          <Button disabled={!sku || save.isPending} onClick={() => save.mutate()}>{save.isPending ? t('hx.common.saving') : t('hx.pr.save_combo')}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
