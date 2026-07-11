'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldAlert, AlarmClock, CheckCircle2, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

// GRC-5 (ITGC-AC-22) — SoD-Conflict Register + Compensating-Control governance. Standing detective dashboard
// (current conflicts across the whole population, grouped by rule) + the accepted-conflict register (accept
// with a mandatory compensating control + owner + expiry; periodic re-review) + the expired/overdue worklist.
// Reads gate users/exec; enforcement (ITGC-AC-09) is unchanged — this is the detective + governance layer.
export default function SodClient({ initialConflicts, initialDispositions, initialExpired }: { initialConflicts?: any; initialDispositions?: any; initialExpired?: any }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('sodreg.title')} description={t('sodreg.subtitle')} />
      <Tabs tabs={[
        { key: 'conflicts', label: t('sodreg.tab_conflicts'), content: <Conflicts initialConflicts={initialConflicts} /> },
        { key: 'register', label: t('sodreg.tab_register'), content: <Register initialDispositions={initialDispositions} /> },
        { key: 'expired', label: t('sodreg.tab_expired'), content: <Expired initialExpired={initialExpired} /> },
      ]} />
    </div>
  );
}

const sevBadge = (t: (k: string) => string, s: string) => <Badge variant={s === 'High' ? 'destructive' : 'warning'}>{s}</Badge>;

function AcceptDialog({ ruleId, username, onDone }: { ruleId: string; username: string; onDone: () => void }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [cc, setCc] = useState('');
  const [owner, setOwner] = useState('');
  const [expiry, setExpiry] = useState('');
  const [notes, setNotes] = useState('');
  const m = useMutation({
    mutationFn: () => api('/api/admin/sod/dispositions', { method: 'POST', body: JSON.stringify({ rule_id: ruleId, username, compensating_control: cc, owner, expiry_date: expiry, notes: notes || undefined }) }),
    onSuccess: () => { notifySuccess(t('sodreg.accept_ok')); setOpen(false); setCc(''); setOwner(''); setExpiry(''); setNotes(''); onDone(); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}><ShieldCheck className="size-3.5" />{t('sodreg.accept')}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('sodreg.accept_title')} — {ruleId} · {username}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1"><Label>{t('sodreg.compensating_control')}</Label><Input value={cc} onChange={(e) => setCc(e.target.value)} /></div>
            <div className="grid gap-1"><Label>{t('sodreg.owner')}</Label><Input value={owner} onChange={(e) => setOwner(e.target.value)} /></div>
            <div className="grid gap-1"><Label>{t('sodreg.expiry_date')}</Label><Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></div>
            <div className="grid gap-1"><Label>{t('sodreg.notes')}</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button onClick={() => m.mutate()} disabled={!cc || !owner || !expiry || m.isPending}><CheckCircle2 className="size-4" />{t('sodreg.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Conflicts({ initialConflicts }: { initialConflicts?: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['sod-conflicts'], queryFn: () => api('/api/admin/sod/conflicts'), initialData: initialConflicts });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['sod-conflicts'] }); qc.invalidateQueries({ queryKey: ['sod-dispositions'] }); qc.invalidateQueries({ queryKey: ['sod-expired'] }); };
  const kpi = (k: string, v: any, tone?: string) => (
    <Card key={k} className="min-w-32 gap-1 p-4"><div className="text-xs text-muted-foreground">{t(`sodreg.kpi_${k}`)}</div><div className={`text-2xl font-semibold ${tone ?? ''}`}>{Number(v ?? 0)}</div></Card>
  );
  return (
    <StateView q={q}>{q.data && (
      <div className="grid gap-5">
        <div className="flex flex-wrap gap-4">
          {kpi('users', q.data.summary?.total_users)}
          {kpi('conflicted', q.data.summary?.users_with_conflicts)}
          {kpi('total', q.data.summary?.total_conflicts)}
          {kpi('accepted', q.data.summary?.accepted_conflicts, 'text-emerald-600')}
          {kpi('ungoverned', q.data.summary?.ungoverned_conflicts, Number(q.data.summary?.ungoverned_conflicts) > 0 ? 'text-red-600' : '')}
        </div>
        {(q.data.conflicts_by_rule ?? []).length === 0 && <div className="text-sm text-muted-foreground">{t('sodreg.empty_conflicts')}</div>}
        {(q.data.conflicts_by_rule ?? []).map((g: any) => (
          <Card key={g.rule_id} className="gap-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldAlert className="size-4 text-amber-600" />
              <span className="font-semibold">{g.rule_id}</span>
              <span className="text-sm">{g.duty_a} <span className="text-muted-foreground">✗</span> {g.duty_b}</span>
              {sevBadge(t, g.severity)}
              <Badge variant="secondary">{g.count}</Badge>
            </div>
            {g.risk && <div className="text-xs text-muted-foreground">{g.risk}</div>}
            <div className="grid gap-1.5">
              {g.users.map((u: any) => (
                <div key={u.username} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{u.username}</span>
                  <span className="text-xs text-muted-foreground">{u.role}{u.customer_name ? ` · ${u.customer_name}` : ''}</span>
                  <span className="text-xs text-muted-foreground">{(u.perms_held ?? []).join(', ')}</span>
                  {u.disposition_status === 'accepted'
                    ? <Badge variant={u.expired ? 'destructive' : 'success'}>{t('sodreg.disposition_accepted')}{u.expired ? ' ⚠' : ''}</Badge>
                    : <Badge variant="outline">{t('sodreg.disposition_none')}</Badge>}
                  {u.disposition_status !== 'accepted' && <AcceptDialog ruleId={g.rule_id} username={u.username} onDone={invalidate} />}
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    )}</StateView>
  );
}

function ReviewDialog({ id, onDone }: { id: number; onDone: () => void }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [expiry, setExpiry] = useState('');
  const [notes, setNotes] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/api/admin/sod/dispositions/${id}/review`, { method: 'POST', body: JSON.stringify({ expiry_date: expiry || undefined, notes: notes || undefined }) }),
    onSuccess: () => { notifySuccess(t('sodreg.review_ok')); setOpen(false); setExpiry(''); setNotes(''); onDone(); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}><RefreshCw className="size-3.5" />{t('sodreg.review')}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('sodreg.review_title')}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1"><Label>{t('sodreg.expiry_date')}</Label><Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></div>
            <div className="grid gap-1"><Label>{t('sodreg.notes')}</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          </div>
          <DialogFooter><Button onClick={() => m.mutate()} disabled={m.isPending}><CheckCircle2 className="size-4" />{t('sodreg.save')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DispositionRow({ d, onDone }: { d: any; onDone: () => void }) {
  const { t } = useLang();
  return (
    <Card className="flex flex-wrap items-center gap-2 p-3 text-sm">
      <Badge variant="secondary">{d.rule_id}</Badge>
      <span className="font-medium">{d.username}</span>
      {d.duty_a && <span className="text-xs text-muted-foreground">{d.duty_a} ✗ {d.duty_b}</span>}
      <span className="text-xs">{t('sodreg.compensating_control')}: {d.compensating_control || '—'}</span>
      <span className="text-xs text-muted-foreground">{t('sodreg.owner')}: {d.owner || '—'}</span>
      <span className="text-xs text-muted-foreground">{t('sodreg.expiry_date')}: {d.expiry_date || '—'}</span>
      <span className="text-xs text-muted-foreground">{t('sodreg.accepted_by')}: {d.accepted_by || '—'}</span>
      <span className="text-xs text-muted-foreground">{t('sodreg.last_reviewed')}: {d.last_reviewed_at ? String(d.last_reviewed_at).slice(0, 10) : '—'}</span>
      {d.expired && <Badge variant="destructive">{t(d.expired_reason === 'past_expiry' ? 'sodreg.reason_past_expiry' : 'sodreg.reason_review_overdue')}</Badge>}
      <div className="ms-auto"><ReviewDialog id={Number(d.id)} onDone={onDone} /></div>
    </Card>
  );
}

function Register({ initialDispositions }: { initialDispositions?: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['sod-dispositions'], queryFn: () => api('/api/admin/sod/dispositions'), initialData: initialDispositions });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['sod-dispositions'] }); qc.invalidateQueries({ queryKey: ['sod-expired'] }); qc.invalidateQueries({ queryKey: ['sod-conflicts'] }); };
  return (
    <StateView q={q}>{q.data && (
      <div className="grid gap-2">
        {(q.data.dispositions ?? []).length === 0 && <div className="text-sm text-muted-foreground">{t('sodreg.empty_register')}</div>}
        {(q.data.dispositions ?? []).map((d: any) => <DispositionRow key={d.id} d={d} onDone={invalidate} />)}
      </div>
    )}</StateView>
  );
}

function Expired({ initialExpired }: { initialExpired?: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['sod-expired'], queryFn: () => api('/api/admin/sod/dispositions/expired'), initialData: initialExpired });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['sod-expired'] }); qc.invalidateQueries({ queryKey: ['sod-dispositions'] }); qc.invalidateQueries({ queryKey: ['sod-conflicts'] }); };
  return (
    <StateView q={q}>{q.data && (
      <div className="grid gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><AlarmClock className="size-4" />{t('sodreg.tab_expired')} · {q.data.count ?? 0}</div>
        {(q.data.dispositions ?? []).length === 0 && <div className="text-sm text-muted-foreground">{t('sodreg.empty_expired')}</div>}
        {(q.data.dispositions ?? []).map((d: any) => <DispositionRow key={d.id} d={d} onDone={invalidate} />)}
      </div>
    )}</StateView>
  );
}
