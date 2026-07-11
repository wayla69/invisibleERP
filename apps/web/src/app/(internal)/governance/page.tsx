'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Landmark, ShieldCheck, Megaphone, Scale, AlertTriangle, CalendarCheck, Check, Plus, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useLang } from '@/lib/i18n';
import { Select } from '@/components/form-controls';

const POLICY_VERSION = '1.0';
const lvl = (t: (k: string) => string, v?: string | null) => (v ? t(`gov.lvl_${v}`) : '—');
const caseTone = (s: string) => (s === 'resolved' ? 'success' : s === 'dismissed' ? 'muted' : s === 'investigating' ? 'warning' : 'secondary');
const riskTone = (s: string) => (s === 'closed' || s === 'mitigated' ? 'success' : s === 'accepted' ? 'warning' : 'secondary');

export default function GovernancePage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('gov.title')} description={t('gov.desc')} />
      <Tabs
        tabs={[
          { key: 'overview', label: t('gov.tab_overview'), content: <Overview /> },
          { key: 'ethics', label: t('gov.tab_ethics'), content: <Ethics /> },
          { key: 'hotline', label: t('gov.tab_hotline'), content: <Hotline /> },
          { key: 'doa', label: t('gov.tab_doa'), content: <Doa /> },
          { key: 'fraud', label: t('gov.tab_fraud'), content: <Fraud /> },
          { key: 'oversight', label: t('gov.tab_oversight'), content: <Oversight /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Overview (readiness) ─────────────────────────
function Overview() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['gov-readiness'], queryFn: () => api(`/api/governance/readiness?policy_version=${POLICY_VERSION}`) });
  const r = q.data;
  return (
    <StateView q={q}>
      {r && (
        <div className="space-y-6">
          <div className={`flex items-center gap-2 rounded-lg border p-4 text-sm ${r.ready ? 'border-success/30 bg-success/10 text-success' : 'border-warning/30 bg-warning/10 text-warning-foreground'}`}>
            {r.ready ? <ShieldCheck className="size-5" /> : <TriangleAlert className="size-5" />}
            <span className="font-medium">{r.ready ? t('gov.ov_ready') : t('gov.ov_not_ready', { n: num(r.alerts.length) })}</span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <StatCard label={t('gov.ov_coverage')} value={`${r.ethics.coverage_pct}%`} icon={ShieldCheck} tone={r.ethics.outstanding.length ? 'warning' : 'success'}
              hint={t('gov.ov_coverage_hint', { acked: num(r.ethics.acknowledged), total: num(r.ethics.total_active_staff) })} />
            <StatCard label={t('gov.ov_open_cases')} value={num(r.hotline.open_cases)} icon={Megaphone} tone={r.hotline.overdue_cases ? 'warning' : 'default'}
              hint={t('gov.ov_cases_hint', { overdue: num(r.hotline.overdue_cases), age: num(r.hotline.oldest_open_age_days) })} />
            <StatCard label={t('gov.ov_oversight')} value={r.oversight.last_meeting ?? '—'} icon={CalendarCheck} tone={r.oversight.overdue ? 'warning' : 'info'}
              hint={r.oversight.overdue ? t('gov.ov_oversight_overdue') : t('gov.ov_oversight_hint', { due: r.oversight.next_due ?? '—' })} />
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">{t('gov.ov_alerts_title')}</CardTitle></CardHeader>
            <CardContent>
              {r.alerts.length === 0
                ? <p className="text-sm text-muted-foreground">{t('gov.ov_no_alerts')}</p>
                : <ul className="space-y-2">{r.alerts.map((a: string, i: number) => (
                    <li key={i} className="flex items-start gap-2 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" /><span>{a}</span></li>
                  ))}</ul>}
            </CardContent>
          </Card>
        </div>
      )}
    </StateView>
  );
}

// ───────────────────────── Ethics (ELC-01) ─────────────────────────
function Ethics() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['gov-ethics'], queryFn: () => api(`/api/governance/ethics/register?policy_version=${POLICY_VERSION}`) });
  const ack = useMutation({
    mutationFn: () => api('/api/governance/ethics/acknowledge', { method: 'POST', body: JSON.stringify({ policy_version: POLICY_VERSION }) }),
    onSuccess: () => { notifySuccess(t('gov.eth_ack_ok', { v: POLICY_VERSION })); qc.invalidateQueries({ queryKey: ['gov-ethics'] }); qc.invalidateQueries({ queryKey: ['gov-readiness'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <div className="space-y-6">
      <Card className="max-w-xl">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="text-sm"><span className="text-muted-foreground">{t('gov.ov_version_label')}: </span><span className="font-medium">v{POLICY_VERSION}</span></div>
          <Button disabled={ack.isPending} onClick={() => ack.mutate()}><Check className="size-4" /> {t('gov.eth_ack_btn')}</Button>
        </CardContent>
      </Card>
      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('gov.eth_reg_title')}</h3>
        <StateView q={q}>
          <DataTable
            rows={q.data?.register ?? []}
            rowKey={(r: any) => r.username}
            columns={[
              { key: 'username', label: t('gov.col_user') },
              { key: 'policy_version', label: t('gov.col_version'), render: (r: any) => `v${r.policy_version}` },
              { key: 'acknowledged_at', label: t('gov.col_acked_at'), render: (r: any) => fmtDate(r.acknowledged_at) },
            ]}
            emptyState={{ icon: ShieldCheck, title: t('gov.eth_empty_title'), description: t('gov.eth_empty_desc') }}
          />
        </StateView>
      </div>
    </div>
  );
}

// ───────────────────────── Hotline (ELC-04) ─────────────────────────
function Hotline() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['gov-cases'], queryFn: () => api('/api/governance/hotline/cases') });
  const [allegation, setAllegation] = useState('');
  const [category, setCategory] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [advancing, setAdvancing] = useState<any | null>(null);

  const file = useMutation({
    mutationFn: () => api<{ case_ref: string }>('/api/governance/hotline/cases', { method: 'POST', body: JSON.stringify({ allegation, category: category || undefined, anonymous }) }),
    onSuccess: (r) => { notifySuccess(t('gov.hl_filed_ok', { ref: r.case_ref })); setAllegation(''); setCategory(''); setAnonymous(false); qc.invalidateQueries({ queryKey: ['gov-cases'] }); qc.invalidateQueries({ queryKey: ['gov-readiness'] }); },
    onError: (e: Error) => notifyError(e.message),
  });

  return (
    <div className="space-y-6">
      <Card className="max-w-2xl">
        <CardHeader><CardTitle className="text-base">{t('gov.hl_file_title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="hl-alg">{t('gov.hl_allegation')}</Label>
            <textarea id="hl-alg" className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={allegation} onChange={(e) => setAllegation(e.target.value)} placeholder={t('gov.hl_allegation_ph')} />
          </div>
          <div className="grid gap-2 sm:max-w-xs">
            <Label htmlFor="hl-cat">{t('gov.hl_category')}</Label>
            <Input id="hl-cat" value={category} onChange={(e) => setCategory(e.target.value)} placeholder={t('gov.hl_category_ph')} />
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} /> {t('gov.hl_anon')}</label>
          <Button disabled={!allegation || file.isPending} onClick={() => file.mutate()}><Megaphone className="size-4" /> {t('gov.hl_file_btn')}</Button>
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('gov.hl_log_title')}</h3>
        <StateView q={q}>
          <DataTable
            rows={q.data?.cases ?? []}
            rowKey={(r: any) => r.case_ref}
            columns={[
              { key: 'case_ref', label: t('gov.col_case_ref') },
              { key: 'category', label: t('gov.col_category'), render: (r: any) => r.category || '—' },
              { key: 'allegation', label: t('gov.col_allegation'), render: (r: any) => <span className="line-clamp-2">{r.allegation}</span> },
              { key: 'reporter', label: t('gov.col_reporter'), render: (r: any) => r.anonymous ? <Badge variant="muted">{t('gov.hl_anon_label')}</Badge> : (r.reporter || '—') },
              { key: 'status', label: t('gov.col_status'), render: (r: any) => <Badge variant={caseTone(r.status)}>{t(`gov.case_${r.status}`)}</Badge> },
              { key: 'submitted_at', label: t('gov.col_submitted'), render: (r: any) => fmtDate(r.submitted_at) },
              { key: 'actions', label: '', align: 'right', render: (r: any) => <Button size="sm" variant="outline" onClick={() => setAdvancing(r)}>{t('gov.hl_advance')}</Button> },
            ]}
            emptyState={{ icon: Megaphone, title: t('gov.hl_empty_title'), description: t('gov.hl_empty_desc') }}
          />
        </StateView>
      </div>

      {advancing && <AdvanceCaseDialog c={advancing} onClose={() => setAdvancing(null)} />}
    </div>
  );
}

function AdvanceCaseDialog({ c, onClose }: { c: any; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [status, setStatus] = useState(c.status);
  const [note, setNote] = useState(c.resolution_note ?? '');
  const save = useMutation({
    mutationFn: () => api(`/api/governance/hotline/cases/${encodeURIComponent(c.case_ref)}`, { method: 'PATCH', body: JSON.stringify({ status, resolution_note: note || undefined }) }),
    onSuccess: () => { notifySuccess(c.case_ref); qc.invalidateQueries({ queryKey: ['gov-cases'] }); qc.invalidateQueries({ queryKey: ['gov-readiness'] }); onClose(); },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{t('gov.hl_advance_title', { ref: c.case_ref })}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="ac-status">{t('gov.col_status')}</Label>
            <Select id="ac-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {['received', 'investigating', 'resolved', 'dismissed'].map((s) => <option key={s} value={s}>{t(`gov.case_${s}`)}</option>)}
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ac-note">{t('gov.hl_resolution_note')}</Label>
            <textarea id="ac-note" className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('fin.cancel')}</Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? t('gov.saving') : t('gov.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── DoA matrix (ELC-03) ─────────────────────────
function Doa() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['gov-doa'], queryFn: () => api('/api/governance/doa') });
  const [area, setArea] = useState('');
  const [role, setRole] = useState('');
  const [limit, setLimit] = useState('');
  const [currency, setCurrency] = useState('THB');
  const [notes, setNotes] = useState('');
  const save = useMutation({
    mutationFn: () => api('/api/governance/doa', { method: 'POST', body: JSON.stringify({ authority_area: area, role, approval_limit: limit === '' ? null : Number(limit), currency, notes: notes || undefined }) }),
    onSuccess: () => { notifySuccess(t('gov.doa_added_ok', { area, role })); setArea(''); setRole(''); setLimit(''); setNotes(''); qc.invalidateQueries({ queryKey: ['gov-doa'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <div className="space-y-6">
      <Card className="max-w-2xl">
        <CardHeader><CardTitle className="text-base">{t('gov.doa_add_title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2"><Label htmlFor="doa-area">{t('gov.doa_area')}</Label><Input id="doa-area" value={area} onChange={(e) => setArea(e.target.value)} placeholder={t('gov.doa_area_ph')} /></div>
            <div className="grid gap-2"><Label htmlFor="doa-role">{t('gov.doa_role')}</Label><Input id="doa-role" value={role} onChange={(e) => setRole(e.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="doa-limit">{t('gov.doa_limit')}</Label><Input id="doa-limit" type="number" min="0" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder={t('gov.doa_no_limit')} /></div>
            <div className="grid gap-2"><Label htmlFor="doa-cur">{t('gov.doa_currency')}</Label><Input id="doa-cur" value={currency} onChange={(e) => setCurrency(e.target.value)} /></div>
          </div>
          <div className="grid gap-2"><Label htmlFor="doa-notes">{t('gov.doa_notes')}</Label><Input id="doa-notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          <Button disabled={!area || !role || save.isPending} onClick={() => save.mutate()}><Plus className="size-4" /> {t('gov.doa_add_btn')}</Button>
        </CardContent>
      </Card>
      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('gov.doa_matrix_title')}</h3>
        <StateView q={q}>
          <DataTable
            rows={q.data?.matrix ?? []}
            rowKey={(r: any) => `${r.authority_area}·${r.role}`}
            columns={[
              { key: 'authority_area', label: t('gov.col_area') },
              { key: 'role', label: t('gov.col_role') },
              { key: 'approval_limit', label: t('gov.col_limit'), align: 'right', render: (r: any) => r.approval_limit == null ? <span className="text-muted-foreground">{t('gov.doa_no_limit')}</span> : <span className="tabular">{num(r.approval_limit)}</span> },
              { key: 'currency', label: t('gov.col_currency'), render: (r: any) => r.currency || '—' },
              { key: 'notes', label: t('gov.col_notes'), render: (r: any) => r.notes || '—' },
            ]}
            emptyState={{ icon: Scale, title: t('gov.doa_empty_title'), description: t('gov.doa_empty_desc') }}
          />
        </StateView>
      </div>
    </div>
  );
}

// ───────────────────────── Fraud-risk register (ELC-05) ─────────────────────────
function Fraud() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['gov-fraud'], queryFn: () => api('/api/governance/fraud-risks') });
  const [area, setArea] = useState('');
  const [description, setDescription] = useState('');
  const [likelihood, setLikelihood] = useState('medium');
  const [impact, setImpact] = useState('medium');
  const [controls, setControls] = useState('');
  const [owner, setOwner] = useState('');
  const [reviewing, setReviewing] = useState<any | null>(null);
  const file = useMutation({
    mutationFn: () => api<{ risk_ref: string }>('/api/governance/fraud-risks', { method: 'POST', body: JSON.stringify({ area, description, likelihood, impact, mitigating_controls: controls || undefined, owner: owner || undefined }) }),
    onSuccess: (r) => { notifySuccess(t('gov.fr_filed_ok', { ref: r.risk_ref })); setArea(''); setDescription(''); setControls(''); setOwner(''); qc.invalidateQueries({ queryKey: ['gov-fraud'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <div className="space-y-6">
      <Card className="max-w-2xl">
        <CardHeader><CardTitle className="text-base">{t('gov.fr_file_title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2"><Label htmlFor="fr-area">{t('gov.fr_area')}</Label><Input id="fr-area" value={area} onChange={(e) => setArea(e.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="fr-owner">{t('gov.fr_owner')}</Label><Input id="fr-owner" value={owner} onChange={(e) => setOwner(e.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="fr-lik">{t('gov.fr_likelihood')}</Label><Select id="fr-lik" value={likelihood} onChange={(e) => setLikelihood(e.target.value)}>{['low', 'medium', 'high'].map((v) => <option key={v} value={v}>{t(`gov.lvl_${v}`)}</option>)}</Select></div>
            <div className="grid gap-2"><Label htmlFor="fr-imp">{t('gov.fr_impact')}</Label><Select id="fr-imp" value={impact} onChange={(e) => setImpact(e.target.value)}>{['low', 'medium', 'high'].map((v) => <option key={v} value={v}>{t(`gov.lvl_${v}`)}</option>)}</Select></div>
          </div>
          <div className="grid gap-2"><Label htmlFor="fr-desc">{t('gov.fr_desc')}</Label><Input id="fr-desc" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="fr-ctl">{t('gov.fr_controls')}</Label><Input id="fr-ctl" value={controls} onChange={(e) => setControls(e.target.value)} /></div>
          <Button disabled={!area || !description || file.isPending} onClick={() => file.mutate()}><AlertTriangle className="size-4" /> {t('gov.fr_file_btn')}</Button>
        </CardContent>
      </Card>
      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('gov.fr_reg_title')}</h3>
        <StateView q={q}>
          <DataTable
            rows={q.data?.risks ?? []}
            rowKey={(r: any) => r.risk_ref}
            columns={[
              { key: 'risk_ref', label: t('gov.col_risk_ref') },
              { key: 'area', label: t('gov.col_area') },
              { key: 'description', label: t('gov.col_desc'), render: (r: any) => <span className="line-clamp-2">{r.description}</span> },
              { key: 'likelihood', label: t('gov.col_likelihood'), render: (r: any) => lvl(t, r.likelihood) },
              { key: 'impact', label: t('gov.col_impact'), render: (r: any) => lvl(t, r.impact) },
              { key: 'owner', label: t('gov.col_owner'), render: (r: any) => r.owner || '—' },
              { key: 'status', label: t('gov.col_status'), render: (r: any) => <Badge variant={riskTone(r.status)}>{t(`gov.risk_${r.status}`)}</Badge> },
              { key: 'actions', label: '', align: 'right', render: (r: any) => <Button size="sm" variant="outline" onClick={() => setReviewing(r)}>{t('gov.fr_review')}</Button> },
            ]}
            emptyState={{ icon: AlertTriangle, title: t('gov.fr_empty_title'), description: t('gov.fr_empty_desc') }}
          />
        </StateView>
      </div>
      {reviewing && <ReviewRiskDialog r={reviewing} onClose={() => setReviewing(null)} />}
    </div>
  );
}

function ReviewRiskDialog({ r, onClose }: { r: any; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [status, setStatus] = useState(r.status);
  const [controls, setControls] = useState(r.mitigating_controls ?? '');
  const [owner, setOwner] = useState(r.owner ?? '');
  const save = useMutation({
    mutationFn: () => api(`/api/governance/fraud-risks/${encodeURIComponent(r.risk_ref)}`, { method: 'PATCH', body: JSON.stringify({ status, mitigating_controls: controls || undefined, owner: owner || undefined }) }),
    onSuccess: () => { notifySuccess(r.risk_ref); qc.invalidateQueries({ queryKey: ['gov-fraud'] }); onClose(); },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{t('gov.fr_review_title', { ref: r.risk_ref })}</DialogTitle><DialogDescription className="line-clamp-2">{r.description}</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-2"><Label htmlFor="rr-status">{t('gov.col_status')}</Label>
            <Select id="rr-status" value={status} onChange={(e) => setStatus(e.target.value)}>{['open', 'mitigated', 'accepted', 'closed'].map((s) => <option key={s} value={s}>{t(`gov.risk_${s}`)}</option>)}</Select></div>
          <div className="grid gap-2"><Label htmlFor="rr-ctl">{t('gov.fr_controls')}</Label><Input id="rr-ctl" value={controls} onChange={(e) => setControls(e.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="rr-owner">{t('gov.fr_owner')}</Label><Input id="rr-owner" value={owner} onChange={(e) => setOwner(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('fin.cancel')}</Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? t('gov.saving') : t('gov.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Oversight log (ELC-02) ─────────────────────────
function Oversight() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['gov-oversight'], queryFn: () => api('/api/governance/oversight') });
  const [meetingDate, setMeetingDate] = useState('');
  const [kind, setKind] = useState('');
  const [topics, setTopics] = useState('');
  const [icfr, setIcfr] = useState(false);
  const [attendees, setAttendees] = useState('');
  const [minutesRef, setMinutesRef] = useState('');
  const [signedBy, setSignedBy] = useState('');
  const save = useMutation({
    mutationFn: () => api('/api/governance/oversight', { method: 'POST', body: JSON.stringify({ meeting_date: meetingDate, kind: kind || undefined, topics: topics || undefined, icfr_reviewed: icfr, attendees: attendees || undefined, minutes_ref: minutesRef || undefined, signed_off_by: signedBy || undefined }) }),
    onSuccess: () => { notifySuccess(t('gov.os_rec_ok', { date: meetingDate })); setMeetingDate(''); setKind(''); setTopics(''); setIcfr(false); setAttendees(''); setMinutesRef(''); setSignedBy(''); qc.invalidateQueries({ queryKey: ['gov-oversight'] }); qc.invalidateQueries({ queryKey: ['gov-readiness'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <div className="space-y-6">
      <Card className="max-w-2xl">
        <CardHeader><CardTitle className="text-base">{t('gov.os_rec_title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2"><Label htmlFor="os-date">{t('gov.os_meeting_date')}</Label><Input id="os-date" type="date" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="os-kind">{t('gov.os_kind')}</Label><Input id="os-kind" value={kind} onChange={(e) => setKind(e.target.value)} placeholder={t('gov.os_kind_ph')} /></div>
            <div className="grid gap-2"><Label htmlFor="os-att">{t('gov.os_attendees')}</Label><Input id="os-att" value={attendees} onChange={(e) => setAttendees(e.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="os-min">{t('gov.os_minutes_ref')}</Label><Input id="os-min" value={minutesRef} onChange={(e) => setMinutesRef(e.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="os-sign">{t('gov.os_signed_by')}</Label><Input id="os-sign" value={signedBy} onChange={(e) => setSignedBy(e.target.value)} /></div>
          </div>
          <div className="grid gap-2"><Label htmlFor="os-topics">{t('gov.os_topics')}</Label><Input id="os-topics" value={topics} onChange={(e) => setTopics(e.target.value)} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={icfr} onChange={(e) => setIcfr(e.target.checked)} /> {t('gov.os_icfr')}</label>
          <Button disabled={!meetingDate || save.isPending} onClick={() => save.mutate()}><CalendarCheck className="size-4" /> {t('gov.os_rec_btn')}</Button>
        </CardContent>
      </Card>
      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('gov.os_log_title')}</h3>
        <StateView q={q}>
          <DataTable
            rows={q.data?.meetings ?? []}
            rowKey={(r: any) => r.id}
            columns={[
              { key: 'meeting_date', label: t('gov.col_date'), render: (r: any) => fmtDate(r.meeting_date) },
              { key: 'kind', label: t('gov.col_kind'), render: (r: any) => r.kind || '—' },
              { key: 'topics', label: t('gov.col_topics'), render: (r: any) => <span className="line-clamp-2">{r.topics || '—'}</span> },
              { key: 'icfr_reviewed', label: t('gov.col_icfr'), render: (r: any) => <Badge variant={r.icfr_reviewed ? 'success' : 'muted'}>{r.icfr_reviewed ? t('gov.os_icfr_yes') : t('gov.os_icfr_no')}</Badge> },
              { key: 'signed_off_by', label: t('gov.col_signed'), render: (r: any) => r.signed_off_by || '—' },
            ]}
            emptyState={{ icon: Landmark, title: t('gov.os_empty_title'), description: t('gov.os_empty_desc') }}
          />
        </StateView>
      </div>
    </div>
  );
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return '—';
  return String(v).slice(0, 10);
}
