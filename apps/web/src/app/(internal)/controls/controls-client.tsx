'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { ShieldAlert, Play, Loader2, Check, AlertTriangle, Clock, Timer, ClipboardCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { DataTable } from '@/components/data-table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from '@/components/ui/dialog';

type Finding = {
  id: number; control_key: string; rcm_ref: string | null; severity: string; entity_ref: string; detail: string;
  amount: number | null; status: string; disposition: string; owner: string | null; due_date: string | null;
  root_cause: string | null; remediated_by: string | null; remediated_at: string | null; detected_at: string;
};
type Kci = {
  total_open: number; overdue: number; mttr_days: number | null;
  by_disposition: { disposition: string; count: number }[];
  by_severity: { severity: string; count: number }[];
  by_detector: { control_key: string; label: string; rcm_ref: string; open: number; total: number }[];
  by_family: { family: string; open: number }[];
};

const sevColor: Record<string, string> = { critical: 'text-destructive', warning: 'text-amber-600', info: 'text-muted-foreground' };
const dispTone: Record<string, string> = { open: 'destructive', investigating: 'secondary', remediated: 'default', accepted: 'outline', false_positive: 'outline' };
const DISPOSITIONS = ['open', 'investigating', 'remediated', 'accepted', 'false_positive'] as const;

// Continuous controls monitoring (GRC-4, GOV-02). Scan for red flags; disposition each exception (owner +
// due date + root cause, tracked to closure) and monitor the KCIs. Read-only vs the GL.
export default function ControlsClient({ initialKci, initialFindings }: { initialKci?: unknown; initialFindings?: unknown }) {
  const { t } = useLang();
  const [msg, setMsg] = useState('');

  const findings = useQuery<{ findings: Finding[] }>({ queryKey: ['control-findings'], queryFn: () => api('/api/controls/findings'), initialData: initialFindings as { findings: Finding[] } | undefined });
  const kci = useQuery<Kci>({ queryKey: ['control-kci'], queryFn: () => api('/api/controls/kci'), initialData: initialKci as Kci | undefined });
  const refetchAll = () => { findings.refetch(); kci.refetch(); };

  const scan = useMutation({
    mutationFn: () => api<{ candidates: number }>('/api/controls/scan', { method: 'POST' }),
    onSuccess: (r) => { setMsg(t('st.ctl.scanned', { count: r.candidates })); refetchAll(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title={t('st.ctl.title')} description={t('st.ctl.desc')} />

      <Card className="mb-6">
        <CardContent className="flex items-center gap-3 py-4">
          <Button disabled={scan.isPending} onClick={() => scan.mutate()}>{scan.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} {t('st.ctl.run_scan')}</Button>
          {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
        </CardContent>
      </Card>

      <Tabs tabs={[
        { key: 'kci', label: t('st.ctl.tab_kci'), content: <KciDashboard kci={kci} /> },
        { key: 'findings', label: t('st.ctl.tab_findings'), content: <FindingsTab findings={findings} onChanged={refetchAll} /> },
      ]} />
    </div>
  );
}

function Tile({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-4">
        <div className={`rounded-md p-2 ${tone ?? 'bg-muted text-muted-foreground'}`}>{icon}</div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function KciDashboard({ kci }: { kci: ReturnType<typeof useQuery<Kci>> }) {
  const { t } = useLang();
  return (
    <StateView q={kci}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile icon={<AlertTriangle className="size-4" />} label={t('st.ctl.kci_open')} value={kci.data?.total_open ?? 0} tone="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" />
        <Tile icon={<Clock className="size-4" />} label={t('st.ctl.kci_overdue')} value={kci.data?.overdue ?? 0} tone={(kci.data?.overdue ?? 0) > 0 ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' : undefined} />
        <Tile icon={<Timer className="size-4" />} label={t('st.ctl.kci_mttr')} value={kci.data?.mttr_days != null ? `${kci.data.mttr_days} ${t('st.ctl.days')}` : '—'} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ClipboardCheck className="size-4 text-primary" /> {t('st.ctl.kci_by_detector')}</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <DataTable
              rows={kci.data?.by_detector ?? []}
              rowKey={(d) => d.control_key}
              columns={[
                { key: 'label', label: t('st.ctl.col_control') },
                { key: 'rcm_ref', label: t('st.ctl.col_rcm'), render: (d) => <Badge variant="outline">{d.rcm_ref}</Badge> },
                { key: 'open', label: t('st.ctl.col_open'), render: (d) => <span className={d.open > 0 ? 'font-semibold text-amber-600' : 'text-muted-foreground'}>{d.open}</span> },
                { key: 'total', label: t('st.ctl.col_total') },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldAlert className="size-4 text-primary" /> {t('st.ctl.kci_by_family')}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {(kci.data?.by_family ?? []).length === 0 && <p className="text-sm text-muted-foreground">{t('st.ctl.no_open')}</p>}
            {(kci.data?.by_family ?? []).map((f) => (
              <div key={f.family} className="flex items-center justify-between text-sm">
                <span>{f.family}</span>
                <Badge variant="secondary">{f.open}</Badge>
              </div>
            ))}
            <div className="mt-3 border-t pt-3">
              <div className="mb-1 text-xs font-medium text-muted-foreground">{t('st.ctl.kci_by_disposition')}</div>
              <div className="flex flex-wrap gap-2">
                {(kci.data?.by_disposition ?? []).map((d) => (
                  <Badge key={d.disposition} variant="outline">{t(`st.ctl.disp.${d.disposition}` as any)}: {d.count}</Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </StateView>
  );
}

function FindingsTab({ findings, onChanged }: { findings: ReturnType<typeof useQuery<{ findings: Finding[] }>>; onChanged: () => void }) {
  const { t } = useLang();
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldAlert className="size-4 text-primary" /> {t('st.ctl.findings')}</CardTitle></CardHeader>
      <CardContent className="overflow-x-auto">
        <StateView q={findings}>
          <DataTable
            rows={findings.data?.findings ?? []}
            rowKey={(f) => String(f.id)}
            emptyText={t('st.ctl.no_findings')}
            columns={[
              { key: 'severity', label: t('st.ctl.col_severity'), render: (f) => <span className={`font-medium ${sevColor[f.severity] ?? ''}`}>{f.severity}</span> },
              { key: 'control_key', label: t('st.ctl.col_control') },
              { key: 'rcm_ref', label: t('st.ctl.col_rcm'), render: (f) => f.rcm_ref ? <Badge variant="outline">{f.rcm_ref}</Badge> : null },
              { key: 'detail', label: t('st.ctl.col_detail') },
              { key: 'disposition', label: t('st.ctl.col_disposition'), render: (f) => <Badge variant={(dispTone[f.disposition] ?? 'outline') as any}>{t(`st.ctl.disp.${f.disposition}` as any)}</Badge> },
              { key: 'owner', label: t('st.ctl.col_owner'), render: (f) => f.owner ?? '—' },
              { key: 'due_date', label: t('st.ctl.col_due'), render: (f) => f.due_date ?? '—' },
              { key: 'act', label: '', sortable: false, render: (f) => <DispositionDialog finding={f} onDone={onChanged} /> },
            ]}
          />
        </StateView>
      </CardContent>
    </Card>
  );
}

function DispositionDialog({ finding, onDone }: { finding: Finding; onDone: () => void }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [disposition, setDisposition] = useState(finding.disposition);
  const [owner, setOwner] = useState(finding.owner ?? '');
  const [dueDate, setDueDate] = useState(finding.due_date ?? '');
  const [rootCause, setRootCause] = useState(finding.root_cause ?? '');
  const [err, setErr] = useState('');

  const save = useMutation({
    mutationFn: () => api(`/api/controls/findings/${finding.id}/disposition`, {
      method: 'POST',
      body: JSON.stringify({ disposition, owner: owner || undefined, due_date: dueDate || undefined, root_cause: rootCause || undefined }),
    }),
    onSuccess: () => { setOpen(false); onDone(); },
    onError: (e: any) => setErr(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm"><Check className="size-3" /> {t('st.ctl.disposition')}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('st.ctl.disposition')} — #{finding.id}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">{finding.detail}</p>
          <div>
            <label className="mb-1 block text-xs font-medium">{t('st.ctl.col_disposition')}</label>
            <select value={disposition} onChange={(e) => setDisposition(e.target.value)} className="w-full rounded-md border bg-background px-2 py-1.5">
              {DISPOSITIONS.map((d) => <option key={d} value={d}>{t(`st.ctl.disp.${d}` as any)}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">{t('st.ctl.col_owner')}</label>
            <Input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder={t('st.ctl.owner_ph')} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">{t('st.ctl.col_due')}</label>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">{t('st.ctl.root_cause')}</label>
            <textarea value={rootCause} onChange={(e) => setRootCause(e.target.value)} rows={3} className="w-full rounded-md border bg-background px-2 py-1.5" placeholder={t('st.ctl.root_cause_ph')} />
          </div>
          {err && <p className="text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button disabled={save.isPending} onClick={() => { setErr(''); save.mutate(); }}>{save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {t('st.ctl.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
