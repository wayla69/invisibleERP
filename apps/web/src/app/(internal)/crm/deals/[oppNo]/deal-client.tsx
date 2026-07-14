'use client';

// CRM-2 — deal detail island: header + stage stepper (governed stage moves → crm_stage_history), the
// unified activity timeline (crm_activities + stage transitions + linked CPQ quotes merged
// chronologically), quick-add activity, next-step highlight, and the won-deal → project conversion
// (CRM-WL, ported from the old /projects/crm page).
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Phone, Mail, Users2, CalendarClock, CheckCircle2, Circle, FileSignature, FolderPlus,
  History, MessageSquare, Plus, StickyNote, Video, ClipboardList, Building2, Flag,
} from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { statusVariant } from '@/components/ui';
import { Select } from '@/components/form-controls';

interface Stage { id: number | null; name: string; sequence: number; defaultProbability: number; isWon: boolean | null; isLost: boolean | null }
interface Activity { id: number; entity_type: string; entity_no: string; type: string; subject: string | null; notes: string | null; due_date: string | null; done: boolean; owner: string | null; created_at: string }
interface HistoryRow { id: number; from_stage: string | null; to_stage: string; changed_by: string | null; changed_at: string }
interface Quote { id: number; quote_no: string; status: string; total: number; issued_date: string | null; expires_date: string | null; created_at: string }
interface FeedPost { id: number; body: string; author: string | null; mentions: string[]; created_at: string }
interface Deal {
  opp_no: string; name: string; stage: string; status: string; stage_id: number | null; amount: number;
  probability: number; expected_close_date: string | null; owner: string | null; lost_reason: string | null;
  win_reason: string | null; lead_no: string | null; created_at: string; closed_at: string | null;
  account: null | { account_no: string; name: string; customer_no: string | null; industry: string | null; phone: string | null; email: string | null };
  primary_contact: null | { id: number; name: string; email: string | null; phone: string | null; role: string };
  history: HistoryRow[]; activities: Activity[]; quotes: Quote[]; next_task: Activity | null;
}

const LEGACY_BY_NAME: Record<string, string> = { Prospect: 'prospecting', Qualified: 'qualification', Proposal: 'proposal', Negotiation: 'negotiation', Won: 'won', Lost: 'lost' };
const legacyOf = (name: string) => LEGACY_BY_NAME[name] ?? name;
const ACT_ICON: Record<string, typeof Phone> = { call: Phone, email: Mail, meeting: Video, note: StickyNote, task: ClipboardList };

type TimelineItem =
  | { kind: 'activity'; at: string; a: Activity }
  | { kind: 'stage'; at: string; h: HistoryRow }
  | { kind: 'quote'; at: string; q: Quote }
  | { kind: 'feed'; at: string; f: FeedPost };

// CRM-8: highlight @mentions inside a feed note.
function renderBody(body: string) {
  return body.split(/(@[A-Za-z0-9_.\-]{2,40})/g).map((part, i) =>
    part.startsWith('@') ? <span key={i} className="font-medium text-primary">{part}</span> : <span key={i}>{part}</span>);
}

export default function DealClient({ oppNo, initial }: { oppNo: string; initial?: unknown }) {
  const { t } = useLang();
  const router = useRouter();
  const qc = useQueryClient();
  const dealQ = useQuery<Deal>({
    queryKey: ['crm-deal', oppNo],
    queryFn: () => api(`/api/crm/pipeline/opportunities/${encodeURIComponent(oppNo)}`),
    initialData: initial as Deal | undefined,
  });
  const stagesQ = useQuery<Stage[]>({ queryKey: ['crm-stages'], queryFn: () => api('/api/pipeline/stages') });
  const stages = useMemo(() => (stagesQ.data ?? []).slice().sort((a, b) => a.sequence - b.sequence), [stagesQ.data]);
  const d = dealQ.data;

  const refresh = () => { qc.invalidateQueries({ queryKey: ['crm-deal', oppNo] }); qc.invalidateQueries({ queryKey: ['crm-opps'] }); qc.invalidateQueries({ queryKey: ['crm-summary'] }); };

  // ── stage moves (same governed contract as the board) ──
  const [closeAsk, setCloseAsk] = useState<null | Stage>(null);
  const [closeReason, setCloseReason] = useState('');
  const move = useMutation({
    mutationFn: (v: { stage: Stage; lost_reason?: string; win_reason?: string }) =>
      api(`/api/crm/pipeline/opportunities/${encodeURIComponent(oppNo)}/stage`, { method: 'PATCH', body: JSON.stringify({ stage: v.stage.name, lost_reason: v.lost_reason, win_reason: v.win_reason }) }),
    onSuccess: () => { notifySuccess(t('crmx.toast_stage_moved')); refresh(); },
    onError: (e: Error) => notifyError(e.message),
  });
  const requestMove = (stage: Stage) => {
    if (!d || d.status !== 'Open') return;
    if (stage.isWon || stage.isLost) { setCloseReason(''); setCloseAsk(stage); return; }
    move.mutate({ stage });
  };

  // ── quick-add activity ──
  const [af, setAf] = useState({ type: 'call', subject: '', notes: '', due_date: '' });
  const addActivity = useMutation({
    mutationFn: () => api('/api/crm/pipeline/activities', {
      method: 'POST',
      body: JSON.stringify({ entity_type: 'opportunity', entity_no: oppNo, type: af.type, subject: af.subject || undefined, notes: af.notes || undefined, due_date: af.type === 'task' && af.due_date ? af.due_date : undefined }),
    }),
    onSuccess: () => { notifySuccess(t('crmx.toast_activity_added')); setAf({ type: 'call', subject: '', notes: '', due_date: '' }); refresh(); },
    onError: (e: Error) => notifyError(e.message),
  });
  const toggleDone = useMutation({
    mutationFn: (v: { id: number; done: boolean }) => api(`/api/crm/pipeline/activities/${v.id}/done`, { method: 'PATCH', body: JSON.stringify({ done: v.done }) }),
    onSuccess: () => refresh(),
    onError: (e: Error) => notifyError(e.message),
  });

  // ── CRM-8 collaboration feed: append-only internal notes with @mentions (surface in the timeline) ──
  const feedQ = useQuery<{ posts: FeedPost[] }>({ queryKey: ['crm-feed', oppNo], queryFn: () => api(`/api/crm/feed?entity_type=opportunity&entity_no=${encodeURIComponent(oppNo)}`) });
  const [feedBody, setFeedBody] = useState('');
  const postNote = useMutation({
    mutationFn: () => api('/api/crm/feed', { method: 'POST', body: JSON.stringify({ entity_type: 'opportunity', entity_no: oppNo, body: feedBody.trim() }) }),
    onSuccess: () => { notifySuccess(t('crmx.feed_posted')); setFeedBody(''); qc.invalidateQueries({ queryKey: ['crm-feed', oppNo] }); },
    onError: (e: Error) => notifyError(e.message),
  });

  // ── won deal → project (CRM-WL, ported from /projects/crm) ──
  const [convOpen, setConvOpen] = useState(false);
  const [pf, setPf] = useState({ project_code: '', billing_type: 'Fixed', budget_amount: '', start_date: '', end_date: '' });
  const toProject = useMutation({
    mutationFn: () => api<{ project_code: string; already?: boolean }>(`/api/projects/from-opportunity/${encodeURIComponent(oppNo)}`, {
      method: 'POST',
      body: JSON.stringify({ project_code: pf.project_code || undefined, billing_type: pf.billing_type, budget_amount: Number(pf.budget_amount) || undefined, start_date: pf.start_date || undefined, end_date: pf.end_date || undefined }),
    }),
    onSuccess: (r) => { notifySuccess(t('crmx.toast_project_created', { code: r.project_code })); setConvOpen(false); router.push(`/projects/${encodeURIComponent(r.project_code)}`); },
    onError: (e: Error) => notifyError(e.message),
  });

  // ── unified timeline: activities + stage transitions + quotes, newest first ──
  const timeline = useMemo<TimelineItem[]>(() => {
    if (!d) return [];
    const items: TimelineItem[] = [
      ...d.activities.map((a): TimelineItem => ({ kind: 'activity', at: a.created_at, a })),
      ...d.history.map((h): TimelineItem => ({ kind: 'stage', at: h.changed_at, h })),
      ...d.quotes.map((q): TimelineItem => ({ kind: 'quote', at: q.created_at, q })),
      ...(feedQ.data?.posts ?? []).map((f): TimelineItem => ({ kind: 'feed', at: f.created_at, f })),
    ];
    return items.sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());
  }, [d, feedQ.data]);

  const currentIdx = d ? stages.findIndex((s) => (d.stage_id != null && s.id != null) ? s.id === d.stage_id : legacyOf(s.name) === d.stage) : -1;
  const openStages = stages.filter((s) => !s.isWon && !s.isLost);

  return (
    <div>
      <PageHeader
        title={d ? d.name : oppNo}
        description={d ? `${d.opp_no}${d.owner ? ` · ${t('crmx.col_owner')}: ${d.owner}` : ''}` : ''}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild><Link href="/crm"><ArrowLeft className="size-4" /> {t('crmx.btn_back_board')}</Link></Button>
            {d?.status === 'Won' && (
              <Button onClick={() => { setPf({ project_code: '', billing_type: 'Fixed', budget_amount: '', start_date: '', end_date: '' }); setConvOpen(true); }}>
                <FolderPlus className="size-4" /> {t('crmx.btn_to_project')}
              </Button>
            )}
          </div>
        }
      />
      <StateView q={dealQ}>
        {d && (
          <div className="grid gap-5">
            {/* header card: amount, status, stage stepper, links */}
            <Card className="gap-4 p-5">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <div>
                  <div className="text-xs text-muted-foreground">{t('crmx.f_amount')}</div>
                  <div className="text-2xl font-semibold tabular">{baht(d.amount)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">{t('crmx.col_prob')}</div>
                  <div className="text-lg font-medium tabular">{d.probability}%</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">{t('fin.col_status')}</div>
                  <Badge variant={statusVariant(d.status)}>{d.status}</Badge>
                </div>
                {d.expected_close_date && (
                  <div>
                    <div className="text-xs text-muted-foreground">{t('crmx.f_expected_close')}</div>
                    <div className="text-sm">{thaiDate(d.expected_close_date)}</div>
                  </div>
                )}
                {d.account && (
                  <div>
                    <div className="text-xs text-muted-foreground">{t('crmx.col_account')}</div>
                    <Link className="flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline" href={`/crm/accounts/${encodeURIComponent(d.account.account_no)}`}>
                      <Building2 className="size-4" /> {d.account.name}
                    </Link>
                  </div>
                )}
                {d.primary_contact && (
                  <div>
                    <div className="text-xs text-muted-foreground">{t('crmx.f_primary_contact')}</div>
                    <div className="flex items-center gap-1 text-sm"><Users2 className="size-4" /> {d.primary_contact.name}{d.primary_contact.phone ? ` · ${d.primary_contact.phone}` : ''}</div>
                  </div>
                )}
              </div>

              {/* stage stepper — click an open stage to move; won/lost via the buttons (reason dialog) */}
              <div className="flex flex-wrap items-center gap-1.5">
                {openStages.map((s, i) => {
                  const isCurrent = i === currentIdx;
                  const passed = currentIdx >= 0 && i < currentIdx && d.status === 'Open';
                  return (
                    <button
                      key={s.name}
                      type="button"
                      disabled={d.status !== 'Open' || move.isPending}
                      onClick={() => requestMove(s)}
                      title={t('crmx.tip_move_stage', { stage: s.name })}
                      className={`rounded-full border px-3 py-1 text-xs transition ${isCurrent ? 'border-primary bg-primary text-primary-foreground' : passed ? 'border-primary/40 bg-primary/10 text-primary' : 'bg-background text-muted-foreground hover:border-primary/50'} ${d.status !== 'Open' ? 'cursor-default opacity-70' : ''}`}
                    >
                      {i + 1}. {s.name}
                    </button>
                  );
                })}
                {d.status === 'Open' ? (
                  <span className="ms-2 flex gap-1.5">
                    {stages.filter((s) => s.isWon).map((s) => <Button key={s.name} size="sm" variant="outline" className="border-success text-success" onClick={() => requestMove(s)}><Flag className="size-4" /> {t('crmx.btn_mark_won')}</Button>)}
                    {stages.filter((s) => s.isLost).map((s) => <Button key={s.name} size="sm" variant="outline" className="border-destructive text-destructive" onClick={() => requestMove(s)}><Flag className="size-4" /> {t('crmx.btn_mark_lost')}</Button>)}
                  </span>
                ) : (
                  <Badge className="ms-2" variant={statusVariant(d.status)}>
                    {d.status === 'Lost' && d.lost_reason ? `${d.status} — ${d.lost_reason}` : d.status === 'Won' && d.win_reason ? `${d.status} — ${d.win_reason}` : d.status}
                  </Badge>
                )}
              </div>

              {/* next-step highlight */}
              {d.next_task && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-info/40 bg-info/10 px-3 py-2 text-sm">
                  <CalendarClock className="size-4 text-info" />
                  <span className="font-medium">{t('crmx.next_step')}:</span>
                  <span>{d.next_task.subject ?? d.next_task.notes ?? '—'}</span>
                  {d.next_task.due_date && <Badge variant="info">{thaiDate(d.next_task.due_date)}</Badge>}
                  <Button size="sm" variant="ghost" className="ms-auto" disabled={toggleDone.isPending} onClick={() => toggleDone.mutate({ id: d.next_task!.id, done: true })}>
                    <CheckCircle2 className="size-4" /> {t('crmx.btn_mark_done')}
                  </Button>
                </div>
              )}
            </Card>

            <div className="grid gap-5 lg:grid-cols-3">
              {/* timeline (2/3) */}
              <div className="lg:col-span-2">
                <Card className="gap-3 p-5">
                  <h3 className="flex items-center gap-2 text-base font-semibold"><History className="size-4" /> {t('crmx.timeline_title')}</h3>

                  {/* quick add */}
                  <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-[auto_1fr_auto]">
                    <Select className="w-auto" aria-label={t('crmx.f_activity_type')} value={af.type} onChange={(e) => setAf({ ...af, type: e.target.value })}>
                      {['call', 'email', 'meeting', 'note', 'task'].map((x) => <option key={x} value={x}>{t(`crmx.act_${x}`)}</option>)}
                    </Select>
                    <Input aria-label={t('crmx.f_activity_subject')} placeholder={t('crmx.ph_activity_subject')} value={af.subject} onChange={(e) => setAf({ ...af, subject: e.target.value })} />
                    <div className="flex gap-2">
                      {af.type === 'task' && <Input aria-label={t('crmx.f_due_date')} type="date" className="w-36" value={af.due_date} onChange={(e) => setAf({ ...af, due_date: e.target.value })} />}
                      <Button disabled={!af.subject.trim() || addActivity.isPending} onClick={() => addActivity.mutate()}><Plus className="size-4" /> {t('crmx.btn_log')}</Button>
                    </div>
                  </div>

                  {/* CRM-8 collaboration feed composer — append-only internal note, @mention a teammate */}
                  <div className="grid gap-2 rounded-md border p-3">
                    <textarea
                      aria-label={t('crmx.feed_ph')}
                      className="min-h-16 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      placeholder={t('crmx.feed_ph')}
                      value={feedBody}
                      onChange={(e) => setFeedBody(e.target.value)}
                    />
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{t('crmx.feed_hint')}</span>
                      <Button size="sm" className="ms-auto" disabled={!feedBody.trim() || postNote.isPending} onClick={() => postNote.mutate()}><MessageSquare className="size-4" /> {t('crmx.btn_post_note')}</Button>
                    </div>
                  </div>

                  <div className="grid gap-0.5">
                    {timeline.map((item) => {
                      if (item.kind === 'stage') {
                        return (
                          <div key={`h${item.h.id}`} className="flex items-start gap-3 border-s-2 border-muted ps-3 py-2">
                            <History className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 text-sm">
                              <span className="text-muted-foreground">{item.h.from_stage ? t('crmx.tl_stage_moved', { from: item.h.from_stage, to: item.h.to_stage }) : t('crmx.tl_created', { stage: item.h.to_stage })}</span>
                              <span className="ms-2 text-xs text-muted-foreground">{item.h.changed_by ?? ''} · {thaiDate(item.h.changed_at)}</span>
                            </div>
                          </div>
                        );
                      }
                      if (item.kind === 'quote') {
                        return (
                          <div key={`q${item.q.id}`} className="flex items-start gap-3 border-s-2 border-info/50 ps-3 py-2">
                            <FileSignature className="mt-0.5 size-4 shrink-0 text-info" />
                            <div className="min-w-0 text-sm">
                              <span className="font-medium">{t('crmx.tl_quote', { no: item.q.quote_no })}</span>
                              <Badge className="ms-2" variant={statusVariant(item.q.status)}>{item.q.status}</Badge>
                              <span className="ms-2 tabular">{baht(item.q.total)}</span>
                              <span className="ms-2 text-xs text-muted-foreground">{thaiDate(item.q.created_at)}</span>
                            </div>
                          </div>
                        );
                      }
                      if (item.kind === 'feed') {
                        const f = item.f;
                        return (
                          <div key={`f${f.id}`} className="flex items-start gap-3 border-s-2 border-success/50 ps-3 py-2">
                            <MessageSquare className="mt-0.5 size-4 shrink-0 text-success" />
                            <div className="min-w-0 flex-1 text-sm">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant="success">{t('crmx.feed_note')}</Badge>
                                <span className="text-xs text-muted-foreground">{f.author ?? ''} · {thaiDate(f.created_at)}</span>
                              </div>
                              <p className="mt-0.5 whitespace-pre-wrap">{renderBody(f.body)}</p>
                            </div>
                          </div>
                        );
                      }
                      const a = item.a;
                      const Icon = ACT_ICON[a.type] ?? MessageSquare;
                      return (
                        <div key={`a${a.id}`} className="flex items-start gap-3 border-s-2 border-primary/40 ps-3 py-2">
                          <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
                          <div className="min-w-0 flex-1 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="secondary">{t(`crmx.act_${a.type}`)}</Badge>
                              <span className="font-medium">{a.subject ?? '—'}</span>
                              {a.due_date && <Badge variant={a.done ? 'muted' : 'warning'}>{t('crmx.due')} {thaiDate(a.due_date)}</Badge>}
                              <span className="text-xs text-muted-foreground">{a.owner ?? ''} · {thaiDate(a.created_at)}</span>
                              {a.type === 'task' && (
                                <button type="button" className="ms-auto text-muted-foreground hover:text-foreground" title={a.done ? t('crmx.btn_mark_undone') : t('crmx.btn_mark_done')} onClick={() => toggleDone.mutate({ id: a.id, done: !a.done })}>
                                  {a.done ? <CheckCircle2 className="size-4 text-success" /> : <Circle className="size-4" />}
                                </button>
                              )}
                            </div>
                            {a.notes && <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">{a.notes}</p>}
                          </div>
                        </div>
                      );
                    })}
                    {!timeline.length && <p className="py-6 text-center text-sm text-muted-foreground">{t('crmx.timeline_empty')}</p>}
                  </div>
                </Card>
              </div>

              {/* side: quotes */}
              <div className="grid gap-5 content-start">
                <Card className="gap-3 p-5">
                  <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-base font-semibold"><FileSignature className="size-4" /> {t('crmx.quotes_title')}</h3>
                    <Button size="sm" variant="outline" asChild><Link href="/cpq">{t('crmx.btn_new_quote')}</Link></Button>
                  </div>
                  {d.quotes.length ? (
                    <div className="grid gap-2">
                      {d.quotes.map((qt) => (
                        <div key={qt.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
                          <div>
                            <div className="font-medium">{qt.quote_no}</div>
                            <div className="text-xs text-muted-foreground">{qt.issued_date ? thaiDate(qt.issued_date) : thaiDate(qt.created_at)}</div>
                          </div>
                          <div className="text-end">
                            <div className="tabular font-medium">{baht(qt.total)}</div>
                            <Badge variant={statusVariant(qt.status)}>{qt.status}</Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('crmx.quotes_empty')}</p>
                  )}
                </Card>
              </div>
            </div>
          </div>
        )}
      </StateView>

      {/* won/lost reason dialog */}
      <Dialog open={!!closeAsk} onOpenChange={(o) => !o && setCloseAsk(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{closeAsk?.isLost ? t('crmx.dlg_lost_title') : t('crmx.dlg_won_title')} — {d?.name}</DialogTitle></DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="deal-close-reason">{closeAsk?.isLost ? t('crmx.f_lost_reason') : t('crmx.f_win_reason')}</Label>
            <Input id="deal-close-reason" value={closeReason} onChange={(e) => setCloseReason(e.target.value)} placeholder={closeAsk?.isLost ? t('crmx.ph_lost_reason') : t('crmx.ph_win_reason')} />
            {closeAsk?.isLost && <p className="text-xs text-muted-foreground">{t('crmx.lost_reason_required')}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloseAsk(null)}>{t('crmx.btn_cancel')}</Button>
            <Button
              variant={closeAsk?.isLost ? 'destructive' : 'default'}
              disabled={move.isPending || (!!closeAsk?.isLost && !closeReason.trim())}
              onClick={() => { if (!closeAsk) return; move.mutate({ stage: closeAsk, lost_reason: closeAsk.isLost ? closeReason.trim() : undefined, win_reason: closeAsk.isWon && closeReason.trim() ? closeReason.trim() : undefined }); setCloseAsk(null); }}
            >
              {closeAsk?.isLost ? t('crmx.btn_confirm_lost') : t('crmx.btn_confirm_won')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* won deal → project dialog (CRM-WL) */}
      <Dialog open={convOpen} onOpenChange={setConvOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('crmx.dlg_to_project')} — {d?.name}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">{t('crmx.to_project_help', { amount: baht(d?.amount ?? 0) })}</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>{t('crmx.f_project_code')}</Label><Input value={pf.project_code} onChange={(e) => setPf({ ...pf, project_code: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('crmx.f_billing_type')}</Label>
                <Select value={pf.billing_type} onChange={(e) => setPf({ ...pf, billing_type: e.target.value })}>
                  <option value="Fixed">Fixed</option><option value="TM">T&amp;M</option>
                </Select>
              </div>
              <div className="grid gap-1.5"><Label>{t('crmx.f_budget')}</Label><Input type="number" min="0" value={pf.budget_amount} onChange={(e) => setPf({ ...pf, budget_amount: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('crmx.f_start')}</Label><Input type="date" value={pf.start_date} onChange={(e) => setPf({ ...pf, start_date: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('crmx.f_end')}</Label><Input type="date" value={pf.end_date} onChange={(e) => setPf({ ...pf, end_date: e.target.value })} /></div>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setConvOpen(false)}>{t('crmx.btn_cancel')}</Button><Button onClick={() => toProject.mutate()} disabled={toProject.isPending}>{t('crmx.btn_create_project')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
