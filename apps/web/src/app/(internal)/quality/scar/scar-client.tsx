'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, Plus, MessageSquare, Send, CheckCircle2, XCircle, AlarmClock } from 'lucide-react';
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

// QMS-4 — SCAR register + 8D response + the QC-04 closure maker-checker (a pending SCAR is closed by a
// DIFFERENT user than the raiser — the API returns 403 SOD_SELF_APPROVAL otherwise, and closure is blocked
// until the supplier has responded with root_cause + corrective_action, SCAR_INCOMPLETE) + the overdue read.
export default function ScarClient({ initialScars, initialOverdue }: { initialScars?: any; initialOverdue?: any }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('scar.title')} description={t('scar.subtitle')} />
      <Tabs tabs={[
        { key: 'register', label: t('scar.tab_register'), content: <Register initialScars={initialScars} /> },
        { key: 'overdue', label: t('scar.tab_overdue'), content: <Overdue initialOverdue={initialOverdue} /> },
      ]} />
    </div>
  );
}

const SEVERITIES = ['minor', 'major', 'critical'];

const statusBadge = (t: (k: string) => string, s: string) => {
  const variant = s === 'closed' ? 'success' : s === 'rejected' ? 'destructive' : s === 'pending_closure' ? 'warning' : 'secondary';
  return <Badge variant={variant as any}>{t(`scar.status_${s}`)}</Badge>;
};

function Register({ initialScars }: { initialScars?: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['scar-register'], queryFn: () => api('/api/quality/scar'), initialData: initialScars });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['scar-register'] });

  // raise form
  const [vendorId, setVendorId] = useState('');
  const [sourceClaim, setSourceClaim] = useState('');
  const [defect, setDefect] = useState('');
  const [severity, setSeverity] = useState('major');
  const [due, setDue] = useState('');

  const raise = useMutation({
    mutationFn: () => api('/api/quality/scar', { method: 'POST', body: JSON.stringify({ vendor_id: Number(vendorId), source_claim_no: sourceClaim || undefined, defect_summary: defect, severity, due_date: due || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(t('scar.raised_ok').replace('{no}', r.scar_no)); setVendorId(''); setSourceClaim(''); setDefect(''); setDue(''); invalidate(); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });

  // action dialog (respond / close)
  const [dlg, setDlg] = useState<{ id: number; kind: 'respond' | 'close' } | null>(null);
  const [containment, setContainment] = useState('');
  const [rootCause, setRootCause] = useState('');
  const [corrective, setCorrective] = useState('');
  const [preventive, setPreventive] = useState('');
  const [effectiveness, setEffectiveness] = useState('effective');

  const respond = useMutation({
    mutationFn: (id: number) => api(`/api/quality/scar/${id}/respond`, { method: 'POST', body: JSON.stringify({ containment, root_cause: rootCause, corrective_action: corrective, preventive_action: preventive }) }),
    onSuccess: () => { notifySuccess(t('scar.responded_ok')); setDlg(null); setContainment(''); setRootCause(''); setCorrective(''); setPreventive(''); invalidate(); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });
  const submit = useMutation({
    mutationFn: (id: number) => api(`/api/quality/scar/${id}/submit-closure`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('scar.submitted_ok')); invalidate(); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });
  const close = useMutation({
    mutationFn: (id: number) => api(`/api/quality/scar/${id}/close`, { method: 'POST', body: JSON.stringify({ effectiveness }) }),
    onSuccess: () => { notifySuccess(t('scar.closed_ok')); setDlg(null); invalidate(); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });
  const reject = useMutation({
    mutationFn: (id: number) => { const reason = window.prompt(t('scar.f_reject_reason')) ?? ''; return api(`/api/quality/scar/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); },
    onSuccess: () => { notifySuccess(t('scar.rejected_ok')); invalidate(); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });

  const rows: any[] = q.data?.scars ?? [];
  return (
    <div className="grid gap-4">
      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2 font-semibold"><ShieldAlert className="size-4 text-muted-foreground" />{t('scar.raise_title')}</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="grid gap-1"><Label htmlFor="scar-vid">{t('scar.f_vendor_id')}</Label><Input id="scar-vid" value={vendorId} onChange={(e) => setVendorId(e.target.value)} inputMode="numeric" /></div>
          <div className="grid gap-1"><Label htmlFor="scar-claim">{t('scar.f_source_claim')}</Label><Input id="scar-claim" value={sourceClaim} onChange={(e) => setSourceClaim(e.target.value)} /></div>
          <div className="grid gap-1"><Label htmlFor="scar-sev">{t('scar.f_severity')}</Label>
            <select id="scar-sev" className="rounded-md border bg-background px-2 py-2 text-sm" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {SEVERITIES.map((sv) => <option key={sv} value={sv}>{t(`scar.sev_${sv}`)}</option>)}
            </select>
          </div>
          <div className="grid gap-1 sm:col-span-2"><Label htmlFor="scar-defect">{t('scar.f_defect')}</Label><Input id="scar-defect" value={defect} onChange={(e) => setDefect(e.target.value)} /></div>
          <div className="grid gap-1"><Label htmlFor="scar-due">{t('scar.f_due')}</Label><Input id="scar-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div>
        </div>
        <div className="mt-3">
          <Button onClick={() => raise.mutate()} disabled={raise.isPending || !vendorId || !defect}><Plus className="size-4" />{t('scar.raise_btn')}</Button>
        </div>
      </Card>

      <StateView q={q}>
        {rows.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">{t('scar.empty_register')}</Card>
        ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-3">{t('scar.col_no')}</th>
                <th className="p-3">{t('scar.col_vendor')}</th>
                <th className="p-3">{t('scar.col_defect')}</th>
                <th className="p-3">{t('scar.col_severity')}</th>
                <th className="p-3">{t('scar.col_source_claim')}</th>
                <th className="p-3">{t('scar.col_due')}</th>
                <th className="p-3">{t('scar.col_status')}</th>
                <th className="p-3">{t('scar.col_effectiveness')}</th>
                <th className="p-3 text-right">{t('scar.col_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0 align-top">
                  <td className="p-3 font-medium whitespace-nowrap">{r.scar_no}</td>
                  <td className="p-3">{r.vendor_id}</td>
                  <td className="p-3 max-w-[24ch] truncate" title={r.defect_summary}>{r.defect_summary}</td>
                  <td className="p-3">{t(`scar.sev_${r.severity}`)}</td>
                  <td className="p-3 text-xs text-muted-foreground">{r.source_claim_no ?? '—'}</td>
                  <td className="p-3 whitespace-nowrap">{r.due_date ?? '—'}</td>
                  <td className="p-3">{statusBadge(t, r.status)}</td>
                  <td className="p-3">{r.effectiveness ? t(`scar.eff_${r.effectiveness}`) : '—'}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap justify-end gap-2">
                      {(r.status === 'open' || r.status === 'supplier_responded') && (
                        <Button size="sm" variant="outline" onClick={() => { setDlg({ id: r.id, kind: 'respond' }); setContainment(r.containment ?? ''); setRootCause(r.root_cause ?? ''); setCorrective(r.corrective_action ?? ''); setPreventive(r.preventive_action ?? ''); }}>
                          <MessageSquare className="size-4" /><span className="hidden sm:inline">{t('scar.respond_btn')}</span>
                        </Button>
                      )}
                      {r.status === 'supplier_responded' && (
                        <Button size="sm" variant="outline" onClick={() => submit.mutate(r.id)} disabled={submit.isPending}>
                          <Send className="size-4" /><span className="hidden sm:inline">{t('scar.submit_btn')}</span>
                        </Button>
                      )}
                      {r.status === 'pending_closure' && (
                        <>
                          <Button size="sm" onClick={() => { setDlg({ id: r.id, kind: 'close' }); setEffectiveness('effective'); }}>
                            <CheckCircle2 className="size-4" /><span className="hidden sm:inline">{t('scar.close_btn')}</span>
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => reject.mutate(r.id)} disabled={reject.isPending}>
                            <XCircle className="size-4" /><span className="hidden sm:inline">{t('scar.reject_btn')}</span>
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        )}
      </StateView>

      <Dialog open={!!dlg} onOpenChange={(o) => { if (!o) setDlg(null); }}>
        <DialogContent>
          {dlg?.kind === 'respond' ? (
            <>
              <DialogHeader><DialogTitle>{t('scar.respond_title')}</DialogTitle></DialogHeader>
              <div className="grid gap-3">
                <div className="grid gap-1"><Label htmlFor="d-cont">{t('scar.f_containment')}</Label><Input id="d-cont" value={containment} onChange={(e) => setContainment(e.target.value)} /></div>
                <div className="grid gap-1"><Label htmlFor="d-rc">{t('scar.f_root_cause')}</Label><Input id="d-rc" value={rootCause} onChange={(e) => setRootCause(e.target.value)} /></div>
                <div className="grid gap-1"><Label htmlFor="d-ca">{t('scar.f_corrective')}</Label><Input id="d-ca" value={corrective} onChange={(e) => setCorrective(e.target.value)} /></div>
                <div className="grid gap-1"><Label htmlFor="d-pa">{t('scar.f_preventive')}</Label><Input id="d-pa" value={preventive} onChange={(e) => setPreventive(e.target.value)} /></div>
              </div>
              <DialogFooter>
                <Button onClick={() => dlg && respond.mutate(dlg.id)} disabled={respond.isPending || !rootCause || !corrective}>{t('scar.respond_btn')}</Button>
              </DialogFooter>
            </>
          ) : dlg?.kind === 'close' ? (
            <>
              <DialogHeader><DialogTitle>{t('scar.close_title')}</DialogTitle></DialogHeader>
              <div className="grid gap-1">
                <Label htmlFor="d-eff">{t('scar.f_effectiveness')}</Label>
                <select id="d-eff" className="rounded-md border bg-background px-2 py-2 text-sm" value={effectiveness} onChange={(e) => setEffectiveness(e.target.value)}>
                  <option value="effective">{t('scar.eff_effective')}</option>
                  <option value="ineffective">{t('scar.eff_ineffective')}</option>
                </select>
              </div>
              <DialogFooter>
                <Button onClick={() => dlg && close.mutate(dlg.id)} disabled={close.isPending}><CheckCircle2 className="size-4" />{t('scar.close_btn')}</Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Overdue({ initialOverdue }: { initialOverdue?: any }) {
  const { t } = useLang();
  const [days, setDays] = useState(0);
  const q = useQuery<any>({ queryKey: ['scar-overdue', days], queryFn: () => api(`/api/quality/scar/open?days=${days}`), initialData: days === 0 ? initialOverdue : undefined });
  const rows: any[] = q.data?.scars ?? [];
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2 text-sm">
        <AlarmClock className="size-4 text-muted-foreground" />
        <label htmlFor="scar-days">{t('scar.days_horizon')}</label>
        <select id="scar-days" className="rounded-md border bg-background px-2 py-1" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[0, 7, 30, 60, 90].map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <StateView q={q}>
        {rows.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">{t('scar.empty_overdue')}</Card>
        ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-3">{t('scar.col_no')}</th>
                <th className="p-3">{t('scar.col_vendor')}</th>
                <th className="p-3">{t('scar.col_defect')}</th>
                <th className="p-3">{t('scar.col_status')}</th>
                <th className="p-3">{t('scar.col_due')}</th>
                <th className="p-3 text-right">{t('scar.col_days_overdue')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="p-3 font-medium whitespace-nowrap">{r.scar_no}</td>
                  <td className="p-3">{r.vendor_id}</td>
                  <td className="p-3 max-w-[24ch] truncate" title={r.defect_summary}>{r.defect_summary}</td>
                  <td className="p-3">{statusBadge(t, r.status)}</td>
                  <td className="p-3 whitespace-nowrap">
                    {r.due_date}
                    {r.overdue && <Badge variant="destructive" className="ms-2">{t('scar.overdue_badge')}</Badge>}
                  </td>
                  <td className="p-3 text-right">{r.days_overdue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        )}
      </StateView>
    </div>
  );
}
