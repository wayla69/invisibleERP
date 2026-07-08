'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { ShieldAlert, Play, Loader2, Check } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/data-table';

type Finding = { id: number; control_key: string; severity: string; entity_ref: string; detail: string; amount: number | null; status: string; detected_at: string };
const sevColor: Record<string, string> = { critical: 'text-destructive', warning: 'text-amber-600', info: 'text-muted-foreground' };

// Continuous controls monitoring (Platform Phase 19 — B5). Scan for red flags; review findings. Read-only.
export default function ControlsPage() {
  const { t } = useLang();
  const [msg, setMsg] = useState('');
  const findings = useQuery<{ findings: Finding[] }>({ queryKey: ['control-findings'], queryFn: () => api('/api/controls/findings') });
  const scan = useMutation({
    mutationFn: () => api<{ candidates: number }>('/api/controls/scan', { method: 'POST' }),
    onSuccess: (r) => { setMsg(t('st.ctl.scanned', { count: r.candidates })); findings.refetch(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const review = useMutation({
    mutationFn: (id: number) => api(`/api/controls/findings/${id}/review`, { method: 'POST', body: JSON.stringify({ status: 'reviewed' }) }),
    onSuccess: () => findings.refetch(),
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
                { key: 'detail', label: t('st.ctl.col_detail') },
                { key: 'status', label: t('fin.col_status') },
                { key: 'act', label: '', sortable: false, render: (f) => f.status === 'open' ? <Button variant="outline" size="sm" disabled={review.isPending} onClick={() => review.mutate(f.id)}><Check className="size-3" /> {t('st.ctl.reviewed')}</Button> : null },
              ]}
            />
          </StateView>
        </CardContent>
      </Card>
    </div>
  );
}
