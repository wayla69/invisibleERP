'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, PackageCheck, Wrench, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
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
import { Select } from '@/components/form-controls';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Term { id: number; term_code: string; name: string; coverage_months: number; coverage_type: string; active: boolean }
interface Unit { id: number; serial_no: string; item_code: string; customer_name: string | null; sold_date: string | null; warranty_term_id: number | null; warranty_start: string | null; warranty_end: string | null; coverage_type: string; status: string }
interface Claim { id: number; claim_no: string; installed_base_id: number; reported_date: string | null; fault: string; coverage_kind: string; disposition: string | null; status: string; is_in_coverage: boolean; charge: number; requested_by: string | null; authorized_by: string | null; reject_reason: string | null }

const COVERAGE = ['full', 'parts', 'labor'];

// SVC-2 — Warranty & Entitlement registry (control SVC-01). Four tabs: the warranty-term catalogue, the
// installed-base serialized-unit registry, warranty claims with the coverage-authorization maker-checker, and
// the coverage-exceptions override register. Reads gate marketing/exec; catalogue/registry writes masterdata;
// claim raise exec; authorize/reject approvals — the requester≠authorizer rule (SVC-01) is enforced in-app.
export default function WarrantyClient({ initialTerms }: { initialTerms?: unknown }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('wty.title')} description={t('wty.subtitle')} />
      <Tabs
        tabs={[
          { key: 'terms', label: t('wty.tab_terms'), content: <Terms initialTerms={initialTerms} /> },
          { key: 'units', label: t('wty.tab_units'), content: <Units /> },
          { key: 'claims', label: t('wty.tab_claims'), content: <Claims /> },
          { key: 'exceptions', label: t('wty.tab_exceptions'), content: <Exceptions /> },
        ]}
      />
    </div>
  );
}

function Terms({ initialTerms }: { initialTerms?: unknown }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ terms: Term[]; count: number }>({ queryKey: ['wty-terms'], queryFn: () => api('/api/service/warranty/terms'), initialData: initialTerms as { terms: Term[]; count: number } | undefined });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [months, setMonths] = useState('12');
  const [type, setType] = useState('full');

  const create = useMutation({
    mutationFn: () => api('/api/service/warranty/terms', { method: 'POST', body: JSON.stringify({ term_code: code, name, coverage_months: Number(months) || 0, coverage_type: type }) }),
    onSuccess: (r: any) => { notifySuccess(t('wty.term_created', { code: r.term_code })); setCode(''); setName(''); qc.invalidateQueries({ queryKey: ['wty-terms'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const terms = q.data?.terms ?? [];
  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4">
        <CardHeader><CardTitle className="text-base">{t('wty.new_term')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2"><Label htmlFor="wt-code">{t('wty.term_code')}</Label><Input id="wt-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="W12" /></div>
            <div className="grid gap-2"><Label htmlFor="wt-name">{t('wty.term_name')}</Label><Input id="wt-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="wt-months">{t('wty.coverage_months')}</Label><Input id="wt-months" type="number" min="1" value={months} onChange={(e) => setMonths(e.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="wt-type">{t('wty.coverage_type')}</Label><Select id="wt-type" value={type} onChange={(e) => setType(e.target.value)}>{COVERAGE.map((c) => <option key={c} value={c}>{c}</option>)}</Select></div>
          </div>
          <Button disabled={create.isPending || !code.trim() || !name.trim()} onClick={() => create.mutate()}><Plus className="size-4" /> {create.isPending ? t('wty.saving') : t('wty.new_term')}</Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={terms}
            emptyState={{ icon: ShieldCheck, title: t('wty.no_terms_title'), description: t('wty.no_terms_desc') }}
            columns={[
              { key: 'term_code', label: t('wty.term_code') },
              { key: 'name', label: t('wty.term_name') },
              { key: 'coverage_months', label: t('wty.coverage_months'), align: 'right', render: (r: Term) => <span className="tabular">{num(r.coverage_months)}</span> },
              { key: 'coverage_type', label: t('wty.coverage_type'), render: (r: Term) => <Badge variant="info">{r.coverage_type}</Badge> },
              { key: 'active', label: t('wty.active'), render: (r: Term) => <Badge variant={r.active ? 'success' : 'secondary'}>{r.active ? t('wty.active') : '—'}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

function Units() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ units: Unit[]; count: number }>({ queryKey: ['wty-units'], queryFn: () => api('/api/service/warranty/units') });
  const termsQ = useQuery<{ terms: Term[] }>({ queryKey: ['wty-terms'], queryFn: () => api('/api/service/warranty/terms') });

  const [serial, setSerial] = useState('');
  const [item, setItem] = useState('');
  const [customer, setCustomer] = useState('');
  const [soldDate, setSoldDate] = useState('2026-01-01');
  const [termId, setTermId] = useState('');

  const create = useMutation({
    mutationFn: () => api('/api/service/warranty/units', { method: 'POST', body: JSON.stringify({ serial_no: serial, item_code: item, customer_name: customer || undefined, sold_date: soldDate, warranty_term_id: Number(termId) }) }),
    onSuccess: (r: any) => { notifySuccess(t('wty.unit_registered', { serial: r.serial_no })); setSerial(''); setItem(''); setCustomer(''); qc.invalidateQueries({ queryKey: ['wty-units'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const units = q.data?.units ?? [];
  const terms = termsQ.data?.terms ?? [];
  const active = units.filter((u) => u.status === 'active').length;
  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard label={t('wty.tab_units')} value={num(units.length)} icon={PackageCheck} tone="primary" />
            <StatCard label={t('wty.active')} value={num(active)} tone="success" />
          </div>
        )}
      </StateView>

      <Card className="max-w-3xl gap-4">
        <CardHeader><CardTitle className="text-base">{t('wty.new_unit')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2"><Label htmlFor="wu-serial">{t('wty.serial_no')}</Label><Input id="wu-serial" value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="SN-0001" /></div>
            <div className="grid gap-2"><Label htmlFor="wu-item">{t('wty.item_code')}</Label><Input id="wu-item" value={item} onChange={(e) => setItem(e.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="wu-cust">{t('wty.customer')}</Label><Input id="wu-cust" value={customer} onChange={(e) => setCustomer(e.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="wu-sold">{t('wty.sold_date')}</Label><Input id="wu-sold" type="date" value={soldDate} onChange={(e) => setSoldDate(e.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="wu-term">{t('wty.term')}</Label><Select id="wu-term" value={termId} onChange={(e) => setTermId(e.target.value)}><option value="">—</option>{terms.map((tm) => <option key={tm.id} value={tm.id}>{tm.term_code} · {tm.coverage_months}mo {tm.coverage_type}</option>)}</Select></div>
          </div>
          <Button disabled={create.isPending || !serial.trim() || !item.trim() || !termId} onClick={() => create.mutate()}><Plus className="size-4" /> {create.isPending ? t('wty.saving') : t('wty.register')}</Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={units}
            emptyState={{ icon: PackageCheck, title: t('wty.no_units_title'), description: t('wty.no_units_desc') }}
            columns={[
              { key: 'serial_no', label: t('wty.serial_no') },
              { key: 'item_code', label: t('wty.item_code') },
              { key: 'customer_name', label: t('wty.customer') },
              { key: 'coverage_type', label: t('wty.coverage_type'), render: (r: Unit) => <Badge variant="info">{r.coverage_type}</Badge> },
              { key: 'warranty_end', label: t('wty.warranty_end'), render: (r: Unit) => thaiDate(r.warranty_end) },
              { key: 'status', label: t('wty.status'), render: (r: Unit) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

function Claims() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ claims: Claim[]; count: number }>({ queryKey: ['wty-claims'], queryFn: () => api('/api/service/warranty/claims') });
  const unitsQ = useQuery<{ units: Unit[] }>({ queryKey: ['wty-units'], queryFn: () => api('/api/service/warranty/units') });

  const [unitId, setUnitId] = useState('');
  const [fault, setFault] = useState('');
  const [kind, setKind] = useState('full');
  const [authTarget, setAuthTarget] = useState<Claim | null>(null);

  const raise = useMutation({
    mutationFn: () => api('/api/service/warranty/claims', { method: 'POST', body: JSON.stringify({ installed_base_id: Number(unitId), fault, coverage_kind: kind }) }),
    onSuccess: (r: any) => { notifySuccess(t('wty.claim_raised', { no: r.claim_no })); setFault(''); qc.invalidateQueries({ queryKey: ['wty-claims'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const reject = useMutation({
    mutationFn: (id: number) => api(`/api/service/warranty/claims/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason: window.prompt(t('wty.reject_reason')) ?? '' }) }),
    onSuccess: () => { notifySuccess(t('wty.rejected_ok')); qc.invalidateQueries({ queryKey: ['wty-claims'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const claims = q.data?.claims ?? [];
  const units = unitsQ.data?.units ?? [];
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0" /> {t('wty.svc01_hint')}
      </div>

      <Card className="max-w-3xl gap-4">
        <CardHeader><CardTitle className="text-base">{t('wty.new_claim')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2"><Label htmlFor="wc-unit">{t('wty.unit')}</Label><Select id="wc-unit" value={unitId} onChange={(e) => setUnitId(e.target.value)}><option value="">—</option>{units.map((u) => <option key={u.id} value={u.id}>{u.serial_no} · {u.item_code}</option>)}</Select></div>
            <div className="grid gap-2"><Label htmlFor="wc-kind">{t('wty.coverage_kind')}</Label><Select id="wc-kind" value={kind} onChange={(e) => setKind(e.target.value)}>{COVERAGE.map((c) => <option key={c} value={c}>{c}</option>)}</Select></div>
            <div className="grid gap-2 sm:col-span-2"><Label htmlFor="wc-fault">{t('wty.fault')}</Label><Input id="wc-fault" value={fault} onChange={(e) => setFault(e.target.value)} /></div>
          </div>
          <Button disabled={raise.isPending || !unitId || !fault.trim()} onClick={() => raise.mutate()}><Plus className="size-4" /> {raise.isPending ? t('wty.saving') : t('wty.new_claim')}</Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={claims}
            emptyState={{ icon: Wrench, title: t('wty.no_claims_title'), description: t('wty.no_claims_desc') }}
            columns={[
              { key: 'claim_no', label: t('wty.tab_claims') },
              { key: 'fault', label: t('wty.fault') },
              { key: 'coverage_kind', label: t('wty.coverage_kind') },
              { key: 'is_in_coverage', label: t('wty.in_coverage'), render: (r: Claim) => <Badge variant={r.is_in_coverage ? 'success' : 'destructive'}>{r.is_in_coverage ? t('wty.in_coverage') : t('wty.out_of_coverage')}</Badge> },
              { key: 'charge', label: t('wty.charge'), align: 'right', render: (r: Claim) => <span className="tabular">{baht(r.charge)}</span> },
              { key: 'status', label: t('wty.status'), render: (r: Claim) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              { key: 'requested_by', label: t('wty.requested_by') },
              { key: 'authorized_by', label: t('wty.authorized_by') },
              {
                key: 'actions', label: '', align: 'right',
                render: (r: Claim) => r.status !== 'pending' ? null : (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setAuthTarget(r)}>{t('wty.authorize')}</Button>
                    <Button size="sm" variant="ghost" disabled={reject.isPending} onClick={() => reject.mutate(r.id)}>{t('wty.reject')}</Button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </StateView>

      {authTarget && <AuthorizeDialog claim={authTarget} onClose={() => setAuthTarget(null)} />}
    </div>
  );
}

function AuthorizeDialog({ claim, onClose }: { claim: Claim; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [disposition, setDisposition] = useState('repair');
  const [charge, setCharge] = useState('0');

  const authorize = useMutation({
    mutationFn: () => api(`/api/service/warranty/claims/${claim.id}/authorize`, { method: 'POST', body: JSON.stringify({ disposition, charge: Number(charge) || 0 }) }),
    onSuccess: () => { notifySuccess(t('wty.authorized_ok')); qc.invalidateQueries({ queryKey: ['wty-claims'] }); onClose(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{t('wty.authorize_title', { no: claim.claim_no })}</DialogTitle></DialogHeader>
        {!claim.is_in_coverage && (
          <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            <AlertTriangle className="size-4 shrink-0" /> {t('wty.out_of_coverage')}
          </div>
        )}
        <div className="grid gap-4">
          <div className="grid gap-2"><Label htmlFor="wa-disp">{t('wty.disposition')}</Label><Select id="wa-disp" value={disposition} onChange={(e) => setDisposition(e.target.value)}>{['repair', 'replace'].map((d) => <option key={d} value={d}>{d}</option>)}</Select></div>
          <div className="grid gap-2"><Label htmlFor="wa-charge">{t('wty.charge')}</Label><Input id="wa-charge" type="number" min="0" value={charge} onChange={(e) => setCharge(e.target.value)} /></div>
          <Button disabled={authorize.isPending} onClick={() => authorize.mutate()}>{authorize.isPending ? t('wty.saving') : t('wty.authorize')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Exceptions() {
  const { t } = useLang();
  const q = useQuery<{ exceptions: Claim[]; count: number }>({ queryKey: ['wty-exceptions'], queryFn: () => api('/api/service/warranty/coverage-exceptions') });
  const rows = q.data?.exceptions ?? [];
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <AlertTriangle className="size-4 shrink-0" /> {t('wty.exceptions_hint')}
      </div>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            emptyState={{ icon: ShieldCheck, title: t('wty.no_exceptions_title'), description: t('wty.no_exceptions_desc') }}
            columns={[
              { key: 'claim_no', label: t('wty.tab_claims') },
              { key: 'fault', label: t('wty.fault') },
              { key: 'coverage_kind', label: t('wty.coverage_kind') },
              { key: 'disposition', label: t('wty.disposition') },
              { key: 'charge', label: t('wty.charge'), align: 'right', render: (r: Claim) => <span className="tabular">{baht(r.charge)}</span> },
              { key: 'requested_by', label: t('wty.requested_by') },
              { key: 'authorized_by', label: t('wty.authorized_by') },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
