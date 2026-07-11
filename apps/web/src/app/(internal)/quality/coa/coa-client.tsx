'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, ShieldAlert, Plus, Check, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// QMS-3 (QC-03) — Certificate of Analysis capture + out-of-spec release approval. Recording (specs, CoA,
// results, evaluate) gates the `quality` duty; the out-of-spec deviation release gates `quality_approve`
// and is blocked for the recorder (SOD_SELF_APPROVAL) — it needs a deviation_reason. The in-app maker-checker
// is the real control regardless of the permission held.
function resultBadge(v: string) {
  return <Badge variant={v === 'pass' ? 'success' : v === 'fail' ? 'destructive' : 'secondary'}>{v}</Badge>;
}
function statusBadge(v: string) {
  return <Badge variant={v === 'released' ? 'success' : v === 'rejected' ? 'destructive' : 'warning'}>{v}</Badge>;
}

export default function CoaClient({ initialCoa }: { initialCoa?: any }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('qc.coa.title')} description={t('qc.coa.subtitle')} />
      <Tabs tabs={[
        { key: 'coa', label: t('qc.coa.tab_coa'), content: <CoaTab initialCoa={initialCoa} /> },
        { key: 'specs', label: t('qc.coa.tab_specs'), content: <SpecsTab /> },
        { key: 'oos', label: t('qc.coa.tab_oos'), content: <OutOfSpecTab /> },
      ]} />
    </div>
  );
}

// ── Specs ──
function SpecsTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['qc-specs'], queryFn: () => api('/api/quality/specs') });
  const [f, setF] = useState({ item_id: '', characteristic: '', uom: '', min_value: '', max_value: '', target_value: '' });
  const m = useMutation({
    mutationFn: () => api('/api/quality/specs', { method: 'POST', body: JSON.stringify({
      item_id: f.item_id, characteristic: f.characteristic, uom: f.uom || undefined,
      min_value: f.min_value !== '' ? Number(f.min_value) : undefined,
      max_value: f.max_value !== '' ? Number(f.max_value) : undefined,
      target_value: f.target_value !== '' ? Number(f.target_value) : undefined,
    }) }),
    onSuccess: () => { notifySuccess(t('qc.coa.spec_created')); setF({ item_id: '', characteristic: '', uom: '', min_value: '', max_value: '', target_value: '' }); qc.invalidateQueries({ queryKey: ['qc-specs'] }); },
    onError: (e: any) => notifyError(e?.message ?? String(e)),
  });
  return (
    <div className="grid gap-5">
      <Card className="grid gap-3 p-5">
        <div className="font-semibold">{t('qc.coa.new_spec')}</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1"><Label>{t('qc.coa.item')}</Label><Input value={f.item_id} onChange={(e) => setF({ ...f, item_id: e.target.value })} /></div>
          <div className="grid gap-1"><Label>{t('qc.coa.characteristic')}</Label><Input value={f.characteristic} onChange={(e) => setF({ ...f, characteristic: e.target.value })} /></div>
          <div className="grid gap-1"><Label>{t('qc.coa.uom')}</Label><Input value={f.uom} onChange={(e) => setF({ ...f, uom: e.target.value })} /></div>
          <div className="grid gap-1"><Label>{t('qc.coa.min')}</Label><Input type="number" value={f.min_value} onChange={(e) => setF({ ...f, min_value: e.target.value })} /></div>
          <div className="grid gap-1"><Label>{t('qc.coa.max')}</Label><Input type="number" value={f.max_value} onChange={(e) => setF({ ...f, max_value: e.target.value })} /></div>
          <div className="grid gap-1"><Label>{t('qc.coa.target')}</Label><Input type="number" value={f.target_value} onChange={(e) => setF({ ...f, target_value: e.target.value })} /></div>
        </div>
        <div><Button onClick={() => m.mutate()} disabled={!f.item_id || !f.characteristic || m.isPending}><Plus className="size-4" />{t('qc.coa.add_spec')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && (
        <DataTable
          rows={q.data.specs ?? []}
          rowKey={(r: any) => r.id}
          emptyText={t('qc.coa.no_specs')}
          columns={[
            { key: 'spec_no', label: t('qc.coa.col_spec_no') },
            { key: 'item_id', label: t('qc.coa.item') },
            { key: 'characteristic', label: t('qc.coa.characteristic') },
            { key: 'range', label: t('qc.coa.range'), render: (r: any) => `${r.min_value ?? '—'} … ${r.max_value ?? '—'} ${r.uom ?? ''}` },
            { key: 'target_value', label: t('qc.coa.target') },
          ]}
        />
      )}</StateView>
    </div>
  );
}

// ── CoA capture + results + evaluate + release ──
function CoaTab({ initialCoa }: { initialCoa?: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['qc-coa'], queryFn: () => api('/api/quality/coa'), initialData: initialCoa });
  const [sel, setSel] = useState<number | null>(null);
  const [nf, setNf] = useState({ lot_no: '', item_id: '', source: 'incoming' });
  const create = useMutation({
    mutationFn: () => api('/api/quality/coa', { method: 'POST', body: JSON.stringify({ lot_no: nf.lot_no, item_id: nf.item_id, source: nf.source }) }),
    onSuccess: (r: any) => { notifySuccess(t('qc.coa.coa_created')); setNf({ lot_no: '', item_id: '', source: 'incoming' }); setSel(r.id); qc.invalidateQueries({ queryKey: ['qc-coa'] }); },
    onError: (e: any) => notifyError(e?.message ?? String(e)),
  });
  return (
    <div className="grid gap-5">
      <Card className="grid gap-3 p-5">
        <div className="font-semibold">{t('qc.coa.new_coa')}</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1"><Label>{t('qc.coa.lot')}</Label><Input value={nf.lot_no} onChange={(e) => setNf({ ...nf, lot_no: e.target.value })} /></div>
          <div className="grid gap-1"><Label>{t('qc.coa.item')}</Label><Input value={nf.item_id} onChange={(e) => setNf({ ...nf, item_id: e.target.value })} /></div>
          <div className="grid gap-1"><Label>{t('qc.coa.source')}</Label>
            <select className="h-9 rounded-md border bg-transparent px-2 text-sm" value={nf.source} onChange={(e) => setNf({ ...nf, source: e.target.value })}>
              <option value="incoming">{t('qc.coa.source_incoming')}</option>
              <option value="production">{t('qc.coa.source_production')}</option>
            </select>
          </div>
        </div>
        <div><Button onClick={() => create.mutate()} disabled={!nf.lot_no || !nf.item_id || create.isPending}><Plus className="size-4" />{t('qc.coa.add_coa')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && (
        <DataTable
          rows={q.data.coa ?? []}
          rowKey={(r: any) => r.id}
          onRowClick={(r: any) => setSel(r.id)}
          emptyText={t('qc.coa.no_coa')}
          columns={[
            { key: 'coa_no', label: t('qc.coa.col_coa_no') },
            { key: 'lot_no', label: t('qc.coa.lot') },
            { key: 'item_id', label: t('qc.coa.item') },
            { key: 'source', label: t('qc.coa.source') },
            { key: 'overall_result', label: t('qc.coa.overall'), render: (r: any) => resultBadge(r.overall_result) },
            { key: 'release_status', label: t('qc.coa.status'), render: (r: any) => statusBadge(r.release_status) },
          ]}
        />
      )}</StateView>
      {sel != null && <CoaDetail id={sel} onChange={() => qc.invalidateQueries({ queryKey: ['qc-coa'] })} />}
    </div>
  );
}

function CoaDetail({ id, onChange }: { id: number; onChange: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['qc-coa', id], queryFn: () => api(`/api/quality/coa/${id}`) });
  const [rf, setRf] = useState({ characteristic: '', uom: '', spec_min: '', spec_max: '', actual_value: '' });
  const [reason, setReason] = useState('');
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['qc-coa', id] }); onChange(); };
  const addResult = useMutation({
    mutationFn: () => api(`/api/quality/coa/${id}/results`, { method: 'POST', body: JSON.stringify({ results: [{
      characteristic: rf.characteristic, uom: rf.uom || undefined,
      spec_min: rf.spec_min !== '' ? Number(rf.spec_min) : undefined,
      spec_max: rf.spec_max !== '' ? Number(rf.spec_max) : undefined,
      actual_value: Number(rf.actual_value),
    }] }) }),
    onSuccess: () => { notifySuccess(t('qc.coa.result_added')); setRf({ characteristic: '', uom: '', spec_min: '', spec_max: '', actual_value: '' }); invalidate(); },
    onError: (e: any) => notifyError(e?.message ?? String(e)),
  });
  const evaluate = useMutation({
    mutationFn: () => api(`/api/quality/coa/${id}/evaluate`, { method: 'POST', body: '{}' }),
    onSuccess: (r: any) => { notifySuccess(r.out_of_spec ? t('qc.coa.evaluated_fail') : t('qc.coa.evaluated_pass')); invalidate(); },
    onError: (e: any) => notifyError(e?.message ?? String(e)),
  });
  const release = useMutation({
    mutationFn: () => api(`/api/quality/coa/${id}/release`, { method: 'POST', body: JSON.stringify({ deviation_reason: reason || undefined }) }),
    onSuccess: () => { notifySuccess(t('qc.coa.released')); setReason(''); invalidate(); },
    onError: (e: any) => notifyError(e?.message ?? String(e)),
  });
  const reject = useMutation({
    mutationFn: () => api(`/api/quality/coa/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason: reason || undefined }) }),
    onSuccess: () => { notifySuccess(t('qc.coa.rejected')); setReason(''); invalidate(); },
    onError: (e: any) => notifyError(e?.message ?? String(e)),
  });
  return (
    <StateView q={q}>{q.data && (() => {
      const c = q.data;
      const held = c.release_status === 'held';
      const outOfSpec = c.overall_result === 'fail';
      return (
        <Card className="grid gap-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <FlaskConical className="size-4 text-muted-foreground" />
            <span className="font-semibold">{c.coa_no}</span>
            <span className="text-sm text-muted-foreground">{c.lot_no} · {c.item_id}</span>
            {resultBadge(c.overall_result)} {statusBadge(c.release_status)}
            {c.deviation_reason && <Badge variant="outline">{t('qc.coa.deviation')}: {c.deviation_reason}</Badge>}
          </div>
          <DataTable
            rows={c.results ?? []}
            rowKey={(r: any) => r.id}
            emptyText={t('qc.coa.no_results')}
            columns={[
              { key: 'characteristic', label: t('qc.coa.characteristic') },
              { key: 'range', label: t('qc.coa.range'), render: (r: any) => `${r.spec_min ?? '—'} … ${r.spec_max ?? '—'} ${r.uom ?? ''}` },
              { key: 'actual_value', label: t('qc.coa.actual') },
              { key: 'result', label: t('qc.coa.result'), render: (r: any) => resultBadge(r.result) },
            ]}
          />
          {held && (
            <div className="grid gap-3 border-t pt-4">
              <div className="font-medium">{t('qc.coa.add_result')}</div>
              <div className="grid gap-3 sm:grid-cols-5">
                <div className="grid gap-1"><Label>{t('qc.coa.characteristic')}</Label><Input value={rf.characteristic} onChange={(e) => setRf({ ...rf, characteristic: e.target.value })} /></div>
                <div className="grid gap-1"><Label>{t('qc.coa.min')}</Label><Input type="number" value={rf.spec_min} onChange={(e) => setRf({ ...rf, spec_min: e.target.value })} /></div>
                <div className="grid gap-1"><Label>{t('qc.coa.max')}</Label><Input type="number" value={rf.spec_max} onChange={(e) => setRf({ ...rf, spec_max: e.target.value })} /></div>
                <div className="grid gap-1"><Label>{t('qc.coa.actual')}</Label><Input type="number" value={rf.actual_value} onChange={(e) => setRf({ ...rf, actual_value: e.target.value })} /></div>
                <div className="grid gap-1"><Label>{t('qc.coa.uom')}</Label><Input value={rf.uom} onChange={(e) => setRf({ ...rf, uom: e.target.value })} /></div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => addResult.mutate()} disabled={!rf.characteristic || rf.actual_value === '' || addResult.isPending}><Plus className="size-4" />{t('qc.coa.add_result')}</Button>
                <Button variant="secondary" onClick={() => evaluate.mutate()} disabled={evaluate.isPending}>{t('qc.coa.evaluate')}</Button>
              </div>
              {c.overall_result !== 'pending' && (
                <div className="grid gap-2 border-t pt-3">
                  {outOfSpec && <div className="text-sm text-muted-foreground">{t('qc.coa.deviation_hint')}</div>}
                  {outOfSpec && (
                    <div className="grid gap-1"><Label>{t('qc.coa.deviation_reason')}</Label>
                      <textarea className="min-h-16 rounded-md border bg-transparent p-2 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} />
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => release.mutate()} disabled={release.isPending}><Check className="size-4" />{outOfSpec ? t('qc.coa.release_deviation') : t('qc.coa.release')}</Button>
                    <Button variant="destructive" onClick={() => reject.mutate()} disabled={reject.isPending}><X className="size-4" />{t('qc.coa.reject')}</Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      );
    })()}</StateView>
  );
}

// ── Out-of-spec deviation register (detective) ──
function OutOfSpecTab() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['qc-oos'], queryFn: () => api('/api/quality/coa/out-of-spec') });
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground"><ShieldAlert className="size-4" />{t('qc.coa.oos_hint')}</div>
      <StateView q={q}>{q.data && (
        <DataTable
          rows={q.data.deviations ?? []}
          rowKey={(r: any) => r.id}
          emptyText={t('qc.coa.no_oos')}
          columns={[
            { key: 'coa_no', label: t('qc.coa.col_coa_no') },
            { key: 'lot_no', label: t('qc.coa.lot') },
            { key: 'item_id', label: t('qc.coa.item') },
            { key: 'created_by', label: t('qc.coa.recorder') },
            { key: 'released_by', label: t('qc.coa.approver') },
            { key: 'deviation_reason', label: t('qc.coa.deviation') },
          ]}
        />
      )}</StateView>
    </div>
  );
}
