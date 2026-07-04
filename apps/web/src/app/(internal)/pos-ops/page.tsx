'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, CreditCard, Clock, Award, Receipt, CalendarClock } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, thaiDate } from '@/lib/format';
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
import { statusVariant } from '@/components/ui';

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

export default function PosOpsPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('px.ops_page_title')} description={t('px.ops_page_desc')} />
      <Tabs tabs={[
        { key: 'tiers', label: t('px.ops_tab_tiers'), content: <Tiers /> },
        { key: 'gift', label: t('px.ops_tab_gift'), content: <GiftCards /> },
        { key: 'house', label: t('px.ops_tab_house'), content: <HouseAccounts /> },
        { key: 'labor', label: t('px.ops_tab_labor'), content: <Labor /> },
      ]} />
    </div>
  );
}

function Tiers() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['loyalty-tiers'], queryFn: () => api('/api/loyalty/tiers') });
  const [f, setF] = useState({ tier: '', min_lifetime: '', earn_mult: '1', redeem_mult: '1' });
  const save = useMutation({ mutationFn: () => api('/api/loyalty/tiers', { method: 'POST', body: JSON.stringify({ tier: f.tier, min_lifetime: Number(f.min_lifetime) || 0, earn_mult: Number(f.earn_mult) || 1, redeem_mult: Number(f.redeem_mult) || 1 }) }), onSuccess: () => { notifySuccess(t('px.ops_saved')); setF({ tier: '', min_lifetime: '', earn_mult: '1', redeem_mult: '1' }); qc.invalidateQueries({ queryKey: ['loyalty-tiers'] }); }, onError: (e: any) => notifyError(e.message) });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">{t('px.ops_add_tier')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t('px.ops_tier_name')} htmlFor="t-tier"><Input id="t-tier" placeholder={t('px.ops_tier_name_ph')} value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })} /></Field>
            <Field label={t('px.ops_min_lifetime')} htmlFor="t-min"><Input id="t-min" type="number" inputMode="numeric" min={0} placeholder="0" value={f.min_lifetime} onChange={(e) => setF({ ...f, min_lifetime: e.target.value })} /></Field>
            <Field label={t('px.ops_earn_mult')} htmlFor="t-earn" hint={t('px.ops_earn_mult_hint')}><Input id="t-earn" type="number" inputMode="decimal" step="0.1" value={f.earn_mult} onChange={(e) => setF({ ...f, earn_mult: e.target.value })} /></Field>
            <Field label={t('px.ops_redeem_mult')} htmlFor="t-redeem"><Input id="t-redeem" type="number" inputMode="decimal" step="0.1" value={f.redeem_mult} onChange={(e) => setF({ ...f, redeem_mult: e.target.value })} /></Field>
          </div>
          <Button disabled={!f.tier || save.isPending} onClick={() => save.mutate()}><Plus className="size-4" /> {save.isPending ? t('px.ops_saving') : t('px.ops_save_tier')}</Button>
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.tiers} rowKey={(r: any) => r.tier} columns={[
          { key: 'tier', label: t('px.ops_col_tier') }, { key: 'min_lifetime', label: t('px.ops_col_min_points'), align: 'right' },
          { key: 'earn_mult', label: t('px.ops_col_earn_mult'), align: 'right', render: (r: any) => `${r.earn_mult}×` },
          { key: 'redeem_mult', label: t('px.ops_col_redeem_mult'), align: 'right', render: (r: any) => `${r.redeem_mult}×` },
        ]} emptyState={{ icon: Award, title: t('px.ops_tier_empty_title'), description: t('px.ops_tier_empty_desc') }} />}
      </StateView>
    </div>
  );
}

function GiftCards() {
  const { t } = useLang();
  const [card, setCard] = useState('');
  const [pin, setPin] = useState('');
  const [amount, setAmount] = useState('');
  const setPinM = useMutation({ mutationFn: () => api(`/api/pos/giftcards/${card}/pin`, { method: 'POST', body: JSON.stringify({ pin }) }), onSuccess: () => notifySuccess(t('px.ops_pin_set')), onError: (e: any) => notifyError(e.message) });
  const check = useMutation({ mutationFn: () => api(`/api/pos/giftcards/${card}/balance?pin=${encodeURIComponent(pin)}`), onSuccess: (r: any) => notifySuccess(t('px.ops_balance_status', { balance: baht(r.balance), status: r.status })), onError: (e: any) => notifyError(e.message) });
  const reload = useMutation({ mutationFn: () => api(`/api/pos/giftcards/${card}/reload`, { method: 'POST', body: JSON.stringify({ amount: Number(amount), pin: pin || undefined }) }), onSuccess: (r: any) => notifySuccess(t('px.ops_reloaded', { balance: baht(r.balance) })), onError: (e: any) => notifyError(e.message) });
  return (
    <Card className="max-w-xl">
      <CardHeader><CardTitle className="text-base">{t('px.ops_gift_title')}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <Field label={t('px.ops_card_no')} htmlFor="g-card"><Input id="g-card" placeholder={t('px.ops_card_no_ph')} value={card} onChange={(e) => setCard(e.target.value)} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="PIN" htmlFor="g-pin"><Input id="g-pin" inputMode="numeric" placeholder="••••" value={pin} onChange={(e) => setPin(e.target.value)} /></Field>
          <Field label={t('px.ops_reload_amount')} htmlFor="g-amt"><Input id="g-amt" type="number" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!card || !pin || setPinM.isPending} onClick={() => setPinM.mutate()}>{t('px.ops_set_pin')}</Button>
          <Button variant="outline" disabled={!card || check.isPending} onClick={() => check.mutate()}><CreditCard className="size-4" /> {t('px.ops_check_balance')}</Button>
          <Button disabled={!card || !amount || reload.isPending} onClick={() => reload.mutate()}>{t('px.ops_reload')}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function HouseAccounts() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['house-account'], queryFn: () => api('/api/pos/house-account') });
  const [f, setF] = useState({ sale_no: '', amount: '', due_date: '' });
  const charge = useMutation({ mutationFn: () => api('/api/pos/house-account', { method: 'POST', body: JSON.stringify({ sale_no: f.sale_no, amount: Number(f.amount), due_date: f.due_date || undefined }) }), onSuccess: () => { notifySuccess(t('px.ops_house_saved')); setF({ sale_no: '', amount: '', due_date: '' }); qc.invalidateQueries({ queryKey: ['house-account'] }); }, onError: (e: any) => notifyError(e.message) });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">{t('px.ops_house_title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('px.ops_bill_no')} htmlFor="h-sale"><Input id="h-sale" placeholder="SALE-…" value={f.sale_no} onChange={(e) => setF({ ...f, sale_no: e.target.value })} /></Field>
            <Field label={t('px.ops_amount_baht')} htmlFor="h-amt"><Input id="h-amt" type="number" inputMode="decimal" placeholder="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label={t('px.ops_due_date')} htmlFor="h-due"><Input id="h-due" type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
          </div>
          <Button disabled={!f.sale_no || !f.amount || charge.isPending} onClick={() => charge.mutate()}>{charge.isPending ? t('px.ops_saving') : t('px.ops_post_house')}</Button>
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && (
          <>
            <div className="mb-2 text-right text-sm">{t('px.ops_total_outstanding')} <strong className="tabular">{baht(q.data.outstanding)}</strong></div>
            <DataTable rows={q.data.invoices} rowKey={(r: any) => r.invoice_no} columns={[
              { key: 'invoice_no', label: t('dash.col_no') }, { key: 'order_no', label: t('px.ops_col_bill') },
              { key: 'amount', label: t('fin.col_amount'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
              { key: 'paid', label: t('px.ops_col_paid'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.paid)}</span> },
              { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status === 'Paid' ? 'paid' : 'open')}>{r.status}</Badge> },
            ]} emptyState={{ icon: Receipt, title: t('px.ops_house_empty_title'), description: t('px.ops_house_empty_desc') }} />
          </>
        )}
      </StateView>
    </div>
  );
}

function Labor() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['labor-report'], queryFn: () => api('/api/pos/labor/report') });
  const [emp, setEmp] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['labor-report'] });
  const cin = useMutation({ mutationFn: () => api('/api/pos/labor/clock-in', { method: 'POST', body: JSON.stringify({ emp_code: emp }) }), onSuccess: () => { notifySuccess(t('px.ops_clocked_in')); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const cout = useMutation({ mutationFn: () => api('/api/pos/labor/clock-out', { method: 'POST', body: JSON.stringify({ emp_code: emp }) }), onSuccess: (r: any) => { notifySuccess(t('px.ops_clocked_out', { hours: r.hours })); refresh(); }, onError: (e: any) => notifyError(e.message) });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">{t('px.ops_labor_title')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label={t('px.ops_emp_code')} htmlFor="l-emp" className="w-full sm:max-w-[220px]"><Input id="l-emp" placeholder={t('px.ops_emp_code_ph')} value={emp} onChange={(e) => setEmp(e.target.value)} /></Field>
            <div className="flex gap-2">
              <Button disabled={!emp || cin.isPending} onClick={() => cin.mutate()}><Clock className="size-4" /> {t('px.ops_clock_in')}</Button>
              <Button variant="outline" disabled={!emp || cout.isPending} onClick={() => cout.mutate()}>{t('px.ops_clock_out')}</Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && (
          <>
            <div className="mb-2 text-sm text-muted-foreground">{t('px.ops_labor_summary', { total: q.data.total_hours, open: q.data.open_count })}</div>
            <DataTable rows={q.data.entries} columns={[
              { key: 'emp_code', label: t('px.ops_col_emp') },
              { key: 'clock_in', label: t('px.ops_clock_in'), render: (r: any) => thaiDate(r.clock_in) },
              { key: 'clock_out', label: t('px.ops_clock_out'), render: (r: any) => thaiDate(r.clock_out) },
              { key: 'break_minutes', label: t('px.ops_col_break'), align: 'right' },
              { key: 'hours', label: t('px.ops_col_hours'), align: 'right' },
              { key: 'clock_in_method', label: t('px.ops_col_method'), render: (r: any) => r.clock_in_method ?? 'PIN' },
              { key: 'geofence_pass', label: t('px.ops_col_geofence'), align: 'center', render: (r: any) => r.geofence_pass === false ? <Badge variant="destructive">{t('px.ops_out_of_area')}</Badge> : r.geofence_pass === true ? <Badge variant="secondary">{t('px.ops_in_area')}</Badge> : <span className="text-muted-foreground">—</span> },
            ]} emptyState={{ icon: CalendarClock, title: t('px.ops_labor_empty_title'), description: t('px.ops_labor_empty_desc') }} />
          </>
        )}
      </StateView>
    </div>
  );
}
