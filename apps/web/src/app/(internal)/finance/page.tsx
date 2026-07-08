'use client';

import { useState, type ComponentProps, type Dispatch, type SetStateAction } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Banknote, BellRing, CalendarClock, CheckCheck, Download, Eraser, HandCoins, Mail, PlayCircle, Plus, Printer, ReceiptText, RefreshCw, TrendingUp, Wallet } from 'lucide-react';
import { api, apiDownload } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose,
} from '@/components/ui/dialog';
import { statusVariant } from '@/components/ui';
import { TrendAreaChart } from '@/components/charts';
import { Select } from '@/components/form-controls';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

// AR/AP aging buckets in escalating-severity order — shared by the overview composition bars and the
// detail Aging sections. Colours ramp current → 90+ so an overdue-heavy book reads "red" at a glance.
const AGING_BUCKETS = [
  { k: 'current', labelKey: 'fin.bucket_current', cls: 'bg-success' },
  { k: 'd1_30', labelKey: 'fin.bucket_1_30', cls: 'bg-info' },
  { k: 'd31_60', labelKey: 'fin.bucket_31_60', cls: 'bg-warning' },
  { k: 'd61_90', labelKey: 'fin.bucket_61_90', cls: 'bg-orange-500' },
  { k: 'd90_plus', labelKey: 'fin.bucket_90plus', cls: 'bg-destructive' },
] as const;

/** A single horizontal stacked bar showing how an outstanding balance splits across aging buckets. */
function AgingStack({ label, total, buckets }: { label: string; total: number; buckets?: Record<string, number> }) {
  const { t } = useLang();
  const tot = total || AGING_BUCKETS.reduce((a, b) => a + Number(buckets?.[b.k] ?? 0), 0);
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular text-muted-foreground">{baht(tot)}</span>
      </div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={t('fin.aging_aria', { label, total: baht(tot) })}
      >
        {tot > 0 &&
          AGING_BUCKETS.map((b) => {
            const v = Number(buckets?.[b.k] ?? 0);
            if (v <= 0) return null;
            return <div key={b.k} className={b.cls} style={{ width: `${(v / tot) * 100}%` }} title={`${t(b.labelKey)}: ${baht(v)}`} />;
          })}
      </div>
    </div>
  );
}

/** Shared labelled text field for the AR/AP entry dialogs (each tab owns its own form state). */
function Field({ label, name, form, set, ...props }: {
  label: string; name: string; form: any; set: Dispatch<SetStateAction<any>>;
} & ComponentProps<typeof Input>) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} value={form[name] ?? ''} onChange={(e) => set((f: any) => ({ ...f, [name]: e.target.value }))} {...props} />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// Page shell — PEAK-style cycle split: ภาพรวม (overview) · รายรับ (AR) · รายจ่าย (AP).
// The active tab is deep-linkable via ?tab= so the dashboard action center can open the right cycle
// (e.g. /finance?tab=payables). /finance stays the single route — no new pages, URL-stable (cf. doc 15).
// ──────────────────────────────────────────────────────────────────────────────────────────────────
export default function FinancePage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('fin.title')} description={t('fin.subtitle')} />
      <Tabs
        urlParam="tab"
        tabs={[
          { key: 'overview', label: t('fin.tab_overview'), content: <OverviewTab /> },
          { key: 'receivables', label: t('fin.tab_ar'), content: <ReceivablesTab /> },
          { key: 'payables', label: t('fin.tab_ap'), content: <PayablesTab /> },
        ]}
      />
    </div>
  );
}

// ── ภาพรวม: executive band — KPIs + revenue trend + AR/AP aging composition ──
function OverviewTab() {
  const { t } = useLang();
  const kpi = useQuery<any>({ queryKey: ['fin-kpi'], queryFn: () => api('/api/finance/kpi') });
  const trend = useQuery<any>({ queryKey: ['fin-revenue-trend'], queryFn: () => api('/api/dashboard/sales-trend?days=30') });
  // The aging queries reuse the exact keys the detail Aging sections use, so React Query dedupes them to a
  // single fetch each — no extra round-trips across tabs.
  const arAging = useQuery<any>({ queryKey: ['fin-ar-aging'], queryFn: () => api('/api/finance/ar/aging') });
  const apAging = useQuery<any>({ queryKey: ['fin-ap-aging'], queryFn: () => api('/api/finance/ap/aging') });
  const trendData = (trend.data?.trend ?? []).map((r: any) => ({ ...r, label: thaiDate(r.date) }));

  return (
    <div className="space-y-6">
      <StateView q={kpi}>
        {kpi.data && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('fin.mtd_revenue')} value={baht(kpi.data.mtd_revenue)} icon={Banknote} tone="primary" hint={t('fin.mtd_hint')} />
            <StatCard label={t('fin.ytd_revenue')} value={baht(kpi.data.ytd_revenue)} icon={TrendingUp} tone="default" hint={t('fin.ytd_hint')} />
            <StatCard label={t('fin.ar_outstanding')} value={baht(kpi.data.ar_outstanding)} icon={ReceiptText} tone={kpi.data.ar_outstanding > 0 ? 'warning' : 'success'} hint={t('fin.ar_outstanding_hint')} />
            <StatCard label={t('fin.ap_outstanding')} value={baht(kpi.data.ap_outstanding)} icon={Wallet} tone={kpi.data.ap_outstanding > 0 ? 'danger' : 'success'} hint={t('fin.ap_outstanding_hint')} />
          </div>
        )}
      </StateView>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">{t('fin.revenue_trend')}</CardTitle>
          </CardHeader>
          <CardContent>
            {trend.isLoading ? (
              <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">{t('dash.loading')}</div>
            ) : trendData.length ? (
              <TrendAreaChart data={trendData} xKey="label" yKey="sales" fmt={(v) => baht(v)} />
            ) : (
              <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">{t('fin.no_revenue_data')}</div>
            )}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">{t('fin.aging_compare')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {arAging.isLoading || apAging.isLoading ? (
              <div className="grid h-[200px] place-items-center text-sm text-muted-foreground">{t('dash.loading')}</div>
            ) : (
              <>
                <AgingStack label={t('fin.ar_label')} total={arAging.data?.total ?? 0} buckets={arAging.data?.buckets} />
                <AgingStack label={t('fin.ap_label')} total={apAging.data?.total ?? 0} buckets={apAging.data?.buckets} />
                <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
                  {AGING_BUCKETS.map((b) => (
                    <span key={b.k} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={`size-2.5 rounded-sm ${b.cls}`} /> {t(b.labelKey)}
                    </span>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── รายรับ (AR): receivables list + รับชำระ receipt + collections/dunning worklist + AR aging ──
function ReceivablesTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const ar = useQuery<any>({ queryKey: ['fin-ar'], queryFn: () => api('/api/finance/ar?limit=50') });
  const refresh = () => { for (const k of ['fin-ar', 'fin-kpi', 'fin-ar-aging', 'ar-receipts']) qc.invalidateQueries({ queryKey: [k] }); };

  // ── AR receipt (record a customer payment against an invoice) ──
  const [arOpen, setArOpen] = useState(false);
  const [arForm, setArForm] = useState<any>({ invoice_no: '', amount: '', method: 'Transfer', ref_no: '' });
  const arReceipt = useMutation({
    mutationFn: () => api('/api/finance/ar/receipts', { method: 'POST', body: JSON.stringify({ ...arForm, amount: Number(arForm.amount) }) }),
    onSuccess: (r: any) => { notifySuccess(t('fin.ar_receipt_ok', { no: r.receipt_no, status: r.status })); refresh(); setArForm({ invoice_no: '', amount: '', method: 'Transfer', ref_no: '' }); },
    onError: (e: any) => notifyError(e.message),
  });

  // Email the ใบแจ้งหนี้/ใบวางบิล PDF to the customer. Leaving the prompt blank sends to the customer's
  // email on file (master data); the server returns NO_RECIPIENT if there is none.
  const emailInv = useMutation({
    mutationFn: (v: { no: string; to_email?: string }) => api<{ to: string }>(`/api/finance/ar/invoices/${encodeURIComponent(v.no)}/send-email`, { method: 'POST', body: JSON.stringify({ to_email: v.to_email }) }),
    onSuccess: (r) => notifySuccess(t('doc.email_sent', { to: r.to })),
    onError: (e: any) => notifyError(e.message),
  });
  const promptEmail = (no: string) => { const to = window.prompt(t('doc.email_prompt_default')); if (to === null) return; emailInv.mutate({ no, to_email: to.trim() || undefined }); };
  const syncAr = useMutation({
    mutationFn: () => api('/api/finance/ar/sync', { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('fin.ar_synced')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{t('fin.ar_label')}</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => syncAr.mutate()} disabled={syncAr.isPending}>
            <RefreshCw className={`size-4 ${syncAr.isPending ? 'animate-spin' : ''}`} /> {t('fin.sync_ar')}
          </Button>
          <Dialog open={arOpen} onOpenChange={setArOpen}>
            <DialogTrigger asChild><Button variant="outline" size="sm"><HandCoins className="size-4" /> {t('fin.receive_ar')}</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>{t('fin.receive_ar_title')}</DialogTitle></DialogHeader>
              <div className="grid gap-4">
                <Field label={t('fin.f_invoice_no')} name="invoice_no" placeholder="INV-…" form={arForm} set={setArForm} />
                <Field label={t('fin.f_amount')} name="amount" type="number" step="0.01" form={arForm} set={setArForm} />
                <Field label={t('fin.f_method')} name="method" form={arForm} set={setArForm} />
                <Field label={t('fin.f_ref')} name="ref_no" form={arForm} set={setArForm} />
              </div>
              <DialogFooter>
                <Button onClick={() => arReceipt.mutate()} disabled={arReceipt.isPending || !arForm.invoice_no || !arForm.amount}>{t('fin.save')}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <StateView q={ar}>
        {ar.data && (
          <DataTable
            rows={ar.data.invoices}
            emptyState={{ icon: ReceiptText, title: t('fin.ar_empty_title'), description: t('fin.ar_empty_desc') }}
            columns={[
              { key: 'Invoice_No', label: t('fin.col_no') },
              { key: 'Customer_Name', label: t('fin.col_customer') },
              { key: 'Due_Date', label: t('fin.col_due'), render: (r: any) => thaiDate(r.Due_Date) },
              { key: 'Amount', label: t('fin.col_amount'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.Amount)}</span> },
              { key: 'Outstanding_Amount', label: t('fin.col_outstanding'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.Outstanding_Amount)}</span> },
              { key: 'Status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
              { key: 'act', label: '', sortable: false, render: (r: any) => (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => { setArForm({ invoice_no: r.Invoice_No, amount: String(r.Outstanding_Amount), method: 'Transfer', ref_no: '' }); setArOpen(true); }}>{t('fin.receive')}</Button>
                  <Button variant="ghost" size="sm" asChild title={t('doc.print_pdf')}>
                    <a href={`${BASE}/api/finance/ar/invoices/${encodeURIComponent(r.Invoice_No)}/pdf`} target="_blank" rel="noopener noreferrer"><Printer className="size-4" /></a>
                  </Button>
                  <Button variant="ghost" size="sm" disabled={emailInv.isPending} title={t('doc.email')} onClick={() => promptEmail(r.Invoice_No)}><Mail className="size-4" /></Button>
                </div>
              ) },
            ]}
          />
        )}
      </StateView>

      <ReceiptsSection />
      <CollectionsSection />
      <WriteOffSection />
      <ArAgingSection />
    </div>
  );
}

// ── ใบสำคัญรับเงิน (AR receipt vouchers): recent receipts with print + email (recipient defaults to the
// customer's email on file when the prompt is left blank). ──
function ReceiptsSection() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['ar-receipts'], queryFn: () => api('/api/finance/ar/receipts'), retry: false });
  const emailRcp = useMutation({
    mutationFn: (v: { no: string; to_email?: string }) => api<{ to: string }>(`/api/finance/ar/receipts/${encodeURIComponent(v.no)}/send-email`, { method: 'POST', body: JSON.stringify({ to_email: v.to_email }) }),
    onSuccess: (r) => notifySuccess(t('doc.email_sent', { to: r.to })),
    onError: (e: any) => notifyError(e.message),
  });
  const promptRcpEmail = (no: string) => { const to = window.prompt(t('doc.email_prompt_default')); if (to === null) return; emailRcp.mutate({ no, to_email: to.trim() || undefined }); };
  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">{t('fin.receipts_heading')}</h2>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.receipts ?? []}
            rowKey={(r: any) => r.receipt_no}
            emptyState={{ icon: HandCoins, title: t('fin.receipts_empty_title'), description: t('fin.receipts_empty_desc') }}
            columns={[
              { key: 'receipt_no', label: t('fin.col_no') },
              { key: 'receipt_date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.receipt_date) },
              { key: 'invoice_no', label: t('fin.col_invoice'), render: (r: any) => r.invoice_no ?? '—' },
              { key: 'amount', label: t('fin.col_amount'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
              { key: 'method', label: t('fin.f_method'), render: (r: any) => r.method ?? '—' },
              { key: 'act', label: '', sortable: false, render: (r: any) => (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" asChild title={t('doc.print_pdf')}>
                    <a href={`${BASE}/api/finance/ar/receipts/${encodeURIComponent(r.receipt_no)}/pdf`} target="_blank" rel="noopener noreferrer"><Printer className="size-4" /></a>
                  </Button>
                  <Button variant="ghost" size="sm" disabled={emailRcp.isPending} title={t('doc.email')} onClick={() => promptRcpEmail(r.receipt_no)}><Mail className="size-4" /></Button>
                </div>
              ) },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

// ── AR bad-debt write-off (REV-14): request (Draft) → independent approval (maker-checker) + register ──
function WriteOffSection() {
  const { t } = useLang();
  const qc = useQueryClient();
  const wo = useQuery<any>({ queryKey: ['fin-ar-writeoffs'], queryFn: () => api('/api/finance/ar/write-offs'), retry: false });
  const refresh = () => { for (const k of ['fin-ar-writeoffs', 'fin-ar', 'fin-kpi']) qc.invalidateQueries({ queryKey: [k] }); };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>({ customer_name: '', amount: '', reason: '' });
  const request = useMutation({
    mutationFn: () => api('/api/finance/ar/write-off', { method: 'POST', body: JSON.stringify({ customer_name: form.customer_name || undefined, amount: Number(form.amount), reason: form.reason }) }),
    onSuccess: (r: any) => { notifySuccess(t('fin.wo_requested', { amount: baht(r.amount), no: r.entry_no })); setForm({ customer_name: '', amount: '', reason: '' }); setOpen(false); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const approve = useMutation({
    mutationFn: (entryNo: string) => api(`/api/ledger/journal/${entryNo}/approve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('fin.wo_approved')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-muted-foreground">{t('fin.wo_heading')}</h3>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button variant="outline" size="sm"><Eraser className="size-4" /> {t('fin.wo_request')}</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{t('fin.wo_title')}</DialogTitle></DialogHeader>
            <div className="grid gap-4">
              <Field label={t('fin.f_customer_opt')} name="customer_name" form={form} set={setForm} />
              <Field label={t('fin.f_amount')} name="amount" type="number" step="0.01" form={form} set={setForm} />
              <Field label={t('fin.f_reason')} name="reason" placeholder={t('fin.wo_reason_ph')} form={form} set={setForm} />
            </div>
            <DialogFooter>
              <Button onClick={() => request.mutate()} disabled={request.isPending || !(Number(form.amount) > 0) || !form.reason.trim()}>{t('fin.wo_submit')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <StateView q={wo}>
        {wo.data && (
          <DataTable
            rows={wo.data.write_offs}
            rowKey={(r: any) => r.entry_no}
            emptyState={{ icon: Eraser, title: t('fin.wo_empty_title'), description: t('fin.wo_empty_desc') }}
            columns={[
              { key: 'entry_no', label: t('fin.col_entry_no') },
              { key: 'memo', label: t('fin.col_detail') },
              { key: 'amount', label: t('fin.col_amount2'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
              { key: 'created_by', label: t('fin.col_requester') },
              { key: 'state', label: t('fin.col_status'), render: (r: any) => <Badge variant={r.state === 'approved' ? 'success' : r.state === 'rejected' ? 'destructive' : 'warning'}>{r.state === 'approved' ? t('fin.approved') : r.state === 'rejected' ? t('fin.rejected') : t('fin.pending')}</Badge> },
              { key: 'act', label: '', sortable: false, render: (r: any) => r.state === 'pending' ? (
                <Button variant="outline" size="sm" disabled={approve.isPending} onClick={() => approve.mutate(r.entry_no)}>{t('fin.approve')}</Button>
              ) : null },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

// ── รายจ่าย (AP): payables list + บันทึกบิล + pay-request + maker-checker approval queue + AP aging ──
function PayablesTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const ap = useQuery<any>({ queryKey: ['fin-ap'], queryFn: () => api('/api/finance/ap?status=Unpaid&limit=50') });
  const refresh = () => { for (const k of ['fin-ap', 'fin-kpi', 'fin-ap-aging']) qc.invalidateQueries({ queryKey: [k] }); };

  // ── AP vendor invoice entry ──
  const [apOpen, setApOpen] = useState(false);
  const [apForm, setApForm] = useState<any>({ vendor_name: '', invoice_no: '', invoice_date: '', due_date: '', amount: '', txn_type: 'Invoice', vat_treatment: 'standard' });
  const apCreate = useMutation({
    mutationFn: () => api('/api/finance/ap/transactions', { method: 'POST', body: JSON.stringify({ ...apForm, amount: Number(apForm.amount) }) }),
    onSuccess: (r: any) => { notifySuccess(t('fin.ap_created', { no: r.txn_no })); refresh(); setApForm({ vendor_name: '', invoice_no: '', invoice_date: '', due_date: '', amount: '', txn_type: 'Invoice', vat_treatment: 'standard' }); },
    onError: (e: any) => notifyError(e.message),
  });

  // ── AP pay REQUEST (per row) — maker-checker: this submits a request; a different user approves it ──
  const [payTxn, setPayTxn] = useState<string | null>(null);
  const [payAmt, setPayAmt] = useState('');
  const payAp = useMutation({
    mutationFn: () => api(`/api/finance/ap/transactions/${payTxn}/pay`, { method: 'PATCH', body: JSON.stringify({ amount: Number(payAmt) }) }),
    onSuccess: (r: any) => { notifySuccess(t('fin.pay_requested', { no: r.payment_no ?? r.txn_no })); refresh(); setPayTxn(null); setPayAmt(''); },
    onError: (e: any) => notifyError(e.message),
  });

  // The CHECKER side (approve/reject + release cash) lives on /disbursements, owned by finance —
  // accounting books the bill and requests payment here; finance approves there (SoD R07 / EXP-06).

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{t('fin.ap_label')}</h2>
        <Dialog open={apOpen} onOpenChange={setApOpen}>
          <DialogTrigger asChild><Button size="sm"><Plus className="size-4" /> {t('fin.ap_add')}</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{t('fin.ap_add_title')}</DialogTitle></DialogHeader>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('fin.f_vendor')} name="vendor_name" form={apForm} set={setApForm} />
              <Field label={t('fin.f_invoice_no')} name="invoice_no" form={apForm} set={setApForm} />
              <Field label={t('fin.f_invoice_date')} name="invoice_date" type="date" form={apForm} set={setApForm} />
              <Field label={t('fin.f_due_date')} name="due_date" type="date" form={apForm} set={setApForm} />
              <Field label={t('fin.f_amount_vat')} name="amount" type="number" step="0.01" form={apForm} set={setApForm} />
              <div className="grid gap-2">
                <Label htmlFor="vat_treatment">{t('fin.f_vat')}</Label>
                <Select id="vat_treatment" value={apForm.vat_treatment} onChange={(e) => setApForm((f: any) => ({ ...f, vat_treatment: e.target.value }))}>
                  <option value="standard">{t('fin.vat_standard')}</option>
                  <option value="exempt">{t('fin.vat_exempt')}</option>
                  <option value="zero">{t('fin.vat_zero')}</option>
                  <option value="reverse_charge">{t('fin.vat_reverse_charge')}</option>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => apCreate.mutate()} disabled={apCreate.isPending || !apForm.amount}>{t('fin.save')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <StateView q={ap}>
        {ap.data && (
          <DataTable
            rows={ap.data.transactions}
            emptyState={{ icon: Wallet, title: t('fin.ap_empty_title'), description: t('fin.ap_empty_desc') }}
            columns={[
              { key: 'Transaction_ID', label: t('fin.col_no') },
              { key: 'Creditor_Name', label: t('fin.col_creditor') },
              { key: 'Due_Date', label: t('fin.col_due'), render: (r: any) => thaiDate(r.Due_Date) },
              { key: 'Amount', label: t('fin.col_amount'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.Amount)}</span> },
              { key: 'Outstanding_Amount', label: t('fin.col_outstanding'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.Outstanding_Amount)}</span> },
              { key: 'Status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
              { key: 'act', label: '', sortable: false, render: (r: any) => (
                <Button variant="ghost" size="sm" onClick={() => { setPayTxn(r.Transaction_ID); setPayAmt(String(r.Outstanding_Amount)); }}>{t('fin.pay')}</Button>
              ) },
            ]}
          />
        )}
      </StateView>

      {/* The maker-checker approval queue moved to the finance-owned /disbursements page (SoD R07). */}
      <p className="text-xs text-muted-foreground">
        {t('fin.ap_note_1')}{' '}
        <a href="/disbursements" className="font-medium underline underline-offset-2">{t('fin.disbursements_link')}</a>{' '}
        {t('fin.ap_note_2')}
      </p>

      <ApAgingSection />

      {/* AP pay-request dialog — submits a request that a different user must approve (maker-checker) */}
      <Dialog open={!!payTxn} onOpenChange={(o) => { if (!o) setPayTxn(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('fin.pay_title', { txn: payTxn ?? '' })}</DialogTitle></DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="payAmt">{t('fin.f_amount')}</Label>
            <Input id="payAmt" type="number" step="0.01" value={payAmt} onChange={(e) => setPayAmt(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t('fin.pay_note')}</p>
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">{t('fin.cancel')}</Button></DialogClose>
            <Button onClick={() => payAp.mutate()} disabled={payAp.isPending || !payAmt}>{t('fin.pay_submit')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── AR aging buckets (Current / 1-30 / 31-60 / 61-90 / 90+) ──
function ArAgingSection() {
  const { t } = useLang();
  const arA = useQuery<any>({ queryKey: ['fin-ar-aging'], queryFn: () => api('/api/finance/ar/aging') });
  return (
    <StateView q={arA}>
      <AgingRow title={t('fin.ar_aging_title')} data={arA.data} />
    </StateView>
  );
}

// ── AP aging buckets + AP-aging Excel export ──
function ApAgingSection() {
  const { t } = useLang();
  const apA = useQuery<any>({ queryKey: ['fin-ap-aging'], queryFn: () => api('/api/finance/ap/aging') });
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{t('fin.ap_aging_heading')}</h2>
        <Button variant="outline" size="sm" disabled={busy} onClick={async () => { setBusy(true); try { await apiDownload('/api/reports/ap-aging/export', 'ap-aging.xlsx'); } finally { setBusy(false); } }}>
          <Download className="size-4" /> {t('fin.export_ap_aging')}
        </Button>
      </div>
      <StateView q={apA}>
        <AgingRow title={t('fin.ap_aging_title')} data={apA.data} />
      </StateView>
    </div>
  );
}

// Shared aging-bucket StatCard row (Current / 1-30 / 31-60 / 61-90 / 90+).
function AgingRow({ title, data }: { title: string; data: any }) {
  const { t } = useLang();
  const B = [
    { k: 'current', labelKey: 'fin.bucket_current' }, { k: 'd1_30', labelKey: 'fin.bucket_1_30' }, { k: 'd31_60', labelKey: 'fin.bucket_31_60' },
    { k: 'd61_90', labelKey: 'fin.bucket_61_90' }, { k: 'd90_plus', labelKey: 'fin.bucket_90plus' },
  ];
  if (!data) return null;
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('fin.aging_total', { title, total: baht(data.total) })}</h3>
      <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
        {B.map((b, i) => <StatCard key={b.k} label={t(b.labelKey)} value={baht(data.buckets?.[b.k])} icon={CalendarClock} tone={i >= 3 ? 'danger' : i === 2 ? 'warning' : 'default'} />)}
      </div>
    </div>
  );
}

// ── AR collections worklist: aging + dunning stage + record action + automated sweep ──
const DUNNING_STAGES = ['reminder', 'first_notice', 'second_notice', 'final_notice', 'legal'] as const;
const stageBadge = (stage: string | null): 'secondary' | 'warning' | 'destructive' =>
  stage === 'legal' || stage === 'final_notice' ? 'destructive' : stage === 'second_notice' ? 'warning' : 'secondary';

function CollectionsSection() {
  const { t } = useLang();
  const stageLabel = (s: string) => t(`fin.stage_${s}`);
  const qc = useQueryClient();
  const wl = useQuery<any>({ queryKey: ['ar-collections'], queryFn: () => api('/api/finance/ar/collections?overdue_only=1') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['ar-collections'] });

  const [dun, setDun] = useState<any | null>(null); // the worklist row being dunned
  const [form, setForm] = useState<any>({ stage: 'reminder', channel: 'email', promise_to_pay_date: '', notes: '' });
  const record = useMutation({
    mutationFn: () => api(`/api/finance/ar/collections/${dun.invoice_no}/dunning`, {
      method: 'POST',
      body: JSON.stringify({ stage: form.stage, channel: form.channel, promise_to_pay_date: form.promise_to_pay_date || undefined, notes: form.notes || undefined }),
    }),
    onSuccess: (r: any) => {
      const note = r.message_status === 'sent' ? t('fin.dun_sent', { r: r.recipient ?? r.channel })
        : r.message_status === 'manual' ? t('fin.dun_manual', { r: r.channel })
        : r.message_status === 'failed' ? t('fin.dun_failed') : '';
      notifySuccess(t('fin.dun_recorded', { no: r.dunning_no, note })); refresh(); setDun(null);
    },
    onError: (e: any) => notifyError(e.message),
  });

  const sweep = useMutation({
    mutationFn: () => api('/api/finance/ar/collections/sweep', { method: 'POST' }),
    onSuccess: (r: any) => { notifySuccess(t('fin.sweep_ok', { advanced: r.advanced, scanned: r.scanned })); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  // Email the หนังสือทวงถามหนี้ PDF to the customer. Blank prompt → the customer's email on file (master data).
  const emailDun = useMutation({
    mutationFn: (v: { no: string; to_email?: string }) => api<{ to: string }>(`/api/finance/ar/collections/${encodeURIComponent(v.no)}/dunning-letter/send-email`, { method: 'POST', body: JSON.stringify({ to_email: v.to_email }) }),
    onSuccess: (r) => notifySuccess(t('doc.email_sent', { to: r.to })),
    onError: (e: any) => notifyError(e.message),
  });
  const promptDunEmail = (no: string) => { const to = window.prompt(t('doc.email_prompt_default')); if (to === null) return; emailDun.mutate({ no, to_email: to.trim() || undefined }); };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{t('fin.collections_heading')}</h2>
        <Button variant="outline" size="sm" disabled={sweep.isPending} onClick={() => sweep.mutate()}>
          <PlayCircle className={`size-4 ${sweep.isPending ? 'animate-spin' : ''}`} /> {t('fin.auto_dunning')}
        </Button>
      </div>
      <StateView q={wl}>
        {wl.data && (
          <DataTable
            rows={wl.data.rows}
            emptyState={{ icon: CheckCheck, title: t('fin.collections_empty_title'), description: t('fin.collections_empty_desc') }}
            columns={[
              { key: 'invoice_no', label: t('fin.col_invoice') },
              { key: 'party', label: t('fin.col_customer') },
              { key: 'outstanding', label: t('fin.col_outstanding'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.outstanding)}</span> },
              { key: 'days_overdue', label: t('fin.col_days_overdue'), align: 'right', render: (r: any) => <span className={`tabular ${r.days_overdue > 90 ? 'text-red-600' : ''}`}>{r.days_overdue}</span> },
              { key: 'current_stage', label: t('fin.col_current_stage'), render: (r: any) => r.current_stage ? <Badge variant={stageBadge(r.current_stage)}>{stageLabel(r.current_stage)}</Badge> : <span className="text-muted-foreground">—</span> },
              { key: 'recommended_stage', label: t('fin.col_recommended'), render: (r: any) => r.recommended_stage ? <Badge variant={r.escalate ? 'destructive' : 'outline'}>{stageLabel(r.recommended_stage)}</Badge> : <span className="text-muted-foreground">—</span> },
              { key: 'act', label: '', sortable: false, render: (r: any) => (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => { setForm({ stage: r.recommended_stage ?? 'reminder', channel: 'email', promise_to_pay_date: '', notes: '' }); setDun(r); }}>
                    <BellRing className="size-4" /> {t('fin.dun')}
                  </Button>
                  <Button variant="ghost" size="sm" asChild title={t('fin.dun_letter')}>
                    <a href={`${BASE}/api/finance/ar/collections/${encodeURIComponent(r.invoice_no)}/dunning-letter/pdf`} target="_blank" rel="noopener noreferrer"><Printer className="size-4" /></a>
                  </Button>
                  <Button variant="ghost" size="sm" disabled={emailDun.isPending} title={t('doc.email')} onClick={() => promptDunEmail(r.invoice_no)}><Mail className="size-4" /></Button>
                </div>
              ) },
            ]}
          />
        )}
      </StateView>

      {/* Record-dunning dialog */}
      <Dialog open={!!dun} onOpenChange={(o) => { if (!o) setDun(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('fin.dun_title', { invoice: dun?.invoice_no ?? '' })}</DialogTitle></DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="dun-stage">{t('fin.dun_stage')}</Label>
              <Select id="dun-stage" value={form.stage} onChange={(e) => setForm((f: any) => ({ ...f, stage: e.target.value }))}>
                {DUNNING_STAGES.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="dun-channel">{t('fin.dun_channel')}</Label>
              <Select id="dun-channel" value={form.channel} onChange={(e) => setForm((f: any) => ({ ...f, channel: e.target.value }))}>
                <option value="email">{t('fin.ch_email')}</option><option value="phone">{t('fin.ch_phone')}</option><option value="letter">{t('fin.ch_letter')}</option><option value="sms">{t('fin.ch_sms')}</option>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="dun-ptp">{t('fin.dun_ptp')}</Label>
              <Input id="dun-ptp" type="date" value={form.promise_to_pay_date} onChange={(e) => setForm((f: any) => ({ ...f, promise_to_pay_date: e.target.value }))} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="dun-notes">{t('fin.dun_notes')}</Label>
              <Input id="dun-notes" value={form.notes} onChange={(e) => setForm((f: any) => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">{t('fin.cancel')}</Button></DialogClose>
            <Button onClick={() => record.mutate()} disabled={record.isPending}>{t('fin.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
