'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, ShieldCheck, TriangleAlert, CircleSlash, FlaskConical, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Select } from '@/components/form-controls';
import { useLang } from '@/lib/i18n';

type Ctl = {
  control_id: string; cycle: string; category: string; fsli: string; risk: string; assertion: string;
  description: string; prev_det: string; nature: string; frequency: string; owner: string; coso: string;
  code_reference: string; tod: string; toe: string; evidence: string; status: string;
};

const statusTone = (s: string) => (s === 'Implemented' ? 'success' : s === 'Partial' ? 'warning' : 'secondary');
const resultTone = (r: string) => (r === 'pass' ? 'success' : r === 'fail' ? 'destructive' : 'muted');
const fmtTs = (v: string | null | undefined) => (v ? String(v).replace('T', ' ').slice(0, 16) : '—');

export default function RcmClient({ initialRcm }: { initialRcm?: any }) {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['cc-rcm'], queryFn: () => api('/api/controls/rcm'), initialData: initialRcm });
  const [family, setFamily] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const controls: Ctl[] = q.data?.controls ?? [];
  const census = q.data?.census;
  const families: { family: string }[] = q.data?.families ?? [];

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return controls.filter((c) =>
      (!family || c.cycle === family) &&
      (!status || c.status === status) &&
      (!needle || `${c.control_id} ${c.risk} ${c.description}`.toLowerCase().includes(needle)),
    );
  }, [controls, family, status, search]);

  return (
    <div>
      <PageHeader title={t('cc.title')} description={t('cc.subtitle')} />

      {census && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={t('cc.stat_total')} value={num(census.total)} icon={ClipboardCheck} tone="info" />
          <StatCard label={t('cc.stat_implemented')} value={num(census.by_status?.Implemented ?? 0)} icon={ShieldCheck} tone="success" />
          <StatCard label={t('cc.stat_partial')} value={num(census.by_status?.Partial ?? 0)} icon={TriangleAlert} tone={(census.by_status?.Partial ?? 0) ? 'warning' : 'default'} />
          <StatCard label={t('cc.stat_gap')} value={num(census.by_status?.Gap ?? 0)} icon={CircleSlash} tone={(census.by_status?.Gap ?? 0) ? 'warning' : 'default'} />
        </div>
      )}

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 py-4">
          <div className="grid gap-1.5">
            <Label htmlFor="cc-family">{t('cc.filter_family')}</Label>
            <Select id="cc-family" value={family} onChange={(e) => setFamily(e.target.value)}>
              <option value="">{t('cc.filter_all')}</option>
              {families.map((f) => <option key={f.family} value={f.family}>{f.family}</option>)}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cc-status">{t('cc.filter_status')}</Label>
            <Select id="cc-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('cc.filter_all')}</option>
              <option value="Implemented">{t('cc.status_implemented')}</option>
              <option value="Partial">{t('cc.status_partial')}</option>
              <option value="Gap">{t('cc.status_gap')}</option>
            </Select>
          </div>
          <div className="grid flex-1 gap-1.5 sm:min-w-64">
            <Label htmlFor="cc-search">{t('cc.search_ph')}</Label>
            <Input id="cc-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('cc.search_ph')} />
          </div>
        </CardContent>
      </Card>

      <StateView q={q}>
        <DataTable
          rows={filtered}
          rowKey={(r: Ctl) => r.control_id}
          onRowClick={(r: Ctl) => setOpenId(r.control_id)}
          columns={[
            { key: 'control_id', label: t('cc.col_id'), render: (r: Ctl) => <span className="font-medium">{r.control_id}</span> },
            { key: 'cycle', label: t('cc.col_family') },
            { key: 'category', label: t('cc.col_category') },
            { key: 'risk', label: t('cc.col_risk'), render: (r: Ctl) => <span className="line-clamp-2 text-muted-foreground">{r.risk}</span> },
            { key: 'owner', label: t('cc.col_owner'), render: (r: Ctl) => r.owner || '—' },
            { key: 'status', label: t('cc.col_status'), render: (r: Ctl) => <Badge variant={statusTone(r.status)}>{r.status}</Badge> },
          ]}
          emptyState={{ icon: ClipboardCheck, title: t('cc.empty_title'), description: t('cc.empty_desc') }}
        />
      </StateView>

      {openId && <ControlDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="grid gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="whitespace-pre-wrap text-sm">{value}</span>
    </div>
  );
}

function ControlDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['cc-detail', id], queryFn: () => api(`/api/controls/rcm/${encodeURIComponent(id)}`) });
  const c: Ctl | undefined = q.data?.control;
  const runs: any[] = q.data?.test_runs ?? [];
  const ccm: any[] = q.data?.ccm_findings ?? [];
  const audit: any[] = q.data?.audit_evidence ?? [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{id}</span>
            {c && <Badge variant={statusTone(c.status)}>{c.status}</Badge>}
          </DialogTitle>
          {c && <DialogDescription>{c.cycle} · {c.category} · {c.coso}</DialogDescription>}
        </DialogHeader>
        <StateView q={q}>
          {c && (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('cc.d_risk')} value={c.risk} />
                <Field label={t('cc.d_assertion')} value={c.assertion} />
                <Field label={t('cc.d_fsli')} value={c.fsli} />
                <Field label={t('cc.d_owner')} value={c.owner} />
                <Field label={t('cc.d_prevdet')} value={c.prev_det} />
                <Field label={t('cc.d_nature')} value={c.nature} />
                <Field label={t('cc.d_frequency')} value={c.frequency} />
                <Field label={t('cc.d_coso')} value={c.coso} />
              </div>
              <Field label={t('cc.d_description')} value={c.description} />
              <Field label={t('cc.d_coderef')} value={c.code_reference} />
              <Field label={t('cc.d_tod')} value={c.tod} />
              <Field label={t('cc.d_toe')} value={c.toe} />
              <Field label={t('cc.d_evidence')} value={c.evidence} />

              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><FlaskConical className="size-4" /> {t('cc.d_runs_title')}</h3>
                {runs.length === 0
                  ? <p className="text-sm text-muted-foreground">{t('cc.d_runs_empty')}</p>
                  : <DataTable
                      rows={runs}
                      rowKey={(r: any) => r.id}
                      columns={[
                        { key: 'result', label: t('cc.d_run_result'), render: (r: any) => <Badge variant={resultTone(r.result)}>{t(`cc.result_${r.result}`)}</Badge> },
                        { key: 'harness', label: t('cc.d_run_harness'), render: (r: any) => r.harness || '—' },
                        { key: 'checks', label: t('cc.d_run_checks'), render: (r: any) => r.checks_total != null ? `${num(r.checks_passed ?? 0)} / ${num(r.checks_total)}` : '—' },
                        { key: 'evidence_ref', label: t('cc.d_run_evidence'), render: (r: any) => r.evidence_ref || '—' },
                        { key: 'recorded_by', label: t('cc.d_run_by'), render: (r: any) => r.recorded_by || '—' },
                        { key: 'run_at', label: t('cc.d_run_at'), render: (r: any) => fmtTs(r.run_at) },
                      ]}
                    />}
              </div>

              {ccm.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold">{t('cc.d_ccm_title')}</h3>
                  <ul className="space-y-1 text-sm">
                    {ccm.map((f) => (
                      <li key={f.id} className="flex items-start gap-2">
                        <Badge variant={f.severity === 'critical' ? 'destructive' : 'warning'}>{f.severity}</Badge>
                        <span className="text-muted-foreground">{f.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {audit.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold">{t('cc.d_audit_title')}</h3>
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    {audit.map((a) => <li key={a.id}>{fmtTs(a.ts)} · {a.actor} · {a.action} · {a.status}</li>)}
                  </ul>
                </div>
              )}

              <RecordRun id={id} />
            </div>
          )}
        </StateView>
      </DialogContent>
    </Dialog>
  );
}

function RecordRun({ id }: { id: string }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [result, setResult] = useState('pass');
  const [harness, setHarness] = useState('');
  const [passed, setPassed] = useState('');
  const [total, setTotal] = useState('');
  const [evidence, setEvidence] = useState('');
  const [notes, setNotes] = useState('');
  const save = useMutation({
    mutationFn: () => api(`/api/controls/rcm/${encodeURIComponent(id)}/test-run`, {
      method: 'POST',
      body: JSON.stringify({
        result,
        harness: harness || undefined,
        checks_passed: passed === '' ? undefined : Number(passed),
        checks_total: total === '' ? undefined : Number(total),
        evidence_ref: evidence || undefined,
        notes: notes || undefined,
      }),
    }),
    onSuccess: () => {
      notifySuccess(t('cc.record_ok', { id }));
      setHarness(''); setPassed(''); setTotal(''); setEvidence(''); setNotes('');
      qc.invalidateQueries({ queryKey: ['cc-detail', id] });
      qc.invalidateQueries({ queryKey: ['cc-rcm'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{t('cc.record_title')}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="rr-result">{t('cc.record_result')}</Label>
            <Select id="rr-result" value={result} onChange={(e) => setResult(e.target.value)}>
              {['pass', 'fail', 'na'].map((r) => <option key={r} value={r}>{t(`cc.result_${r}`)}</option>)}
            </Select>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="rr-harness">{t('cc.record_harness')}</Label><Input id="rr-harness" value={harness} onChange={(e) => setHarness(e.target.value)} placeholder={t('cc.record_harness_ph')} /></div>
          <div className="grid gap-1.5"><Label htmlFor="rr-passed">{t('cc.record_passed')}</Label><Input id="rr-passed" type="number" min="0" value={passed} onChange={(e) => setPassed(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="rr-total">{t('cc.record_total')}</Label><Input id="rr-total" type="number" min="0" value={total} onChange={(e) => setTotal(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="rr-evidence">{t('cc.record_evidence')}</Label><Input id="rr-evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="rr-notes">{t('cc.record_notes')}</Label><Input id="rr-notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <Button disabled={save.isPending} onClick={() => save.mutate()}><Plus className="size-4" /> {save.isPending ? t('cc.saving') : t('cc.record_btn')}</Button>
      </CardContent>
    </Card>
  );
}
