'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, PauseCircle, ScrollText, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { baht, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { ConfirmDialog } from '@/components/confirm-dialog';
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
import { DocSelect } from '@/components/doc-select';


const ACTION_OPTS: string[] = ['void', 'discount', 'price_override', 'no_sale', 'return'];
const APPLIES_OPTS: string[] = ['all', 'void', 'discount', 'price_override', 'no_sale', 'return', 'refund', 'paid_out'];

function Field({ label, htmlFor, hint, className, children }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function PosControlPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('px.ctrl_page_title')} description={t('px.ctrl_page_desc')} />
      <Tabs tabs={[
        { key: 'held', label: t('px.ctrl_tab_held'), content: <Held /> },
        { key: 'override', label: t('px.ctrl_tab_override'), content: <Overrides /> },
        { key: 'discount', label: t('px.ctrl_tab_discount'), content: <DiscountAuthority /> },
        { key: 'reasons', label: t('px.ctrl_tab_reasons'), content: <ReasonCodes /> },
        { key: 'audit', label: t('px.ctrl_tab_audit'), content: <AuditLog /> },
      ]} />
    </div>
  );
}

// docs/52 Phase 4b — discount authority: set the cashier discount caps + issue a supervisor authorization
// code (OVR-…) for an over-cap discount. Both maintained by the supervisor duty (pos_refund/exec).
// A cap field with an explicit "no limit" toggle — so leaving a blank field can't SILENTLY grant a cashier
// unlimited self-discount; unlimited must be ticked on purpose (fail-safe default is a real, entered cap).
function CapField({ id, label, unlimited, value, onUnlimited, onValue }: { id: string; label: string; unlimited: boolean; value: string; onUnlimited: (v: boolean) => void; onValue: (v: string) => void }) {
  const { t } = useLang();
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex items-center gap-2">
        <Input id={id} type="number" inputMode="decimal" min={0} max={100} placeholder="0" value={unlimited ? '' : value} disabled={unlimited} onChange={(e) => onValue(e.target.value)} className={cn(unlimited && 'opacity-50')} />
        <label className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
          <input type="checkbox" className="size-4 accent-primary" checked={unlimited} onChange={(e) => onUnlimited(e.target.checked)} />
          {t('px.disc_unlimited')}
        </label>
      </div>
    </Field>
  );
}

function DiscountAuthority() {
  const { t } = useLang();
  const qc = useQueryClient();
  const caps = useQuery<{ maxLinePct: number | null; maxBillPct: number | null }>({ queryKey: ['pos-discount-settings'], queryFn: () => api('/api/pos/discount-settings') });
  const [line, setLine] = useState('');
  const [bill, setBill] = useState('');
  const [lineUnlimited, setLineUnlimited] = useState(false);
  const [billUnlimited, setBillUnlimited] = useState(false);
  // hydrate the inputs once the current caps load (null cap ⇒ the "no limit" box is already ticked)
  const capsData = caps.data;
  const [seeded, setSeeded] = useState(false);
  if (capsData && !seeded) {
    setSeeded(true);
    setLine(capsData.maxLinePct != null ? String(capsData.maxLinePct) : '');
    setBill(capsData.maxBillPct != null ? String(capsData.maxBillPct) : '');
    setLineUnlimited(capsData.maxLinePct == null);
    setBillUnlimited(capsData.maxBillPct == null);
  }
  const capValid = (unlimited: boolean, v: string) => unlimited || (v !== '' && Number(v) >= 0 && Number(v) <= 100);
  const capsSavable = capValid(lineUnlimited, line) && capValid(billUnlimited, bill);
  const saveCaps = useMutation({
    mutationFn: () => api('/api/pos/discount-settings', { method: 'PUT', body: JSON.stringify({ max_line_discount_pct: lineUnlimited ? null : Number(line), max_bill_discount_pct: billUnlimited ? null : Number(bill) }) }),
    onSuccess: () => { notifySuccess(t('px.disc_caps_saved')); qc.invalidateQueries({ queryKey: ['pos-discount-settings'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const [maxPct, setMaxPct] = useState('');
  const [reason, setReason] = useState('');
  const [issued, setIssued] = useState<{ override_no: string; max_pct: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const overrides = useQuery<{ overrides: any[] }>({ queryKey: ['pos-overrides'], queryFn: () => api('/api/pos/overrides?limit=20') });
  // just the supervisor-issued discount authorizations (action=discount WITH an authorized %) — newest first.
  const issuedCodes = (overrides.data?.overrides ?? []).filter((o) => o.action === 'discount' && o.authorized_pct != null);
  const authorize = useMutation({
    mutationFn: () => api<{ override_no: string; max_pct: number }>('/api/pos/discount-authorize', { method: 'POST', body: JSON.stringify({ max_pct: Number(maxPct), reason: reason || undefined }) }),
    onSuccess: (r) => { setIssued({ override_no: r.override_no, max_pct: r.max_pct }); setCopied(false); setMaxPct(''); setReason(''); qc.invalidateQueries({ queryKey: ['pos-overrides'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const copyCode = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { notifyError(t('px.disc_copy_failed')); }
  };
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">{t('px.disc_caps_title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('px.disc_caps_desc')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <CapField id="dc-line" label={t('px.disc_cap_line')} unlimited={lineUnlimited} value={line} onUnlimited={setLineUnlimited} onValue={setLine} />
            <CapField id="dc-bill" label={t('px.disc_cap_bill')} unlimited={billUnlimited} value={bill} onUnlimited={setBillUnlimited} onValue={setBill} />
          </div>
          <Button disabled={saveCaps.isPending || !capsSavable} onClick={() => saveCaps.mutate()}>{saveCaps.isPending ? t('hx.common.saving') : t('px.disc_caps_save')}</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">{t('px.disc_auth_title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('px.disc_auth_desc')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('px.disc_auth_maxpct')} htmlFor="da-pct">
              <Input id="da-pct" type="number" inputMode="decimal" min={0} max={100} placeholder="0" value={maxPct} onChange={(e) => setMaxPct(e.target.value)} />
            </Field>
            <Field label={t('px.disc_auth_reason')} htmlFor="da-reason">
              <Input id="da-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
          <Button disabled={!maxPct || Number(maxPct) <= 0 || authorize.isPending} onClick={() => authorize.mutate()}>
            <ShieldCheck className="size-4" /> {authorize.isPending ? t('hx.common.saving') : t('px.disc_auth_btn')}
          </Button>
          {/* the freshly-issued code, front-and-centre + one-tap copy so the supervisor can hand it over reliably */}
          {issued && (
            <div className="rounded-md border border-success/40 bg-success/10 p-3">
              <p className="text-xs text-muted-foreground">{t('px.disc_issued_hint', { pct: issued.max_pct })}</p>
              <div className="mt-1.5 flex items-center gap-3">
                <span className="font-mono text-xl font-semibold tracking-wide">{issued.override_no}</span>
                <Button size="sm" variant="outline" onClick={() => copyCode(issued.override_no)}>
                  <ClipboardList className="size-4" /> {copied ? t('px.disc_copied') : t('px.disc_copy')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">{t('px.disc_recent_title')}</CardTitle></CardHeader>
        <CardContent>
          <StateView q={overrides}>
            <DataTable
              rows={issuedCodes}
              rowKey={(r: any) => r.override_no}
              emptyState={{ icon: ShieldCheck, title: t('px.disc_recent_empty'), description: t('px.disc_recent_empty_desc') }}
              columns={[
                { key: 'override_no', label: t('px.disc_recent_code'), render: (r: any) => <span className="font-mono">{r.override_no}</span> },
                { key: 'authorized_pct', label: t('px.disc_recent_upto'), align: 'right', render: (r: any) => `${r.authorized_pct}%` },
                { key: 'approved_by', label: t('px.disc_recent_by'), render: (r: any) => r.approved_by || '—' },
                { key: 'created_at', label: t('px.disc_recent_when'), render: (r: any) => thaiDate(r.created_at) },
                { key: 'used', label: t('px.disc_recent_status'), sortable: false, render: (r: any) => r.sale_no
                  ? <Badge variant="secondary">{t('px.disc_recent_used', { no: r.sale_no })}</Badge>
                  : <Badge variant="success">{t('px.disc_recent_unused')}</Badge> },
              ]}
            />
          </StateView>
        </CardContent>
      </Card>
    </div>
  );
}

function ReasonCodes() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['reason-codes'], queryFn: () => api('/api/pos/audit/reason-codes') });
  const [f, setF] = useState({ code: '', label: '', applies_to: 'all' });
  const APPLIES_LABELS: Record<string, string> = { all: t('px.ctrl_applies_all'), void: t('px.ctrl_applies_void'), discount: t('px.ctrl_applies_discount'), price_override: t('px.ctrl_applies_price_override'), no_sale: t('px.ctrl_applies_no_sale'), return: t('px.ctrl_applies_return'), refund: t('px.ctrl_applies_refund'), paid_out: t('px.ctrl_applies_paid_out') };
  const appliesLabel = (v: string) => APPLIES_LABELS[v] ?? v;
  const save = useMutation({
    mutationFn: () => api('/api/pos/audit/reason-codes', { method: 'POST', body: JSON.stringify({ code: f.code, label: f.label, applies_to: f.applies_to }) }),
    onSuccess: () => { notifySuccess(t('px.ctrl_saved')); setF({ code: '', label: '', applies_to: 'all' }); qc.invalidateQueries({ queryKey: ['reason-codes'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/pos/audit/reason-codes/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['reason-codes'] }) });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">{t('px.ctrl_add_reason')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('px.ctrl_code')} htmlFor="rc-code"><Input id="rc-code" placeholder={t('px.ctrl_code_ph')} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
            <Field label={t('px.ctrl_desc')} htmlFor="rc-label"><Input id="rc-label" placeholder={t('px.ctrl_reason_label_ph')} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
            <Field label={t('px.ctrl_applies_to')} htmlFor="rc-applies">
              <Select id="rc-applies"  value={f.applies_to} onChange={(e) => setF({ ...f, applies_to: e.target.value })}>{APPLIES_OPTS.map((v) => <option key={v} value={v}>{appliesLabel(v)}</option>)}</Select>
            </Field>
          </div>
          <Button disabled={!f.code || !f.label || save.isPending} onClick={() => save.mutate()}>{save.isPending ? t('px.ctrl_saving') : t('fin.save')}</Button>
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.reason_codes} rowKey={(r: any) => r.id} columns={[
          { key: 'code', label: t('px.ctrl_code') }, { key: 'label', label: t('px.ctrl_desc') },
          { key: 'applies_to', label: t('px.ctrl_applies_to'), render: (r: any) => appliesLabel(r.applies_to) },
          { key: 'act', label: '', sortable: false, render: (r: any) => <Button size="sm" variant="destructive" disabled={del.isPending} onClick={() => del.mutate(r.id)}>{t('px.ctrl_disable')}</Button> },
        ]} emptyState={{ icon: ClipboardList, title: t('px.ctrl_reason_empty_title'), description: t('px.ctrl_reason_empty_desc') }} />}
      </StateView>
    </div>
  );
}

function AuditLog() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['pos-audit'], queryFn: () => api('/api/pos/audit?limit=100') });
  return (
    <StateView q={q}>
      {q.data && <DataTable rows={q.data.entries} columns={[
        { key: 'ts', label: t('px.ctrl_col_time'), render: (r: any) => thaiDate(r.ts) },
        { key: 'actor', label: t('px.ctrl_col_actor') },
        { key: 'action', label: t('px.ctrl_col_action'), render: (r: any) => <Badge variant={statusVariant('open')}>{r.action}</Badge> },
        { key: 'entity_id', label: t('px.ctrl_col_ref') },
        { key: 'meta', label: t('px.ctrl_col_reason_approver'), render: (r: any) => r.meta ? `${r.meta.reason_code ?? ''} ${r.meta.approved_by ? '· ' + r.meta.approved_by : ''}`.trim() || '—' : '—' },
      ]} emptyState={{ icon: ScrollText, title: t('px.ctrl_audit_empty_title'), description: t('px.ctrl_audit_empty_desc') }} />}
    </StateView>
  );
}

function Held() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['held'], queryFn: () => api('/api/pos/held') });
  const [discardAsk, setDiscardAsk] = useState<string | null>(null);
  const act = useMutation({ mutationFn: (v: { no: string; op: string }) => api(`/api/pos/held/${v.no}/${v.op}`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['held'] }), onError: (e: any) => notifyError(e.message) });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable
          rows={q.data.held}
          rowKey={(r: any) => r.hold_no}
          columns={[
            { key: 'hold_no', label: t('dash.col_no') },
            { key: 'label', label: t('px.ctrl_col_label_table') },
            { key: 'customer_name', label: t('fin.col_customer'), render: (r: any) => r.customer_name || '—' },
            { key: 'created_by', label: t('px.ctrl_col_held_by') },
            { key: 'created_at', label: t('px.ctrl_col_time'), render: (r: any) => thaiDate(r.created_at) },
            { key: 'act', label: '', sortable: false, render: (r: any) => <div className="flex gap-1"><Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ no: r.hold_no, op: 'recall' })}>{t('px.ctrl_recall')}</Button><Button size="sm" variant="destructive" onClick={() => setDiscardAsk(r.hold_no)}>{t('px.ctrl_discard')}</Button></div> },
          ]}
          emptyState={{ icon: PauseCircle, title: t('px.ctrl_held_empty_title'), description: t('px.ctrl_held_empty_desc') }}
        />
      )}
      <ConfirmDialog
        open={!!discardAsk}
        onOpenChange={(o) => !o && setDiscardAsk(null)}
        title={discardAsk ? t('px.ctrl_discard_confirm', { no: discardAsk }) : ''}
        busy={act.isPending}
        onConfirm={() => { if (discardAsk) act.mutate({ no: discardAsk, op: 'discard' }); setDiscardAsk(null); }}
      />
    </StateView>
  );
}

function Overrides() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['overrides'], queryFn: () => api('/api/pos/overrides') });
  const [f, setF] = useState({ action: 'discount', sale_no: '', amount: '', reason: '', approved_by: '' });
  const [msg, setMsg] = useState('');
  const [voidAsk, setVoidAsk] = useState(false);
  // Recent POS sales — the bill is picked from a dropdown, not typed (manual escape kept).
  const salesQ = useQuery<any>({ queryKey: ['pos-sales-for-picker'], queryFn: () => api('/api/pos/orders?limit=50'), retry: false });
  const saleOptions = (salesQ.data?.orders ?? []).map((o: any) => ({ value: o.Sale_No, label: [o.Status, baht(o.Total)].filter(Boolean).join(' · ') || undefined }));
  const isVoid = f.action === 'void';
  const ACTION_LABELS: Record<string, string> = { void: t('px.ctrl_action_void'), discount: t('px.ctrl_action_discount'), price_override: t('px.ctrl_action_price_override'), no_sale: t('px.ctrl_action_no_sale'), return: t('px.ctrl_action_return') };
  const actionLabel = (v: string) => ACTION_LABELS[v] ?? v;
  const create = useMutation({
    mutationFn: () => api('/api/pos/override', { method: 'POST', body: JSON.stringify({ action: f.action, sale_no: f.sale_no || undefined, amount: f.amount ? Number(f.amount) : undefined, reason: f.reason || undefined, approved_by: f.approved_by || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(t('px.ctrl_saved_no', { no: r.override_no })); setF({ action: 'discount', sale_no: '', amount: '', reason: '', approved_by: '' }); qc.invalidateQueries({ queryKey: ['overrides'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">{t('px.ctrl_record_override')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('px.ctrl_type')} htmlFor="ov-action">
              <Select id="ov-action"  value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}>{ACTION_OPTS.map((v) => <option key={v} value={v}>{actionLabel(v)}</option>)}</Select>
            </Field>
            <Field label={t('px.ctrl_bill_no')} htmlFor="ov-sale"><DocSelect id="ov-sale" value={f.sale_no} onValueChange={(v) => setF({ ...f, sale_no: v })} options={saleOptions} placeholder={t('common.doc_select_ph')} emptyText={t('common.doc_none')} allowManual manualPlaceholder="SALE-…" /></Field>
            <Field label={t('px.ctrl_amount_baht')} htmlFor="ov-amt"><Input id="ov-amt" type="number" inputMode="decimal" placeholder="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label={<>{t('px.ctrl_reason')} {isVoid && <span className="text-destructive">*</span>}</>} htmlFor="ov-reason"><Input id="ov-reason" placeholder={t('px.ctrl_reason_ph')} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
            <Field label={<>{t('px.ctrl_approver')} {isVoid && <span className="text-destructive">*</span>}</>} htmlFor="ov-appr"><Input id="ov-appr" placeholder={t('px.ctrl_approver_ph')} value={f.approved_by} onChange={(e) => setF({ ...f, approved_by: e.target.value })} /></Field>
          </div>
          {isVoid && <p className="text-xs text-muted-foreground">{t('px.ctrl_void_hint_pre')} <strong>{t('px.ctrl_reason')}</strong> {t('px.ctrl_void_hint_and')} <strong>{t('px.ctrl_approver')}</strong> {t('px.ctrl_void_hint_post')}</p>}
          <Button disabled={create.isPending} onClick={() => {
            setMsg('');
            // A void reverses a sale — require a reason + approver and confirm before recording.
            if (f.action === 'void') {
              if (!f.reason.trim() || !f.approved_by.trim()) { setMsg('❌ ' + t('px.ctrl_void_need_reason_approver')); return; }
              setVoidAsk(true);
              return;
            }
            create.mutate();
          }}>{create.isPending ? t('px.ctrl_saving') : t('fin.save')}</Button>
          <ConfirmDialog
            open={voidAsk}
            onOpenChange={setVoidAsk}
            title={t('px.ctrl_void_confirm', { no: f.sale_no || t('px.ctrl_unspecified') })}
            busy={create.isPending}
            onConfirm={() => { setVoidAsk(false); create.mutate(); }}
          />
          {msg && <Msg ok={msg.startsWith('✅')}>{msg}</Msg>}
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.overrides}
            rowKey={(r: any) => r.override_no}
            columns={[
              { key: 'override_no', label: t('dash.col_no') },
              { key: 'action', label: t('px.ctrl_col_action'), render: (r: any) => actionLabel(r.action) },
              { key: 'sale_no', label: t('px.ctrl_col_bill'), render: (r: any) => r.sale_no || '—' },
              { key: 'amount', label: t('inv.col_qty'), align: 'right', render: (r: any) => r.amount != null ? <span className="tabular">{baht(r.amount)}</span> : '—' },
              { key: 'reason', label: t('px.ctrl_reason'), render: (r: any) => r.reason || '—' },
              { key: 'requested_by', label: t('px.ctrl_col_requested_by') },
              { key: 'approved_by', label: t('px.ctrl_col_approved_by'), render: (r: any) => r.approved_by || '—' },
            ]}
            emptyState={{ icon: ShieldCheck, title: t('px.ctrl_override_empty_title'), description: t('px.ctrl_override_empty_desc') }}
          />
        )}
      </StateView>
    </div>
  );
}
