'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Layers, Plus, Trash2, ShieldCheck, CheckCircle2, ClipboardList } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

interface RevisionHead { rev_no: string; status: string; reason: string | null; revaluation_total: number; je_no: string | null; prepared_by: string | null; approved_by: string | null }
interface RevisionLine { item_id: string; old_std: number; new_std: number; on_hand_snapshot: number; revaluation_amount: number; current_std: number | null }
interface RevisionDetail extends RevisionHead { lines: RevisionLine[] }
interface DraftLine { item_id: string; new_std: string }

// INV-4 (COST-02) — the standard-cost roll / inventory-revaluation workspace. A preparer proposes a new
// standard per STD-costed item (on-hand is snapshotted; nothing posts); a DIFFERENT user approves it → the
// stored standard rolls forward and a balanced revaluation JE posts (Dr/Cr 1200 ↔ 5500). Self-approval is
// rejected by the API (403 SOD_SELF_APPROVAL).
export default function StdCostClient({ initialRevisions }: { initialRevisions?: { revisions: RevisionHead[] } }) {
  const { t } = useLang();
  const qc = useQueryClient();

  const q = useQuery<{ revisions: RevisionHead[] }>({
    queryKey: ['std-cost-revisions'],
    queryFn: () => api('/api/costing/std-cost'),
    initialData: initialRevisions,
  });

  // ── Propose a revision ──
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ item_id: '', new_std: '' }]);
  const setLine = (i: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { item_id: '', new_std: '' }]);
  const removeLine = (i: number) => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls));
  const validLines = lines.filter((l) => l.item_id.trim() && l.new_std !== '' && Number(l.new_std) >= 0);

  const revise = useMutation({
    mutationFn: () => api<{ rev_no: string }>('/api/costing/std-cost/revise', {
      method: 'POST',
      body: JSON.stringify({ reason: reason || undefined, lines: validLines.map((l) => ({ item_id: l.item_id.trim(), new_std: Number(l.new_std) })) }),
    }),
    onSuccess: (r) => {
      notifySuccess(t('sc.revised_ok', { no: r.rev_no }));
      setReason(''); setLines([{ item_id: '', new_std: '' }]);
      qc.invalidateQueries({ queryKey: ['std-cost-revisions'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  // ── Detail + approve ──
  const [openNo, setOpenNo] = useState<string | null>(null);
  const detail = useQuery<RevisionDetail>({
    queryKey: ['std-cost-detail', openNo],
    queryFn: () => api(`/api/costing/std-cost/${encodeURIComponent(openNo as string)}`),
    enabled: !!openNo,
  });

  const approve = useMutation({
    mutationFn: (no: string) => api<{ rev_no: string; revaluation_total: number }>(`/api/costing/std-cost/${encodeURIComponent(no)}/approve`, { method: 'POST' }),
    onSuccess: (r) => {
      notifySuccess(t('sc.approved_ok', { no: r.rev_no, amount: baht(r.revaluation_total) }));
      qc.invalidateQueries({ queryKey: ['std-cost-revisions'] });
      qc.invalidateQueries({ queryKey: ['std-cost-detail', r.rev_no] });
      qc.invalidateQueries({ queryKey: ['costing-valuation'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const revisions = q.data?.revisions ?? [];

  return (
    <div>
      <PageHeader title={t('sc.title')} description={t('sc.desc')} />

      <div className="space-y-5">
        {/* Propose a revision */}
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="text-base">{t('sc.propose_title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('sc.propose_hint')}</p>
            <div className="space-y-3">
              {lines.map((l, i) => (
                <div key={i} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
                  <div className="grid gap-2">
                    <Label htmlFor={`sc-item-${i}`}>{t('sc.col_item')}</Label>
                    <Input id={`sc-item-${i}`} value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })} placeholder="STDPART" />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`sc-std-${i}`}>{t('sc.col_new_std')}</Label>
                    <Input id={`sc-std-${i}`} type="number" min="0" step="0.0001" value={l.new_std} onChange={(e) => setLine(i, { new_std: e.target.value })} placeholder="0.00" />
                  </div>
                  <Button variant="ghost" size="icon" aria-label={t('sc.remove_line')} disabled={lines.length === 1} onClick={() => removeLine(i)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="grid gap-2 sm:max-w-md">
              <Label htmlFor="sc-reason">{t('sc.reason')}</Label>
              <Input id="sc-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('sc.reason_ph')} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={addLine}><Plus className="size-4" /> {t('sc.add_line')}</Button>
              <Button disabled={revise.isPending || validLines.length === 0} onClick={() => revise.mutate()}>
                <ClipboardList className="size-4" /> {revise.isPending ? t('sc.submitting') : t('sc.submit')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Register */}
        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('sc.register_title')}</h3>
          <StateView q={q}>
            <DataTable
              rows={revisions}
              rowKey={(r) => r.rev_no}
              onRowClick={(r) => setOpenNo((cur) => (cur === r.rev_no ? null : r.rev_no))}
              emptyState={{ icon: Layers, title: t('sc.empty_title'), description: t('sc.empty_desc') }}
              columns={[
                { key: 'rev_no', label: t('sc.col_rev_no'), render: (r: RevisionHead) => <span className="font-medium">{r.rev_no}</span> },
                { key: 'status', label: t('sc.col_status'), render: (r: RevisionHead) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                { key: 'revaluation_total', label: t('sc.col_impact'), align: 'right', render: (r: RevisionHead) => <span className="tabular">{baht(r.revaluation_total)}</span> },
                { key: 'prepared_by', label: t('sc.col_prepared_by'), render: (r: RevisionHead) => r.prepared_by ?? '—' },
                { key: 'approved_by', label: t('sc.col_approved_by'), render: (r: RevisionHead) => r.approved_by ?? '—' },
              ]}
            />
          </StateView>
        </div>

        {/* Detail — proposed vs current + revalue impact + approve */}
        {openNo && (
          <Card className="gap-4">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-base">{t('sc.detail_title', { no: openNo })}</CardTitle>
              {detail.data?.status === 'Draft' && (
                <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate(openNo)}>
                  <CheckCircle2 className="size-4" /> {t('sc.approve')}
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              <StateView q={detail}>
                {detail.data && (
                  <>
                    <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                      <Badge variant={statusVariant(detail.data.status)}>{detail.data.status}</Badge>
                      {detail.data.reason && <span>{t('sc.reason')}: <span className="text-foreground">{detail.data.reason}</span></span>}
                      {detail.data.je_no && <span>{t('sc.je_no')}: <span className="font-medium text-foreground">{detail.data.je_no}</span></span>}
                      {detail.data.status === 'Draft' && (
                        <span className="inline-flex items-center gap-1"><ShieldCheck className="size-3.5" /> {t('sc.sod_hint')}</span>
                      )}
                    </div>
                    <DataTable
                      rows={detail.data.lines}
                      rowKey={(r) => r.item_id}
                      columns={[
                        { key: 'item_id', label: t('sc.col_item') },
                        { key: 'current_std', label: t('sc.col_current_std'), align: 'right', render: (r: RevisionLine) => <span className="tabular">{r.current_std == null ? '—' : baht(r.current_std)}</span> },
                        { key: 'old_std', label: t('sc.col_old_std'), align: 'right', render: (r: RevisionLine) => <span className="tabular">{baht(r.old_std)}</span> },
                        { key: 'new_std', label: t('sc.col_new_std'), align: 'right', render: (r: RevisionLine) => <span className="tabular font-medium">{baht(r.new_std)}</span> },
                        { key: 'on_hand_snapshot', label: t('sc.col_on_hand'), align: 'right', render: (r: RevisionLine) => <span className="tabular">{num(r.on_hand_snapshot)}</span> },
                        { key: 'revaluation_amount', label: t('sc.col_impact'), align: 'right', render: (r: RevisionLine) => <span className={`tabular font-medium ${r.revaluation_amount < 0 ? 'text-destructive' : ''}`}>{baht(r.revaluation_amount)}</span> },
                      ]}
                    />
                  </>
                )}
              </StateView>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
