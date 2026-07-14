'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Check, X, FileText, SlidersHorizontal, Printer, Mail, Package } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/form-controls';
import { statusVariant } from '@/components/ui';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

// GET /api/cpq/quotes → { quotes: [...], count }
interface Quote { id: number; quote_no: string; customer_name: string; status: string; issued_date: string | null; expires_date: string | null; subtotal: number; discount_total: number; total: number; discount_pct: number; margin_pct: number | null; requires_approval: boolean; approved_by: string | null; created_by: string | null }
// GET /api/cpq/configs → { configs: [...], count }
interface Config { id: number; code: string; name: string; base_price: number; currency: string | null; description: string | null }
// GET /api/cpq/bundles → { bundles: [...] }. CRM-14 (CRM-12): a bundle SKU priced as the discounted sum of
// its component configs — expanding it into a quote reuses the CPQ-01 floor check unmodified.
interface Bundle { code: string; name: string; description: string | null; active: boolean }
interface BundleDraftItem { config_id: number | ''; qty: number; unit_cost: number }
// CRM-15 CPQ pricebooks — a governed, effective-dated price list a quote can be priced from.
interface Pricebook { id: number; code: string; name: string; currency: string; effective_from: string | null; effective_to: string | null; is_active: boolean }
interface PbEntryDraft { item_code: string; unit_price: number }

// Quote lifecycle (cpq.service.ts): Draft → Sent → Accepted | Rejected. CPQ-01 (SVC-1): a quote breaching the
// margin floor / max discount parks in PendingApproval on send and needs a different approver.
const QUOTE_STATUS_KEYS: Record<string, string> = {
  Draft: 'crm.status_draft', Sent: 'crm.status_sent', PendingApproval: 'crm.status_pending_approval', Accepted: 'crm.status_accepted', Rejected: 'crm.status_rejected',
};
const pct = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}%`);
const quoteStatusLabel = (t: (key: string) => string, s: string) => (QUOTE_STATUS_KEYS[s] ? t(QUOTE_STATUS_KEYS[s]) : s);

export default function CpqPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('crm.cpq_title')} description={t('crm.cpq_subtitle')} />
      <Tabs
        tabs={[
          { key: 'quotes', label: t('crm.tab_quotes'), content: <Quotes /> },
          { key: 'configs', label: t('crm.tab_configs'), content: <Configs /> },
          { key: 'bundles', label: t('crm.tab_bundles'), content: <Bundles /> },
          { key: 'pricebooks', label: t('crm.tab_pricebooks'), content: <Pricebooks /> },
        ]}
      />
    </div>
  );
}

function Quotes() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ quotes: Quote[]; count: number }>({ queryKey: ['cpq-quotes'], queryFn: () => api('/api/cpq/quotes') });

  const action = useMutation({
    mutationFn: (v: { id: number; verb: 'send' | 'accept' | 'reject' | 'approve' }) =>
      api(`/api/cpq/quotes/${v.id}/${v.verb}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cpq-quotes'] }),
    onError: (e: any) => notifyError(e.message),
  });

  // Email the quotation PDF to the customer (prompts for the recipient address).
  const email = useMutation({
    mutationFn: (v: { id: number; to_email: string }) =>
      api<{ to: string }>(`/api/cpq/quotes/${v.id}/send-email`, { method: 'POST', body: JSON.stringify({ to_email: v.to_email }) }),
    onSuccess: (r) => { notifySuccess(t('doc.email_sent', { to: r.to })); qc.invalidateQueries({ queryKey: ['cpq-quotes'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const promptEmail = (id: number) => { const to = window.prompt(t('doc.email_prompt')); if (to) email.mutate({ id, to_email: to }); };

  return (
    <div className="space-y-4">
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.quotes}
            emptyState={{ icon: FileText, title: t('crm.no_quotes_title'), description: t('crm.no_quotes_desc') }}
            columns={[
              { key: 'quote_no', label: t('dash.col_no') },
              { key: 'customer_name', label: t('fin.col_customer') },
              { key: 'issued_date', label: t('crm.issued_date'), render: (r: Quote) => thaiDate(r.issued_date) },
              { key: 'expires_date', label: t('crm.expires_date'), render: (r: Quote) => thaiDate(r.expires_date) },
              { key: 'subtotal', label: t('crm.subtotal'), align: 'right', render: (r: Quote) => <span className="tabular">{baht(r.subtotal)}</span> },
              { key: 'total', label: t('crm.total'), align: 'right', render: (r: Quote) => <span className="tabular">{baht(r.total)}</span> },
              { key: 'discount_pct', label: t('crm.discount_pct'), align: 'right', render: (r: Quote) => <span className="tabular">{pct(r.discount_pct)}</span> },
              { key: 'margin_pct', label: t('crm.margin_pct'), align: 'right', render: (r: Quote) => <span className="tabular">{pct(r.margin_pct)}</span> },
              { key: 'status', label: t('fin.col_status'), render: (r: Quote) => <Badge variant={statusVariant(r.status)}>{quoteStatusLabel(t, r.status)}</Badge> },
              {
                key: 'actions',
                label: t('crm.actions'),
                sortable: false,
                render: (r: Quote) => (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button variant="ghost" size="sm" asChild title={t('doc.print_pdf')}>
                      <a href={`${BASE}/api/cpq/quotes/${r.id}/pdf`} target="_blank" rel="noopener noreferrer"><Printer className="size-3.5" /></a>
                    </Button>
                    <Button variant="ghost" size="sm" disabled={email.isPending} title={t('doc.email')} onClick={() => promptEmail(r.id)}>
                      <Mail className="size-3.5" />
                    </Button>
                    {r.status === 'Draft' && (
                      <Button variant="outline" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: r.id, verb: 'send' })}>
                        <Send className="size-3.5" /> {t('crm.send')}
                      </Button>
                    )}
                    {r.status === 'PendingApproval' && (
                      <Button variant="default" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: r.id, verb: 'approve' })}>
                        <Check className="size-3.5" /> {t('crm.approve')}
                      </Button>
                    )}
                    {r.status === 'Sent' && (
                      <Button variant="default" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: r.id, verb: 'accept' })}>
                        <Check className="size-3.5" /> {t('crm.accept')}
                      </Button>
                    )}
                    {(r.status === 'Sent' || r.status === 'Draft' || r.status === 'PendingApproval') && (
                      <Button variant="destructive" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: r.id, verb: 'reject' })}>
                        <X className="size-3.5" /> {t('crm.reject')}
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

function Configs() {
  const { t } = useLang();
  const q = useQuery<{ configs: Config[]; count: number }>({ queryKey: ['cpq-configs'], queryFn: () => api('/api/cpq/configs') });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable
          rows={q.data.configs}
          emptyState={{ icon: SlidersHorizontal, title: t('crm.no_configs_title'), description: t('crm.no_configs_desc') }}
          columns={[
            { key: 'code', label: t('crm.col_code') },
            { key: 'name', label: t('crm.col_name') },
            { key: 'description', label: t('crm.description'), render: (r: Config) => r.description ?? '—' },
            { key: 'base_price', label: t('crm.base_price'), align: 'right', render: (r: Config) => <span className="tabular">{baht(r.base_price)}</span> },
          ]}
        />
      )}
    </StateView>
  );
}

// CRM-14 (CRM-12): bundle master data — create a bundle from existing configs, then expand it into a quote
// via `POST /api/cpq/quotes/:id/lines/bundle` (Quotes tab / deal workspace), not here.
function Bundles() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ bundles: Bundle[] }>({ queryKey: ['cpq-bundles'], queryFn: () => api('/api/cpq/bundles') });
  const configsQ = useQuery<{ configs: Config[]; count: number }>({ queryKey: ['cpq-configs'], queryFn: () => api('/api/cpq/configs') });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<BundleDraftItem[]>([{ config_id: '', qty: 1, unit_cost: 0 }]);

  const resetForm = () => { setCode(''); setName(''); setDescription(''); setItems([{ config_id: '', qty: 1, unit_cost: 0 }]); };

  const create = useMutation({
    mutationFn: () =>
      api('/api/cpq/bundles', {
        method: 'POST',
        body: JSON.stringify({
          code,
          name,
          description: description || undefined,
          items: items.filter((it) => it.config_id !== '').map((it) => ({ config_id: Number(it.config_id), qty: it.qty, unit_cost: it.unit_cost })),
        }),
      }),
    onSuccess: () => {
      notifySuccess(t('crm.toast_bundle_created'));
      qc.invalidateQueries({ queryKey: ['cpq-bundles'] });
      resetForm();
    },
    onError: (e: any) => notifyError(e.message),
  });

  const updateItem = (idx: number, patch: Partial<BundleDraftItem>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const addRow = () => setItems((prev) => [...prev, { config_id: '', qty: 1, unit_cost: 0 }]);
  const removeRow = (idx: number) => setItems((prev) => prev.filter((_, i) => i !== idx));

  const canSubmit = code.trim().length > 0 && name.trim().length > 0 && items.some((it) => it.config_id !== '') && !create.isPending;

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <h3 className="text-sm font-medium">{t('crm.bundle_create_title')}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t('crm.bundle_code')}</Label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('crm.bundle_name')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t('crm.description')}</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
        <div className="space-y-2">
          {items.map((it, idx) => (
            <div key={idx} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_6rem_7rem_auto]">
              <div className="space-y-1.5 sm:col-span-1">
                <Label>{t('crm.bundle_component')}</Label>
                <Select value={it.config_id} onChange={(e) => updateItem(idx, { config_id: e.target.value ? Number(e.target.value) : '' })}>
                  <option value="">—</option>
                  {configsQ.data?.configs.map((c) => (
                    <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t('crm.qty')}</Label>
                <Input type="number" min={0} value={it.qty} onChange={(e) => updateItem(idx, { qty: Number(e.target.value) })} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('crm.bundle_component_cost')}</Label>
                <Input type="number" min={0} value={it.unit_cost} onChange={(e) => updateItem(idx, { unit_cost: Number(e.target.value) })} />
              </div>
              <Button variant="ghost" size="sm" onClick={() => removeRow(idx)} disabled={items.length <= 1}>
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addRow}>{t('crm.bundle_add_component')}</Button>
        </div>
        <Button disabled={!canSubmit} onClick={() => create.mutate()}>{t('crm.bundle_create_btn')}</Button>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.bundles}
            emptyState={{ icon: Package, title: t('crm.no_bundles_title'), description: t('crm.no_bundles_desc') }}
            columns={[
              { key: 'code', label: t('crm.col_code') },
              { key: 'name', label: t('crm.col_name') },
              { key: 'description', label: t('crm.description'), render: (r: Bundle) => r.description ?? '—' },
              { key: 'active', label: t('fin.col_status'), render: (r: Bundle) => <Badge variant={r.active ? 'success' : 'muted'}>{r.active ? t('crm.active') : t('crm.inactive')}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

// CRM-15 CPQ pricebooks — master-data management: create effective-dated price lists and maintain their
// item→price entries. A quote created against a pricebook prices its lines from these entries (backend).
function Pricebooks() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ pricebooks: Pricebook[]; count: number }>({ queryKey: ['cpq-pricebooks'], queryFn: () => api('/api/cpq/pricebooks') });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('THB');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const resetForm = () => { setCode(''); setName(''); setCurrency('THB'); setFrom(''); setTo(''); };
  const create = useMutation({
    mutationFn: () => api('/api/cpq/pricebooks', { method: 'POST', body: JSON.stringify({ code, name, currency, effective_from: from || null, effective_to: to || null }) }),
    onSuccess: () => { notifySuccess(t('crm.pb_created')); qc.invalidateQueries({ queryKey: ['cpq-pricebooks'] }); resetForm(); },
    onError: (e: any) => notifyError(e.message),
  });

  // Entry editor — pick a pricebook, add item_code→unit_price rows, save (upsert).
  const [entryCode, setEntryCode] = useState('');
  const [entries, setEntries] = useState<PbEntryDraft[]>([{ item_code: '', unit_price: 0 }]);
  const updateEntry = (i: number, patch: Partial<PbEntryDraft>) => setEntries((p) => p.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  const saveEntries = useMutation({
    mutationFn: () => api(`/api/cpq/pricebooks/${encodeURIComponent(entryCode)}/entries`, { method: 'POST', body: JSON.stringify({ entries: entries.filter((e) => e.item_code.trim()).map((e) => ({ item_code: e.item_code.trim(), unit_price: Number(e.unit_price) || 0 })) }) }),
    onSuccess: () => { notifySuccess(t('crm.pb_entries_saved')); setEntries([{ item_code: '', unit_price: 0 }]); qc.invalidateQueries({ queryKey: ['cpq-pricebooks'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const win = (r: Pricebook) => `${r.effective_from ?? '—'} → ${r.effective_to ?? '—'}`;
  const canCreate = code.trim() && name.trim() && !create.isPending;
  const canSaveEntries = entryCode && entries.some((e) => e.item_code.trim()) && !saveEntries.isPending;

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <h3 className="text-sm font-medium">{t('crm.pb_create_title')}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>{t('crm.pb_code')}</Label><Input value={code} onChange={(e) => setCode(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>{t('crm.pb_name')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>{t('crm.pb_currency')}</Label><Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5"><Label>{t('crm.pb_effective_from')}</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>{t('crm.pb_effective_to')}</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('crm.pb_hint')}</p>
        <Button disabled={!canCreate} onClick={() => create.mutate()}>{t('crm.pb_create_btn')}</Button>
      </Card>

      <Card className="p-4 space-y-3">
        <h3 className="text-sm font-medium">{t('crm.pb_entries_title')}</h3>
        <div className="space-y-1.5 sm:max-w-xs">
          <Label>{t('crm.pb_pick')}</Label>
          <Select value={entryCode} onChange={(e) => setEntryCode(e.target.value)}>
            <option value="">—</option>
            {(q.data?.pricebooks ?? []).map((p) => <option key={p.id} value={p.code}>{p.code} — {p.name}</option>)}
          </Select>
        </div>
        <div className="space-y-2">
          {entries.map((e, idx) => (
            <div key={idx} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_8rem_auto]">
              <div className="space-y-1.5"><Label>{t('crm.pb_item_code')}</Label><Input value={e.item_code} onChange={(ev) => updateEntry(idx, { item_code: ev.target.value })} /></div>
              <div className="space-y-1.5"><Label>{t('crm.pb_unit_price')}</Label><Input type="number" min={0} value={e.unit_price} onChange={(ev) => updateEntry(idx, { unit_price: Number(ev.target.value) })} /></div>
              <Button variant="ghost" size="sm" onClick={() => setEntries((p) => p.filter((_, i) => i !== idx))} disabled={entries.length <= 1}><X className="size-3.5" /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setEntries((p) => [...p, { item_code: '', unit_price: 0 }])}>{t('crm.pb_add_entry')}</Button>
        </div>
        <Button disabled={!canSaveEntries} onClick={() => saveEntries.mutate()}>{t('crm.pb_save_entries')}</Button>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.pricebooks}
            emptyState={{ icon: FileText, title: t('crm.pb_empty_title'), description: t('crm.pb_empty_desc') }}
            columns={[
              { key: 'code', label: t('crm.col_code') },
              { key: 'name', label: t('crm.col_name') },
              { key: 'currency', label: t('crm.pb_currency') },
              { key: 'window', label: t('crm.pb_window'), render: (r: Pricebook) => win(r) },
              { key: 'is_active', label: t('fin.col_status'), render: (r: Pricebook) => <Badge variant={r.is_active ? 'success' : 'muted'}>{r.is_active ? t('crm.active') : t('crm.inactive')}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
