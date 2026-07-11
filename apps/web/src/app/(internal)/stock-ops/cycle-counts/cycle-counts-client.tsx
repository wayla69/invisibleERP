'use client';

// INV-3 / INV-17 — Cycle-count program with ABC classification + blind counts (client island).
// Irreducible client boundary: runs the client-only t() hook + interactive tabs, the recompute-ABC mutation,
// blind count generation and blind physical-count entry (react-query). The system/book qty is NEVER fetched
// or shown here — the generate response withholds it, and posting the variance stays on /stock-adjustment.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, RefreshCw, Plus, ListChecks, Layers } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { num, thaiDate } from '@/lib/format';
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
import { statusVariant } from '@/components/ui';

const classVariant = (c: string) => (c === 'A' ? 'destructive' : c === 'B' ? 'warning' : 'secondary');

export default function CycleCountsClient({ initialAbc, initialDue, initialTasks }: { initialAbc?: unknown; initialDue?: unknown; initialTasks?: unknown }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('iv.cc_title')} description={t('iv.cc_desc')} />
      <Tabs
        tabs={[
          { key: 'due', label: t('iv.cc_tab_due'), content: <Due initialDue={initialDue} /> },
          { key: 'abc', label: t('iv.cc_tab_abc'), content: <Abc initialAbc={initialAbc} /> },
          { key: 'tasks', label: t('iv.cc_tab_tasks'), content: <TasksTab initialTasks={initialTasks} /> },
        ]}
      />
    </div>
  );
}

// ── ABC classification tab ──
function Abc({ initialAbc }: { initialAbc?: unknown }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['cc', 'abc'], queryFn: () => api('/api/stock-ops/abc'), initialData: initialAbc as any });
  const recompute = useMutation({
    mutationFn: () => api<any>('/api/stock-ops/abc/recompute', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r) => { notifySuccess(t('iv.cc_recompute_ok', { n: r.recomputed })); qc.invalidateQueries({ queryKey: ['cc'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const s = q.data?.summary ?? { A: 0, B: 0, C: 0 };
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          {(['A', 'B', 'C'] as const).map((c) => (
            <Badge key={c} variant={classVariant(c)}>{t('iv.cc_class')} {c}: {num(s[c] ?? 0)}</Badge>
          ))}
          {q.data?.plans?.map((p: any) => (
            <span key={p.class} className="text-xs text-muted-foreground">{p.class}={p.cadence_days}{t('iv.cc_days')}</span>
          ))}
        </div>
        <Button disabled={recompute.isPending} onClick={() => recompute.mutate()}>
          <RefreshCw className="size-4" /> {recompute.isPending ? t('iv.cc_recomputing') : t('iv.cc_recompute')}
        </Button>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.classes ?? []}
            columns={[
              { key: 'rank', label: t('iv.cc_col_rank'), align: 'right', render: (r: any) => <span className="tabular">{num(r.rank)}</span> },
              { key: 'item_id', label: t('inv.col_code') },
              { key: 'item_description', label: t('iv.stk_item') },
              { key: 'class', label: t('iv.cc_col_class'), render: (r: any) => <Badge variant={classVariant(r.class)}>{r.class}</Badge> },
              { key: 'annual_value', label: t('iv.cc_col_annual_value'), align: 'right', render: (r: any) => <span className="tabular">{num(r.annual_value)}</span> },
              { key: 'cum_pct', label: t('iv.cc_col_cum'), align: 'right', render: (r: any) => <span className="tabular">{num(r.cum_pct)}%</span> },
            ]}
            emptyState={{ icon: Layers, title: t('iv.cc_abc_empty'), description: t('iv.cc_abc_empty_desc') }}
          />
        )}
      </StateView>
    </div>
  );
}

// ── Due worklist tab (generate a blind count, then enter physical counts) ──
function Due({ initialDue }: { initialDue?: unknown }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['cc', 'due'], queryFn: () => api('/api/stock-ops/cycle-counts/due'), initialData: initialDue as any });
  const [sel, setSel] = useState<string[]>([]);
  // The active blind count: item list (WITHOUT system qty) + the counter's entered physical counts.
  const [task, setTask] = useState<{ task_no: string; st_no: string; items: any[] } | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});

  const generate = useMutation({
    mutationFn: () => api<any>('/api/stock-ops/cycle-counts', { method: 'POST', body: JSON.stringify(sel.length ? { item_ids: sel } : {}) }),
    onSuccess: (r) => { setTask({ task_no: r.task_no, st_no: r.st_no, items: r.items ?? [] }); setCounts({}); setSel([]); notifySuccess(t('iv.cc_gen_ok', { taskNo: r.task_no })); qc.invalidateQueries({ queryKey: ['cc'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const submit = useMutation({
    mutationFn: () => api<any>(`/api/stock-ops/cycle-counts/${task!.task_no}/count`, {
      method: 'POST',
      body: JSON.stringify({ lines: task!.items.filter((i) => counts[i.item_id] !== undefined && counts[i.item_id] !== '').map((i) => ({ item_id: i.item_id, physical_qty: Number(counts[i.item_id]) })) }),
    }),
    onSuccess: (r) => { notifySuccess(t('iv.cc_count_ok', { stNo: r.st_no, n: r.variance_lines })); setTask(null); setCounts({}); qc.invalidateQueries({ queryKey: ['cc'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div className="space-y-4">
      {!task && (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
          <p className="text-sm text-muted-foreground">{t('iv.cc_due_hint')}</p>
          <Button disabled={generate.isPending || !(q.data?.due?.length)} onClick={() => generate.mutate()}>
            <Plus className="size-4" /> {sel.length ? t('iv.cc_gen_selected', { n: sel.length }) : t('iv.cc_gen_all')}
          </Button>
        </Card>
      )}

      {task ? (
        // BLIND count entry — the counter enters physical counts; the system/book qty is NOT shown.
        <Card className="gap-3 p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold">{t('iv.cc_counting', { taskNo: task.task_no })}</h3>
            <Button variant="ghost" size="sm" onClick={() => { setTask(null); setCounts({}); }}>{t('iv.stk_close')}</Button>
          </div>
          <p className="text-sm text-muted-foreground">{t('iv.cc_blind_note')}</p>
          <div className="space-y-2">
            {task.items.map((i) => (
              <div key={i.item_id} className="flex flex-wrap items-end gap-2">
                <div className="min-w-[220px] flex-1">
                  <Label>{i.item_id} — {i.item_description ?? ''}</Label>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`cc-${i.item_id}`}>{t('iv.cc_physical')}</Label>
                  <Input id={`cc-${i.item_id}`} type="number" className="max-w-[140px]" value={counts[i.item_id] ?? ''} onChange={(e) => setCounts((c) => ({ ...c, [i.item_id]: e.target.value }))} />
                </div>
              </div>
            ))}
          </div>
          <Button disabled={submit.isPending} onClick={() => submit.mutate()}>{submit.isPending ? t('iv.stk_saving') : t('iv.cc_submit_count')}</Button>
          <p className="text-xs text-muted-foreground">{t('iv.cc_post_note')} <a href="/stock-adjustment" className="text-primary underline">/stock-adjustment</a></p>
        </Card>
      ) : (
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={q.data.due ?? []}
              columns={[
                { key: 'sel', label: '', render: (r: any) => <input type="checkbox" checked={sel.includes(r.item_id)} onChange={() => toggle(r.item_id)} aria-label={r.item_id} /> },
                { key: 'item_id', label: t('inv.col_code') },
                { key: 'item_description', label: t('iv.stk_item') },
                { key: 'class', label: t('iv.cc_col_class'), render: (r: any) => <Badge variant={classVariant(r.class)}>{r.class}</Badge> },
                { key: 'cadence_days', label: t('iv.cc_col_cadence'), align: 'right', render: (r: any) => <span className="tabular">{num(r.cadence_days)}{t('iv.cc_days')}</span> },
                { key: 'last_counted', label: t('iv.cc_col_last'), render: (r: any) => (r.never_counted ? <Badge variant="warning">{t('iv.cc_never')}</Badge> : thaiDate(r.last_counted)) },
                { key: 'next_due', label: t('iv.cc_col_next'), render: (r: any) => (r.next_due ? thaiDate(r.next_due) : '—') },
              ]}
              emptyState={{ icon: ListChecks, title: t('iv.cc_due_empty'), description: t('iv.cc_due_empty_desc') }}
            />
          )}
        </StateView>
      )}
    </div>
  );
}

// ── Task history tab ──
function TasksTab({ initialTasks }: { initialTasks?: unknown }) {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['cc', 'tasks'], queryFn: () => api('/api/stock-ops/cycle-counts'), initialData: initialTasks as any });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable
          rows={q.data.tasks ?? []}
          columns={[
            { key: 'task_no', label: t('dash.col_no') },
            { key: 'created_at', label: t('dash.col_date'), render: (r: any) => thaiDate(r.created_at) },
            { key: 'class', label: t('iv.cc_col_class'), render: (r: any) => (r.class ? <Badge variant={classVariant(r.class)}>{r.class}</Badge> : '—') },
            { key: 'item_count', label: t('iv.stk_col_lines'), align: 'right', render: (r: any) => <span className="tabular">{num(r.item_count)}</span> },
            { key: 'counted_by', label: t('iv.stk_col_counted_by') },
            { key: 'st_no', label: t('iv.cc_col_stocktake') },
            { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
          ]}
          emptyState={{ icon: ClipboardList, title: t('iv.cc_tasks_empty'), description: t('iv.cc_tasks_empty_desc') }}
        />
      )}
    </StateView>
  );
}
