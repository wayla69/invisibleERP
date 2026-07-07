'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Building2, Loader2, MapPin, Palette, ReceiptText, Save, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifyError, notifySuccess } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { FormField } from '@/components/form-field';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface Profile {
  code: string; name: string; legal_name: string | null; tax_id: string | null; branch_code: string | null;
  vat_registered: boolean; vat_rate: number; tax_country: string;
  phone: string | null; fax: string | null; email: string | null;
  address_line1: string | null; address_line2: string | null; sub_district: string | null;
  district: string | null; province: string | null; postal_code: string | null;
  promptpay_id: string | null;
  logo_url: string | null; tagline: string | null; branding_prefs: Record<string, unknown>;
  setup_complete: boolean;
}

// Field config: label + optional helper hint (both stored as i18n message keys, resolved at render).
// Validated fields also appear in `validate()` below.
type FieldDef = { key: string; label: string; hint?: string };
const FIELDS_IDENTITY: FieldDef[] = [
  { key: 'legal_name', label: 'mx.setup_f_legal_name', hint: 'mx.setup_h_legal_name' },
  { key: 'tax_id', label: 'mx.setup_f_tax_id', hint: 'mx.setup_h_tax_id' },
  { key: 'branch_code', label: 'mx.setup_f_branch_code', hint: 'mx.setup_h_branch_code' },
  { key: 'phone', label: 'mx.setup_f_phone' },
  { key: 'fax', label: 'mx.setup_f_fax' },
  { key: 'email', label: 'mx.setup_f_email' },
  { key: 'promptpay_id', label: 'mx.setup_f_promptpay', hint: 'mx.setup_h_promptpay' },
];
const FIELDS_ADDRESS: FieldDef[] = [
  { key: 'address_line1', label: 'mx.setup_f_address1' },
  { key: 'address_line2', label: 'mx.setup_f_address2' },
  { key: 'sub_district', label: 'mx.setup_f_subdistrict' },
  { key: 'district', label: 'mx.setup_f_district' },
  { key: 'province', label: 'mx.setup_f_province' },
  { key: 'postal_code', label: 'mx.setup_f_postal', hint: 'mx.setup_h_postal' },
];

/** Client-side format checks — all optional fields, but if filled they must be well-formed. Returns a map of
 *  field key → i18n error-message key (resolved at render); an empty map means the form is valid. Mirrors the
 *  tax-doc format rules so a bad tax ID / PromptPay is caught before it ever reaches a printed invoice. */
function validate(form: Record<string, any>): Record<string, string> {
  const e: Record<string, string> = {};
  const s = (k: string) => String(form[k] ?? '').trim();
  if (s('tax_id') && !/^\d{13}$/.test(s('tax_id'))) e.tax_id = 'mx.setup_err_tax_id';
  if (s('branch_code') && !/^\d{5}$/.test(s('branch_code'))) e.branch_code = 'mx.setup_err_branch_code';
  if (s('email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s('email'))) e.email = 'mx.setup_err_email';
  if (s('postal_code') && !/^\d{5}$/.test(s('postal_code'))) e.postal_code = 'mx.setup_err_postal';
  if (s('promptpay_id') && !/^(\d{10}|\d{13})$/.test(s('promptpay_id'))) e.promptpay_id = 'mx.setup_err_promptpay';
  const rate = Number(form.vat_rate);
  if (form.vat_registered && (!Number.isFinite(rate) || rate <= 0 || rate >= 1)) e.vat_rate = 'mx.setup_err_vat';
  return e;
}

export default function SetupPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<Profile>({ queryKey: ['tenant-profile'], queryFn: () => api('/api/tenant/profile') });
  const [form, setForm] = useState<Record<string, any>>({});
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => { if (q.data) setForm(q.data as any); }, [q.data]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const errors = useMemo(() => validate(form), [form]);
  const errFor = (k: string) => (showErrors ? errors[k] : undefined);
  const errMsg = (k: string) => { const ek = errFor(k); return ek ? t(ek) : undefined; };

  const save = useMutation({
    mutationFn: () => api<Profile>('/api/tenant/profile', {
      method: 'PATCH',
      body: JSON.stringify({
        legal_name: form.legal_name, tax_id: form.tax_id, branch_code: form.branch_code,
        vat_registered: !!form.vat_registered, vat_rate: Number(form.vat_rate) || 0.07, name: form.name,
        phone: form.phone, fax: form.fax, email: form.email,
        address_line1: form.address_line1, address_line2: form.address_line2, sub_district: form.sub_district,
        district: form.district, province: form.province, postal_code: form.postal_code,
        promptpay_id: form.promptpay_id || undefined,
        logo_url: form.logo_url ?? '', tagline: form.tagline ?? '',
        branding_prefs: form.branding_prefs ?? {},
      }),
    }),
    onSuccess: (p: any) => {
      // G15 (audit): a change to promptpay_id / tax_id is STAGED for a distinct approver, not applied here —
      // surface that instead of implying it saved (the returned profile still shows the pre-change values).
      if (p?.pending_change?.req_no) {
        notifySuccess(t('mx.setup_staged', { fields: (p.pending_change.fields ?? []).join(', ') }));
        qc.invalidateQueries({ queryKey: ['tenant-profile-approvals'] });
      } else {
        notifySuccess(t('mx.setup_saved'));
      }
      qc.setQueryData(['tenant-profile'], p); setForm(p as any); setShowErrors(false);
    },
    onError: (e: any) => notifyError(e?.message ?? t('mx.setup_save_failed')),
  });

  const onSave = () => {
    setShowErrors(true);
    if (Object.keys(validate(form)).length > 0) { notifyError(t('mx.setup_fix_before_save')); return; }
    save.mutate();
  };

  return (
    <div>
      <PageHeader
        title={t('mx.setup_title')}
        description={t('mx.setup_desc')}
        actions={q.data ? (
          q.data.setup_complete
            ? <Badge variant="success"><BadgeCheck className="size-3" /> {t('mx.setup_complete_badge')}</Badge>
            : <Badge variant="warning">{t('mx.setup_incomplete_badge')}</Badge>
        ) : null}
      />
      <StateView q={q}>
        <div className="grid max-w-3xl gap-6">
          {/* G15 (audit): PromptPay-id / tax-id changes are staged for a DIFFERENT approver. */}
          <ProfileApprovals />
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Building2 className="size-4 text-primary" /> {t('mx.setup_section_identity')}</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {FIELDS_IDENTITY.map(({ key, label, hint }) => (
                <FormField key={key} htmlFor={key} label={t(label)} hint={hint ? t(hint) : undefined} error={errMsg(key)}>
                  <Input id={key} value={form[key] ?? ''} onChange={set(key)} aria-invalid={!!errFor(key)} />
                </FormField>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ReceiptText className="size-4 text-primary" /> {t('mx.setup_section_vat')}</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <FormField htmlFor="vat_registered" label={t('mx.setup_vat_registered')}>
                <select
                  id="vat_registered"
                  className="h-9 rounded-md border bg-transparent px-3 text-sm"
                  value={form.vat_registered ? '1' : '0'}
                  onChange={(e) => setForm((f) => ({ ...f, vat_registered: e.target.value === '1' }))}
                >
                  <option value="0">{t('mx.setup_vat_no')}</option>
                  <option value="1">{t('mx.setup_vat_yes')}</option>
                </select>
              </FormField>
              <FormField htmlFor="vat_rate" label={t('mx.setup_vat_rate')} hint={t('mx.setup_vat_rate_hint')} error={errMsg('vat_rate')}>
                <Input id="vat_rate" type="number" step="0.0001" value={form.vat_rate ?? 0.07} onChange={set('vat_rate')} className="tabular" aria-invalid={!!errFor('vat_rate')} />
              </FormField>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><MapPin className="size-4 text-primary" /> {t('mx.setup_section_address')}</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {FIELDS_ADDRESS.map(({ key, label, hint }) => (
                <FormField key={key} htmlFor={key} label={t(label)} hint={hint ? t(hint) : undefined} error={errMsg(key)}>
                  <Input id={key} value={form[key] ?? ''} onChange={set(key)} aria-invalid={!!errFor(key)} />
                </FormField>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Palette className="size-4 text-primary" /> {t('mx.setup_section_branding')}</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <FormField htmlFor="logo_url" label={t('mx.setup_logo_label')} className="sm:col-span-2">
                <Input id="logo_url" value={form.logo_url ?? ''} onChange={set('logo_url')} placeholder="https://…/logo.png" />
              </FormField>
              <FormField htmlFor="tagline" label={t('mx.setup_tagline_label')} className="sm:col-span-2">
                <Input id="tagline" value={form.tagline ?? ''} onChange={set('tagline')} placeholder={t('mx.setup_tagline_ph')} />
              </FormField>
              <FormField htmlFor="show_logo" label={t('mx.setup_show_logo')}>
                <select
                  id="show_logo"
                  className="h-9 rounded-md border bg-transparent px-3 text-sm"
                  value={(form.branding_prefs?.show_logo_on_receipt === false) ? '0' : '1'}
                  onChange={(e) => setForm((f) => ({ ...f, branding_prefs: { ...(f.branding_prefs ?? {}), show_logo_on_receipt: e.target.value === '1' } }))}
                >
                  <option value="1">{t('mx.setup_show')}</option>
                  <option value="0">{t('mx.setup_hide')}</option>
                </select>
              </FormField>
              {form.logo_url ? (
                <div className="grid gap-2">
                  <Label>{t('mx.setup_preview')}</Label>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={form.logo_url} alt="logo preview" className="max-h-12 w-fit rounded border bg-white p-1" />
                </div>
              ) : null}
            </CardContent>
          </Card>

          <div className="flex items-center gap-3">
            <Button onClick={onSave} disabled={save.isPending}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {t('mx.setup_save')}
            </Button>
            {showErrors && Object.keys(errors).length > 0 && (
              <span className="text-sm text-destructive" role="alert">{t('mx.setup_errors_count', { count: Object.keys(errors).length })}</span>
            )}
          </div>
        </div>
      </StateView>
    </div>
  );
}

// G15 (audit): tenant PromptPay/Tax-ID maker-checker — a staged change is applied only when a DISTINCT
// approver (exec/approvals) releases it (self-approval → 403 SOD_VIOLATION). Shown only when items are pending.
function ProfileApprovals() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ pending: { req_no: string; tax_id: string | null; promptpay_id: string | null; prev_tax_id: string | null; prev_promptpay_id: string | null; requested_by: string }[] }>({
    queryKey: ['tenant-profile-approvals'], queryFn: () => api('/api/tenant/profile-approvals'),
  });
  const decide = useMutation({
    mutationFn: ({ reqNo, action }: { reqNo: string; action: 'approve' | 'reject' }) => api<any>(`/api/tenant/profile-approvals/${reqNo}/${action}`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (_r, v) => { notifySuccess(v.action === 'approve' ? t('mx.setup_appr_approved') : t('mx.setup_appr_rejected')); q.refetch(); qc.invalidateQueries({ queryKey: ['tenant-profile'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const rows = q.data?.pending ?? [];
  if (!rows.length) return null;
  return (
    <Card className="border-amber-300 dark:border-amber-700">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldAlert className="size-4" /> {t('mx.setup_appr_title')}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">{t('mx.setup_appr_desc')}</p>
        {rows.map((r) => (
          <div key={r.req_no} className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-2.5 text-sm">
            {r.promptpay_id != null && <span>PromptPay: <span className="text-muted-foreground">{r.prev_promptpay_id ?? '—'} →</span> <span className="font-medium">{r.promptpay_id}</span></span>}
            {r.tax_id != null && <span>Tax ID: <span className="text-muted-foreground">{r.prev_tax_id ?? '—'} →</span> <span className="font-medium">{r.tax_id}</span></span>}
            <Badge variant="secondary" className="text-xs">{r.requested_by}</Badge>
            <div className="ml-auto flex gap-2">
              <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ reqNo: r.req_no, action: 'approve' })}>{t('fin.approve')}</Button>
              <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ reqNo: r.req_no, action: 'reject' })}>{t('fnx.bank.reject')}</Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
