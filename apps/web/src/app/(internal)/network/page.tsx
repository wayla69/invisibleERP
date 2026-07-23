'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Network, Waypoints, CheckCircle2, AlertTriangle, PlayCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/form-controls';
import { useLang } from '@/lib/i18n';

// ── API contract (apps/api/src/modules/scm-network) ───────────────────────────
interface NodeRow {
  id: number; nodeCode: string; name: string; nameTh: string | null;
  kind: 'supplier' | 'central_kitchen' | 'dc' | 'branch'; echelon: number;
  branchId: number | null; serviceTimeOutDays: string; holdingCostPerDay: string; active: boolean;
}
interface LaneRow {
  id: number; fromNodeId: number; toNodeId: number;
  leadTimeMeanDays: string; leadTimeStdDays: string; unitCost: string; moq: string; packSize: string;
}
interface TopoIssue { code: string; message: string; at?: string }
interface Topology {
  nodes: NodeRow[]; lanes: LaneRow[];
  validation: { ok: boolean; issues: TopoIssue[]; reachableBranches: string[] };
}

interface PlanRow {
  id: number; planNo: string; itemCode: string; status: string; engine: string;
  poolingBenefitPct: string | null; estTotalCost: string; prNo: string | null;
}

const KINDS = ['supplier', 'central_kitchen', 'dc', 'branch'] as const;

export default function NetworkPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'nodes' | 'lanes' | 'plans'>('nodes');

  const topo = useQuery<Topology>({
    queryKey: ['scm-network', 'topology'],
    queryFn: () => api('/api/scm-network/topology'),
  });

  const nodes = topo.data?.nodes ?? [];
  const codeById = useMemo(() => new Map(nodes.map((n) => [n.id, n.nodeCode])), [nodes]);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['scm-network'] });

  // ── node form ──
  const [nCode, setNCode] = useState('');
  const [nName, setNName] = useState('');
  const [nKind, setNKind] = useState<(typeof KINDS)[number]>('supplier');
  const [nBranch, setNBranch] = useState('');
  const [nHold, setNHold] = useState('');

  const addNode = useMutation({
    mutationFn: () => api('/api/scm-network/nodes', {
      method: 'POST',
      body: JSON.stringify({
        node_code: nCode.trim(), name: nName.trim(), kind: nKind,
        branch_id: nKind === 'branch' && nBranch ? Number(nBranch) : undefined,
        holding_cost_per_day: nHold ? Number(nHold) : undefined,
      }),
    }),
    onSuccess: () => { setNCode(''); setNName(''); setNBranch(''); setNHold(''); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });
  const delNode = useMutation({
    mutationFn: (id: number) => api(`/api/scm-network/nodes/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: (e: any) => notifyError(e.message),
  });

  // ── lane form ──
  const [lFrom, setLFrom] = useState('');
  const [lTo, setLTo] = useState('');
  const [lLead, setLLead] = useState('');
  const [lMoq, setLMoq] = useState('');
  const [lPack, setLPack] = useState('');

  const addLane = useMutation({
    mutationFn: () => api('/api/scm-network/lanes', {
      method: 'POST',
      body: JSON.stringify({
        from_node_id: Number(lFrom), to_node_id: Number(lTo),
        lead_time_mean_days: lLead ? Number(lLead) : undefined,
        moq: lMoq ? Number(lMoq) : undefined,
        pack_size: lPack ? Number(lPack) : undefined,
      }),
    }),
    onSuccess: () => { setLFrom(''); setLTo(''); setLLead(''); setLMoq(''); setLPack(''); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });
  const delLane = useMutation({
    mutationFn: (id: number) => api(`/api/scm-network/lanes/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: (e: any) => notifyError(e.message),
  });

  // ── plans (B2b, control SCM-05) ──
  const plans = useQuery<PlanRow[]>({
    queryKey: ['scm-network', 'plans'],
    queryFn: () => api('/api/scm-network/plans'),
    enabled: tab === 'plans',
  });
  const [pItem, setPItem] = useState('');
  const invalidatePlans = () => qc.invalidateQueries({ queryKey: ['scm-network', 'plans'] });
  const onErr = (e: any) => notifyError(e.message);
  const runPlan = useMutation({
    mutationFn: () => api('/api/scm-network/plans/run', { method: 'POST', body: JSON.stringify({ item_code: pItem.trim() }) }),
    onSuccess: () => { setPItem(''); invalidatePlans(); },
    onError: onErr,
  });
  const submitPlan = useMutation({ mutationFn: (id: number) => api(`/api/scm-network/plans/${id}/submit`, { method: 'POST' }), onSuccess: invalidatePlans, onError: onErr });
  const approvePlan = useMutation({ mutationFn: (id: number) => api(`/api/scm-network/plans/${id}/approve`, { method: 'POST', body: '{}' }), onSuccess: invalidatePlans, onError: onErr });
  const convertPlan = useMutation({ mutationFn: (id: number) => api(`/api/scm-network/plans/${id}/convert`, { method: 'POST' }), onSuccess: invalidatePlans, onError: onErr });

  const v = topo.data?.validation;

  return (
    <div className="space-y-6">
      <PageHeader title={t('scm.net_title')} description={t('scm.net_subtitle')} />

      {v && (
        <Card>
          <CardContent className="flex items-center gap-3 py-4">
            {v.ok
              ? <><CheckCircle2 className="h-5 w-5 text-emerald-600" /><span className="text-sm">{t('scm.net_valid')} · {v.reachableBranches.length} {t('scm.net_branches')}</span></>
              : <><AlertTriangle className="h-5 w-5 text-amber-600" /><span className="text-sm">{t('scm.net_invalid')}: {v.issues.map((i) => i.code).join(', ')}</span></>}
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2">
        <Button variant={tab === 'nodes' ? 'default' : 'outline'} size="sm" onClick={() => setTab('nodes')}>
          <Network className="mr-1 h-4 w-4" />{t('scm.net_tab_nodes')}
        </Button>
        <Button variant={tab === 'lanes' ? 'default' : 'outline'} size="sm" onClick={() => setTab('lanes')}>
          <Waypoints className="mr-1 h-4 w-4" />{t('scm.net_tab_lanes')}
        </Button>
        <Button variant={tab === 'plans' ? 'default' : 'outline'} size="sm" onClick={() => setTab('plans')}>
          <PlayCircle className="mr-1 h-4 w-4" />{t('scm.net_tab_plans')}
        </Button>
      </div>

      {tab === 'nodes' && (
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>{t('scm.net_add_node')}</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-5">
              <div><Label>{t('scm.net_code')}</Label><Input value={nCode} onChange={(e) => setNCode(e.target.value)} /></div>
              <div><Label>{t('scm.net_name')}</Label><Input value={nName} onChange={(e) => setNName(e.target.value)} /></div>
              <div>
                <Label>{t('scm.net_kind')}</Label>
                <Select value={nKind} onChange={(e) => setNKind(e.target.value as (typeof KINDS)[number])}>
                  {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </Select>
              </div>
              {nKind === 'branch'
                ? <div><Label>{t('scm.net_branch_id')}</Label><Input value={nBranch} onChange={(e) => setNBranch(e.target.value)} /></div>
                : <div><Label>{t('scm.net_holding')}</Label><Input value={nHold} onChange={(e) => setNHold(e.target.value)} /></div>}
              <div className="flex items-end"><Button onClick={() => addNode.mutate()} disabled={!nCode.trim() || !nName.trim() || addNode.isPending}>{t('scm.net_btn_add')}</Button></div>
            </CardContent>
          </Card>

          <StateView q={topo}>
            <DataTable
              rows={nodes}
              columns={[
                { key: 'nodeCode', label: t('scm.net_code') },
                { key: 'name', label: t('scm.net_name') },
                { key: 'kind', label: t('scm.net_kind'), render: (r: NodeRow) => <Badge>{r.kind}</Badge> },
                { key: 'echelon', label: t('scm.net_echelon') },
                { key: 'actions', label: '', render: (r: NodeRow) => <Button variant="ghost" size="sm" onClick={() => delNode.mutate(r.id)}>{t('scm.net_btn_del')}</Button> },
              ]}
            />
          </StateView>
        </div>
      )}

      {tab === 'lanes' && (
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>{t('scm.net_add_lane')}</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-6">
              <div>
                <Label>{t('scm.net_from')}</Label>
                <Select value={lFrom} onChange={(e) => setLFrom(e.target.value)}>
                  <option value="">—</option>
                  {nodes.map((n) => <option key={n.id} value={n.id}>{n.nodeCode}</option>)}
                </Select>
              </div>
              <div>
                <Label>{t('scm.net_to')}</Label>
                <Select value={lTo} onChange={(e) => setLTo(e.target.value)}>
                  <option value="">—</option>
                  {nodes.map((n) => <option key={n.id} value={n.id}>{n.nodeCode}</option>)}
                </Select>
              </div>
              <div><Label>{t('scm.net_lead')}</Label><Input value={lLead} onChange={(e) => setLLead(e.target.value)} /></div>
              <div><Label>MOQ</Label><Input value={lMoq} onChange={(e) => setLMoq(e.target.value)} /></div>
              <div><Label>{t('scm.net_pack')}</Label><Input value={lPack} onChange={(e) => setLPack(e.target.value)} /></div>
              <div className="flex items-end"><Button onClick={() => addLane.mutate()} disabled={!lFrom || !lTo || addLane.isPending}>{t('scm.net_btn_add')}</Button></div>
            </CardContent>
          </Card>

          <StateView q={topo}>
            <DataTable
              rows={topo.data?.lanes ?? []}
              columns={[
                { key: 'from', label: t('scm.net_from'), render: (r: LaneRow) => codeById.get(r.fromNodeId) ?? String(r.fromNodeId) },
                { key: 'to', label: t('scm.net_to'), render: (r: LaneRow) => codeById.get(r.toNodeId) ?? String(r.toNodeId) },
                { key: 'leadTimeMeanDays', label: t('scm.net_lead') },
                { key: 'moq', label: 'MOQ' },
                { key: 'packSize', label: t('scm.net_pack') },
                { key: 'actions', label: '', render: (r: LaneRow) => <Button variant="ghost" size="sm" onClick={() => delLane.mutate(r.id)}>{t('scm.net_btn_del')}</Button> },
              ]}
            />
          </StateView>
        </div>
      )}

      {tab === 'plans' && (
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>{t('scm.net_run_plan')}</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2"><Label>{t('scm.net_item')}</Label><Input value={pItem} onChange={(e) => setPItem(e.target.value)} /></div>
              <div className="flex items-end"><Button onClick={() => runPlan.mutate()} disabled={!pItem.trim() || runPlan.isPending}>{t('scm.net_btn_run')}</Button></div>
            </CardContent>
          </Card>

          <StateView q={plans}>
            <DataTable
              rows={plans.data ?? []}
              columns={[
                { key: 'planNo', label: t('scm.net_plan_no') },
                { key: 'itemCode', label: t('scm.net_item') },
                { key: 'status', label: t('scm.net_status'), render: (r: PlanRow) => <Badge>{r.status}</Badge> },
                { key: 'engine', label: 'Engine', render: (r: PlanRow) => <Badge variant="outline">{r.engine}</Badge> },
                { key: 'poolingBenefitPct', label: t('scm.net_pooling'), render: (r: PlanRow) => (r.poolingBenefitPct ?? '—') },
                { key: 'prNo', label: 'PR', render: (r: PlanRow) => r.prNo ?? '—' },
                { key: 'actions', label: '', render: (r: PlanRow) => (
                  <div className="flex gap-1">
                    {(r.status === 'Draft' || r.status === 'Rejected') && <Button variant="ghost" size="sm" onClick={() => submitPlan.mutate(r.id)}>{t('scm.net_btn_submit')}</Button>}
                    {r.status === 'PendingApproval' && <Button variant="ghost" size="sm" onClick={() => approvePlan.mutate(r.id)}>{t('scm.net_btn_approve')}</Button>}
                    {r.status === 'Approved' && <Button variant="ghost" size="sm" onClick={() => convertPlan.mutate(r.id)}>{t('scm.net_btn_convert')}</Button>}
                  </div>
                ) },
              ]}
            />
          </StateView>
        </div>
      )}
    </div>
  );
}
