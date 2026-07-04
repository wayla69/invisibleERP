'use client';

// Phase G1 (docs/25) — lifecycle journeys: a linear multi-step drip (wait N days → send, unless a skip-rule
// matches). Steps are built with the same catalog-driven grammar as the segment builder; sends are
// consent-gated + frequency-capped and each step fires at most once (MKT-12) — enforced server-side.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Route, Plus, Play, Pause, Pencil, X, Users, Filter } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';
const tone: Record<string, any> = { draft: 'muted', active: 'success', paused: 'info' };

interface Step { wait_days: number; channel: string; body: string; skip_rule?: { field: string; op: string; value: any } | null; branch_rule?: { field: string; op: string; value: any } | null; branch_to_step?: number | null }
interface Catalog { fields: { key: string; kind: string }[] }
const OP_SYMBOL: Record<string, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' };
const OPS_BY_KIND: Record<string, string[]> = { num: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'], text: ['eq', 'ne', 'contains'], bool: ['eq', 'ne'] };
interface Journey { id: number; code: string; name: string; status: string; trigger: string; segment_id: number | null; cap_messages: number; cap_window_days: number; steps: Step[]; funnel: { active: number; completed: number; exited: number } }
interface SavedSegment { id: number; name: string }

export default function JourneysPage() {
  const { t } = useLang();
  const opLabel = (op: string) => (op === 'contains' ? t('ly.seg_op_contains') : OP_SYMBOL[op] ?? op);
  const qc = useQueryClient();
  const list = useQuery<{ journeys: Journey[] }>({ queryKey: ['journeys'], queryFn: () => api('/api/loyalty/journeys') });
  const segs = useQuery<{ segments: SavedSegment[] }>({ queryKey: ['saved-segments'], queryFn: () => api('/api/loyalty/saved-segments') });

  const [editId, setEditId] = useState<number | null>(null);
  const [f, setF] = useState({ name: '', trigger: 'manual', segment_id: '', cap_messages: '0', cap_window_days: '7' });
  const catalog = useQuery<Catalog>({ queryKey: ['seg-catalog'], queryFn: () => api('/api/loyalty/saved-segments/catalog'), staleTime: 300_000 });
  const kindOf = (field: string) => catalog.data?.fields.find((c) => c.key === field)?.kind ?? 'num';
  const [steps, setSteps] = useState<Step[]>([{ wait_days: 0, channel: 'sms', body: '' }]);
  const set = (p: Partial<typeof f>) => setF((s) => ({ ...s, ...p }));
  const setStep = (i: number, p: Partial<Step>) => setSteps((ss) => ss.map((s, ix) => (ix === i ? { ...s, ...p } : s)));
  const reset = () => { setEditId(null); setF({ name: '', trigger: 'manual', segment_id: '', cap_messages: '0', cap_window_days: '7' }); setSteps([{ wait_days: 0, channel: 'sms', body: '' }]); };
  const loadForEdit = (j: Journey) => {
    setEditId(j.id);
    setF({ name: j.name, trigger: j.trigger, segment_id: j.segment_id ? String(j.segment_id) : '', cap_messages: String(j.cap_messages), cap_window_days: String(j.cap_window_days) });
    setSteps(j.steps.map((s) => ({ ...s })));
  };

  const save = useMutation({
    mutationFn: () => api('/api/loyalty/journeys', { method: 'POST', body: JSON.stringify({
      ...(editId ? { id: editId } : {}), name: f.name, trigger: f.trigger,
      ...(f.trigger === 'segment' ? { segment_id: Number(f.segment_id) } : {}),
      cap_messages: Number(f.cap_messages) || 0, cap_window_days: Number(f.cap_window_days) || 7,
      steps: steps.map((s) => ({ wait_days: Number(s.wait_days) || 0, channel: s.channel, body: s.body, ...(s.branch_to_step != null && s.branch_rule ? { branch_rule: { ...s.branch_rule, value: kindOf(s.branch_rule.field) === 'num' ? Number(s.branch_rule.value) : s.branch_rule.value }, branch_to_step: Number(s.branch_to_step) } : {}) })),
    }) }),
    onSuccess: () => { notifySuccess(editId ? t('ly.jr_updated') : t('ly.jr_created')); reset(); qc.invalidateQueries({ queryKey: ['journeys'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const setStatus = useMutation({
    mutationFn: (p: { j: Journey; action: 'activate' | 'pause' }) => api(`/api/loyalty/journeys/${p.j.id}/${p.action}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['journeys'] }),
    onError: (e: Error) => notifyError(e.message),
  });

  return (
    <div>
      <PageHeader title={t('ly.jr_title')} description={t('ly.jr_desc')} actions={<Link href="/loyalty/segments"><Button variant="outline"><Filter className="size-4" /> {t('ly.lc_segment')}</Button></Link>} />

      <div className="space-y-6">
        <Card className="gap-4">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="size-4" /> {editId ? t('ly.jr_edit_title', { id: editId }) : t('ly.jr_create')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="grid gap-1.5 sm:col-span-2"><Label>{t('ly.jr_name')}</Label><Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('ly.jr_name_ph')} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.jr_trigger')}</Label><select className={selectCls} value={f.trigger} onChange={(e) => set({ trigger: e.target.value })}><option value="manual">{t('ly.jr_trig_manual')}</option><option value="segment">{t('ly.jr_trig_segment')}</option></select></div>
              {f.trigger === 'segment' && <div className="grid gap-1.5"><Label>{t('ly.lc_segment')}</Label><select className={selectCls} value={f.segment_id} onChange={(e) => set({ segment_id: e.target.value })}><option value="">{t('ly.pt_select')}</option>{(segs.data?.segments ?? []).map((sg) => <option key={sg.id} value={sg.id}>{sg.name}</option>)}</select></div>}
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="grid gap-1.5"><Label>{t('ly.jr_cap_messages')}</Label><Input type="number" min="0" value={f.cap_messages} onChange={(e) => set({ cap_messages: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.jr_cap_window')}</Label><Input type="number" min="1" value={f.cap_window_days} onChange={(e) => set({ cap_window_days: e.target.value })} /></div>
            </div>
            <div className="space-y-2">
              <Label>{t('ly.jr_steps_label')}</Label>
              {steps.map((s, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Badge variant="muted">{t('ly.jr_step', { n: i + 1 })}</Badge>
                  <span className="text-sm text-muted-foreground">{t('ly.jr_wait')}</span>
                  <Input className="w-20" type="number" min="0" value={s.wait_days} onChange={(e) => setStep(i, { wait_days: Number(e.target.value) })} aria-label={t('ly.jr_aria_wait', { n: i + 1 })} />
                  <span className="text-sm text-muted-foreground">{t('ly.jr_days_then_send')}</span>
                  <select className={selectCls} value={s.channel} onChange={(e) => setStep(i, { channel: e.target.value })} aria-label={t('ly.jr_aria_channel', { n: i + 1 })}><option value="sms">SMS</option><option value="email">Email</option><option value="line">LINE</option></select>
                  <Input className="min-w-64 flex-1" value={s.body} onChange={(e) => setStep(i, { body: e.target.value })} placeholder={t('ly.jr_body_ph')} aria-label={t('ly.jr_aria_body', { n: i + 1 })} />
                  {steps.length > 1 && <Button size="sm" variant="ghost" onClick={() => setSteps((ss) => ss.filter((_, ix) => ix !== i))} aria-label={t('ly.jr_aria_remove', { n: i + 1 })}><X className="size-3.5" /></Button>}
                  {i < steps.length - 1 && (
                    <div className="flex w-full flex-wrap items-center gap-2 pl-6 text-xs text-muted-foreground">
                      <span>{t('ly.jr_branch')}</span>
                      <select className={selectCls} value={s.branch_to_step ?? ''} onChange={(e) => setStep(i, e.target.value === '' ? { branch_to_step: null, branch_rule: null } : { branch_to_step: Number(e.target.value), branch_rule: s.branch_rule ?? { field: 'recency', op: 'lt', value: '' } })} aria-label={t('ly.jr_aria_branch_to', { n: i + 1 })}>
                        <option value="">{t('ly.jr_branch_seq')}</option>
                        {steps.map((_, ix) => ix + 1).filter((no) => no > i + 1).map((no) => <option key={no} value={no}>{t('ly.jr_branch_goto', { no })}</option>)}
                      </select>
                      {s.branch_to_step != null && s.branch_rule && (
                        <>
                          <span>{t('ly.jr_when')}</span>
                          <select className={selectCls} value={s.branch_rule.field} onChange={(e) => setStep(i, { branch_rule: { field: e.target.value, op: OPS_BY_KIND[kindOf(e.target.value)][0], value: '' } })} aria-label={t('ly.jr_aria_bfield', { n: i + 1 })}>
                            {(catalog.data?.fields ?? []).map((c) => <option key={c.key} value={c.key}>{c.key}</option>)}
                          </select>
                          <select className={selectCls} value={s.branch_rule.op} onChange={(e) => setStep(i, { branch_rule: { ...s.branch_rule!, op: e.target.value } })} aria-label={t('ly.jr_aria_bop', { n: i + 1 })}>
                            {OPS_BY_KIND[kindOf(s.branch_rule.field)].map((op) => <option key={op} value={op}>{opLabel(op)}</option>)}
                          </select>
                          <Input className="w-28" value={s.branch_rule.value ?? ''} onChange={(e) => setStep(i, { branch_rule: { ...s.branch_rule!, value: e.target.value } })} placeholder={t('ly.jr_value_ph')} aria-label={t('ly.jr_aria_bvalue', { n: i + 1 })} />
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
              <Button size="sm" variant="outline" onClick={() => setSteps((ss) => [...ss, { wait_days: 7, channel: 'sms', body: '' }])}><Plus className="size-3.5" /> {t('ly.jr_add_step')}</Button>
            </div>
            <div className="flex items-center gap-3">
              <Button onClick={() => save.mutate()} disabled={!f.name.trim() || steps.some((s) => !s.body.trim()) || (f.trigger === 'segment' && !f.segment_id) || save.isPending}>{save.isPending ? t('ly.saving') : editId ? t('ly.seg_save_edit') : t('ly.jr_create')}</Button>
              {editId != null && <Button variant="ghost" onClick={reset}>{t('fin.cancel')}</Button>}
              <span className="text-xs text-muted-foreground">{t('ly.jr_edit_note')}</span>
            </div>
          </CardContent>
        </Card>

        <StateView q={list}>
          {list.data && (
            <DataTable
              rows={list.data.journeys}
              rowKey={(j) => j.id}
              emptyState={{ icon: Route, title: t('ly.jr_empty'), description: t('ly.jr_empty_desc') }}
              columns={[
                { key: 'code', label: t('ly.col_code'), render: (j) => <span className="font-mono text-xs">{j.code}</span> },
                { key: 'name', label: t('ly.col_name'), render: (j) => <span className="inline-flex items-center gap-1.5"><Route className="size-3.5 text-muted-foreground" />{j.name}</span> },
                { key: 'trigger', label: t('ly.jr_col_trigger'), render: (j) => <Badge variant="info">{j.trigger === 'segment' ? `${t('ly.lc_segment')}:${segs.data?.segments.find((sg) => sg.id === j.segment_id)?.name ?? j.segment_id}` : 'manual'}</Badge> },
                { key: 'steps', label: t('ly.jr_col_steps'), render: (j) => <span className="text-xs text-muted-foreground">{j.steps.map((s) => t('ly.jr_step_compact', { d: s.wait_days, ch: s.channel })).join(' · ')}</span> },
                { key: 'funnel', label: t('ly.jr_col_funnel'), render: (j) => <span className="tabular inline-flex items-center gap-1 text-xs"><Users className="size-3.5 text-muted-foreground" />{num(j.funnel.active)}/{num(j.funnel.completed)}</span> },
                { key: 'status', label: t('fin.col_status'), render: (j) => <Badge variant={tone[j.status] ?? 'muted'}>{j.status}</Badge> },
                { key: 'act', label: '', align: 'right', render: (j) => (
                  <div className="flex justify-end gap-1">
                    {j.status !== 'active'
                      ? <Button size="sm" variant="outline" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ j, action: 'activate' })}><Play className="size-3.5" /> {t('ly.jr_activate')}</Button>
                      : <Button size="sm" variant="outline" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ j, action: 'pause' })}><Pause className="size-3.5" /> {t('ly.jr_pause')}</Button>}
                    <Button size="sm" variant="ghost" disabled={j.status === 'active'} onClick={() => loadForEdit(j)} aria-label={t('ly.seg_aria_edit', { name: j.name })}><Pencil className="size-3.5" /></Button>
                  </div>
                ) },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}
