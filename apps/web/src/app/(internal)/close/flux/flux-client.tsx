'use client';

// CLS-01 (GL-25) — Flux / variance analysis client island. A preparer GENERATES a period movement analysis
// (P&L / BS; comparative prior period / prior year / budget) with configurable Δ$/Δ% thresholds; each
// threshold-breaching line REQUIRES a written explanation before an INDEPENDENT reviewer can sign it off
// (maker-checker). Read-only over gl_period_balances — posts nothing to the GL.
import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface FluxLine {
  id: number; account_code: string; account_name: string | null; account_type: string | null;
  current_amt: number; comparative_amt: number; delta_amt: number; delta_pct: number | null;
  breached: boolean; explanation: string | null; explained_by: string | null;
}
interface FluxAnalysis {
  id: number; period: string; basis: string; comparative: string; comparative_period: string | null;
  threshold_abs: number; threshold_pct: number; status: string; breached_count: number; explained_count: number;
  prepared_by: string | null; reviewed_by: string | null; note: string | null;
}
interface FluxDetail { analysis: FluxAnalysis; lines: FluxLine[] }

const thisMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

export function FluxClient({ initialList }: { initialList: FluxAnalysis[] }) {
  const { t } = useLang();
  const [list, setList] = useState<FluxAnalysis[]>(initialList);
  const [detail, setDetail] = useState<FluxDetail | null>(null);
  const [busy, setBusy] = useState(false);

  // Generate form
  const [period, setPeriod] = useState(thisMonth());
  const [basis, setBasis] = useState<'PL' | 'BS'>('PL');
  const [comparative, setComparative] = useState<'prior_period' | 'prior_year' | 'budget'>('prior_period');
  const [tAbs, setTAbs] = useState('10000');
  const [tPct, setTPct] = useState('10');

  // Per-line explanation drafts + reviewer note
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [reviewNote, setReviewNote] = useState('');

  const refetchList = useCallback(async () => {
    try { const r = await api<{ analyses: FluxAnalysis[] }>('/api/close/flux'); setList(r.analyses ?? []); }
    catch { /* keep last good */ }
  }, []);
  useEffect(() => { void refetchList(); }, [refetchList]);

  const open = useCallback(async (id: number) => {
    try { const r = await api<FluxDetail>(`/api/close/flux/${id}`); setDetail(r); setDrafts({}); setReviewNote(''); }
    catch (e) { notifyError((e as Error).message || t('fnx.flux.load_error')); }
  }, [t]);

  const generate = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api<FluxDetail>('/api/close/flux/generate', {
        method: 'POST',
        body: JSON.stringify({ period, basis, comparative, threshold_abs: Number(tAbs) || 0, threshold_pct: Number(tPct) || 0 }),
      });
      notifySuccess(t('fnx.flux.generated'));
      setDetail(r); setDrafts({}); setReviewNote('');
      await refetchList();
    } catch (e) { notifyError((e as Error).message); } finally { setBusy(false); }
  }, [period, basis, comparative, tAbs, tPct, refetchList, t]);

  const explain = useCallback(async (lineId: number) => {
    if (!detail) return;
    const text = (drafts[lineId] ?? '').trim();
    if (!text) return;
    setBusy(true);
    try {
      const r = await api<FluxDetail>(`/api/close/flux/${detail.analysis.id}/lines/${lineId}/explain`, {
        method: 'PUT', body: JSON.stringify({ explanation: text }),
      });
      notifySuccess(t('fnx.flux.explained_saved'));
      setDetail(r); await refetchList();
    } catch (e) { notifyError((e as Error).message); } finally { setBusy(false); }
  }, [detail, drafts, refetchList, t]);

  const review = useCallback(async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const r = await api<FluxDetail>(`/api/close/flux/${detail.analysis.id}/review`, {
        method: 'POST', body: JSON.stringify({ note: reviewNote.trim() || undefined }),
      });
      notifySuccess(t('fnx.flux.certified'));
      setDetail(r); await refetchList();
    } catch (e) { notifyError((e as Error).message); } finally { setBusy(false); }
  }, [detail, reviewNote, refetchList, t]);

  const statusBadge = (status: string) => {
    const label = status === 'Certified' ? t('fnx.flux.status_certified') : status === 'Explained' ? t('fnx.flux.status_explained') : t('fnx.flux.status_draft');
    const variant = status === 'Certified' ? 'default' : status === 'Explained' ? 'secondary' : 'outline';
    return <Badge variant={variant as any}>{label}</Badge>;
  };

  const a = detail?.analysis;
  const allExplained = a ? a.breached_count === a.explained_count : false;

  return (
    <div>
      <PageHeader title={t('fnx.flux.title')} description={t('fnx.flux.subtitle')} />

      {/* Generate form */}
      <Card className="mb-4">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Activity className="size-4" />{t('fnx.flux.generate')}</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className="space-y-1">
            <Label htmlFor="flux-period">{t('fnx.flux.period')}</Label>
            <Input id="flux-period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2025-06" />
          </div>
          <div className="space-y-1">
            <Label>{t('fnx.flux.basis')}</Label>
            <Select value={basis} onValueChange={(v) => setBasis(v as 'PL' | 'BS')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="PL">{t('fnx.flux.basis_pl')}</SelectItem>
                <SelectItem value="BS">{t('fnx.flux.basis_bs')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t('fnx.flux.comparative')}</Label>
            <Select value={comparative} onValueChange={(v) => setComparative(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="prior_period">{t('fnx.flux.cmp_prior_period')}</SelectItem>
                <SelectItem value="prior_year">{t('fnx.flux.cmp_prior_year')}</SelectItem>
                <SelectItem value="budget">{t('fnx.flux.cmp_budget')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="flux-abs">{t('fnx.flux.threshold_abs')}</Label>
            <Input id="flux-abs" type="number" value={tAbs} onChange={(e) => setTAbs(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="flux-pct">{t('fnx.flux.threshold_pct')}</Label>
            <Input id="flux-pct" type="number" value={tPct} onChange={(e) => setTPct(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button onClick={generate} disabled={busy} className="w-full">{t('fnx.flux.generate')}</Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Analyses list */}
        <Card className="lg:col-span-1">
          <CardHeader><CardTitle className="text-base">{t('fnx.flux.list_title')}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {list.length === 0 && <p className="text-sm text-muted-foreground">{t('fnx.flux.none')}</p>}
            {list.map((row) => (
              <button key={row.id} onClick={() => open(row.id)} className={`flex w-full items-center justify-between rounded-md border p-2 text-left text-sm hover:bg-muted ${detail?.analysis.id === row.id ? 'border-primary bg-muted' : ''}`}>
                <span>
                  <span className="font-medium">{row.period}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{row.basis} · {row.comparative_period}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{t('fnx.flux.breached_summary', { b: String(row.breached_count), e: String(row.explained_count) })}</span>
                </span>
                {statusBadge(row.status)}
              </button>
            ))}
          </CardContent>
        </Card>

        {/* Detail: lines + explanation + sign-off */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">
              {a ? <>{a.period} · {a.basis} <span className="text-muted-foreground">({t('fnx.flux.col_comparative')}: {a.comparative_period})</span></> : t('fnx.flux.title')}
            </CardTitle>
            {a && statusBadge(a.status)}
          </CardHeader>
          <CardContent>
            {!a && <p className="text-sm text-muted-foreground">{t('fnx.flux.none')}</p>}
            {a && (
              <>
                <p className="mb-3 text-xs text-muted-foreground">
                  {t('fnx.flux.prepared_by')}: {a.prepared_by ?? '—'}
                  {a.reviewed_by ? <> · {t('fnx.flux.reviewed_by')}: {a.reviewed_by}</> : null}
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-1 pr-2">{t('fnx.flux.col_account')}</th>
                        <th className="py-1 pr-2 text-right">{t('fnx.flux.col_current')}</th>
                        <th className="py-1 pr-2 text-right">{t('fnx.flux.col_comparative')}</th>
                        <th className="py-1 pr-2 text-right">{t('fnx.flux.col_delta')}</th>
                        <th className="py-1 pr-2 text-right">{t('fnx.flux.col_delta_pct')}</th>
                        <th className="py-1">{t('fnx.flux.col_explanation')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail!.lines.map((l) => (
                        <tr key={l.id} className={`border-b align-top ${l.breached ? 'bg-warning/10' : ''}`}>
                          <td className="py-2 pr-2">
                            <div className="font-medium">{l.account_code}</div>
                            <div className="text-xs text-muted-foreground">{l.account_name}</div>
                            {l.breached && <Badge variant="outline" className="mt-1 gap-1 text-warning-foreground"><AlertTriangle className="size-3" />{t('fnx.flux.breached')}</Badge>}
                          </td>
                          <td className="py-2 pr-2 text-right tabular-nums">{baht(l.current_amt)}</td>
                          <td className="py-2 pr-2 text-right tabular-nums">{baht(l.comparative_amt)}</td>
                          <td className="py-2 pr-2 text-right tabular-nums">{baht(l.delta_amt)}</td>
                          <td className="py-2 pr-2 text-right tabular-nums">{l.delta_pct == null ? '—' : `${l.delta_pct}%`}</td>
                          <td className="py-2">
                            {l.explanation ? (
                              <div className="text-xs"><span>{l.explanation}</span>{l.explained_by && <span className="block text-muted-foreground">— {l.explained_by}</span>}</div>
                            ) : l.breached && a.status !== 'Certified' ? (
                              <div className="flex flex-col gap-1">
                                <textarea
                                  className="min-h-[52px] w-full rounded-md border bg-background p-2 text-xs"
                                  placeholder={t('fnx.flux.explain_ph')}
                                  value={drafts[l.id] ?? ''}
                                  onChange={(e) => setDrafts((d) => ({ ...d, [l.id]: e.target.value }))}
                                />
                                <Button size="sm" variant="outline" disabled={busy || !(drafts[l.id] ?? '').trim()} onClick={() => explain(l.id)}>{t('fnx.flux.save_explanation')}</Button>
                              </div>
                            ) : <span className="text-xs text-muted-foreground">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Sign-off */}
                {a.status !== 'Certified' && (
                  <div className="mt-4 rounded-md border p-3">
                    <p className="mb-2 text-xs text-muted-foreground">
                      {allExplained ? t('fnx.flux.self_review_hint') : t('fnx.flux.unexplained_hint')}
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Input value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder={t('fnx.flux.review_note_ph')} className="sm:flex-1" />
                      <Button onClick={review} disabled={busy || !allExplained} className="gap-1"><ShieldCheck className="size-4" />{t('fnx.flux.review')}</Button>
                    </div>
                  </div>
                )}
                {a.status === 'Certified' && (
                  <div className="mt-4 flex items-center gap-2 rounded-md border border-l-4 border-l-success p-3 text-sm text-success">
                    <CheckCircle2 className="size-4" />{t('fnx.flux.certified')} · {a.reviewed_by}
                    {a.note && <span className="text-muted-foreground">— {a.note}</span>}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
