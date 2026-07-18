'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, ChefHat, ScanLine, Smartphone, Utensils, Wifi, WifiOff, Undo2, BellRing, Gauge } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useRealtime } from '@/hooks/use-realtime';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

type Sla = 'ok' | 'warn' | 'late';
type KdsItem = { item_id: number; order_no: string; table_label: string | null; table_id: number | null; name: string; qty: number; modifiers: { label: string }[]; notes: string | null; kds_status: string; fired_at?: string | null; elapsed_min: number; prep_min: number; sla?: Sla; stuck?: boolean; priority?: number; is_buffet?: boolean; from_diner?: boolean; course?: number; guest_allergies?: string[]; guest_dietary?: string | null };
type Station = { station_id: number; station_code: string; station_name: string; items: KdsItem[] };
type Feed = { stations: Station[]; stuck_count?: number; stuck_minutes?: number };
type Group = 'station' | 'table' | 'time' | 'priority';
type ExpoItem = { item_id: number; name: string; qty: number; station_name: string; course: number; ready_min: number };
type ExpoTicket = { order_id: number; order_no: string; table_label: string | null; ready_items: ExpoItem[]; ready_count: number; pending_count: number; all_ready: boolean; oldest_ready_min: number };
type LoadStation = { station_id: number; station_code: string; station_name: string; active: number; queued: number; preparing: number; ready: number; overdue: number; avg_elapsed_min: number; oldest_min: number; bumped_today: number; recalls_today: number; all_day: { name: string; qty: number }[] };

const NEXT: Record<string, { action: string; label: string }> = {
  queued: { action: 'start', label: 'mx.kds_start' },
  preparing: { action: 'ready', label: 'mx.kds_ready' },
  ready: { action: 'serve', label: 'mx.kds_serve' },
};

// Urgency by prep-time SLA → semantic token classes (high contrast for kitchen). The server computes the
// SLA state (ok/warn/late); fall back to the elapsed-vs-prep rule if an older feed omits it.
type Urgency = { border: string; text: string };
const URGENCY = {
  ok: { border: 'border-success', text: 'text-success' },
  warn: { border: 'border-warning', text: 'text-warning-foreground dark:text-warning' },
  late: { border: 'border-destructive', text: 'text-destructive' },
} satisfies Record<Sla, Urgency>;
const slaOf = (it: { sla?: Sla; elapsed_min: number; prep_min: number }): Sla =>
  it.sla ?? (it.elapsed_min < it.prep_min ? 'ok' : it.elapsed_min < it.prep_min * 1.5 ? 'warn' : 'late');

export default function KdsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [view, setView] = useState<'board' | 'expo' | 'load'>('board');
  const [group, setGroup] = useState<Group>('station');   // board grouping: station / table / time / priority
  const [scan, setScan] = useState('');
  // Live via SSE: another terminal advancing an item refreshes every view instantly. Polling stays as a
  // 15s fallback for when the stream is down (vs 3s before — the realtime push carries the load now).
  const { connected } = useRealtime((e) => {
    if (e.type === 'kds_item') qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('kds') });
  });
  const poll = connected ? 15000 : 3000;
  const feed = useQuery<Feed>({ queryKey: ['kds'], queryFn: () => api('/api/restaurant/kds/feed'), refetchInterval: poll, enabled: view === 'board' });
  const expo = useQuery<{ tickets: ExpoTicket[]; ready_orders: number }>({ queryKey: ['kds-expo'], queryFn: () => api('/api/restaurant/kds/expo'), refetchInterval: poll, enabled: view === 'expo' });
  const load = useQuery<{ stations: LoadStation[] }>({ queryKey: ['kds-load'], queryFn: () => api('/api/restaurant/kds/load'), refetchInterval: poll, enabled: view === 'load' });
  const invalidate = () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('kds') });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: number; action: string }) => api(`/api/restaurant/kds/items/${id}`, { method: 'PATCH', body: JSON.stringify({ action }) }),
    onSuccess: invalidate,
  });
  // Serve a whole ticket — scan the order QR, or tap "Serve order" on a card. Clears every ready line at once.
  const serve = useMutation({
    mutationFn: (orderNo: string) => api<{ served: number }>('/api/restaurant/kds/serve', { method: 'POST', body: JSON.stringify({ order_no: orderNo.trim() }) }),
    onSuccess: (r, orderNo) => { notifySuccess(r.served > 0 ? t('mx.kds_serve_ok', { no: orderNo.trim(), n: r.served }) : t('mx.kds_serve_none', { no: orderNo.trim() })); invalidate(); },
    onError: (e: Error) => notifyError(e.message),
  });
  // Start a whole ticket — accept every queued line of an order in one tap (queued → preparing).
  const start = useMutation({
    mutationFn: (orderNo: string) => api<{ started: number }>('/api/restaurant/kds/start', { method: 'POST', body: JSON.stringify({ order_no: orderNo.trim() }) }),
    onSuccess: invalidate,
    onError: (e: Error) => notifyError(e.message),
  });
  const onScan = () => { const c = scan.trim(); if (c) { serve.mutate(c); setScan(''); } };

  // flatten the station feed for the table/time/priority groupings
  const allItems: KdsItem[] = (feed.data?.stations ?? []).flatMap((s) => s.items);
  const stuckCount = feed.data?.stuck_count ?? 0;
  const stuckMin = feed.data?.stuck_minutes ?? 10;

  return (
    <div>
      <PageHeader
        title={t('mx.kds_title')}
        description={view === 'expo' ? t('mx.kds_expo_desc') : view === 'load' ? t('mx.kds_load_desc') : t('mx.kds_desc')}
        actions={
          <Badge variant={connected ? 'success' : 'muted'} className="gap-1">
            {connected ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />} {connected ? t('mx.kds_realtime') : t('mx.kds_connecting')}
          </Badge>
        }
      />

      <Tabs value={view} onValueChange={(v) => setView(v as typeof view)} className="mb-4">
        <TabsList>
          <TabsTrigger value="board"><ChefHat className="size-4" /> {t('mx.kds_view_board')}</TabsTrigger>
          <TabsTrigger value="expo"><BellRing className="size-4" /> {t('mx.kds_view_expo')}</TabsTrigger>
          <TabsTrigger value="load"><Gauge className="size-4" /> {t('mx.kds_view_load')}</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* ── Board: active kitchen lines, aging by SLA colour, grouped as chosen ── */}
      {view === 'board' && (
        <>
          {/* control bar: grouping + scan-to-serve */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Tabs value={group} onValueChange={(v) => setGroup(v as Group)}>
              <TabsList>
                <TabsTrigger value="station"><ChefHat className="size-4" /> {t('mx.kds_group_station')}</TabsTrigger>
                <TabsTrigger value="table"><Utensils className="size-4" /> {t('mx.kds_group_table')}</TabsTrigger>
                <TabsTrigger value="time"><AlarmClock className="size-4" /> {t('mx.kds_group_time')}</TabsTrigger>
                <TabsTrigger value="priority"><BellRing className="size-4" /> {t('mx.kds_group_priority')}</TabsTrigger>
              </TabsList>
            </Tabs>
            <form className="ml-auto flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); onScan(); }}>
              <div className="relative">
                <ScanLine className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={scan} onChange={(e) => setScan(e.target.value)} placeholder={t('mx.kds_scan_ph')} className="w-44 pl-8" aria-label={t('mx.kds_scan_ph')} />
              </div>
              <Button type="submit" variant="outline" size="sm" disabled={!scan.trim() || serve.isPending}>{t('mx.kds_scan_serve')}</Button>
            </form>
          </div>

          {/* hard "stuck" alarm: lines hung past the threshold need a human */}
          {stuckCount > 0 && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border-2 border-destructive bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive">
              <AlarmClock className="size-4 animate-pulse" /> {t('mx.kds_stuck_banner', { count: stuckCount, min: stuckMin })}
            </div>
          )}

          <StateView q={feed}>
            {feed.data && (allItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('mx.kds_no_orders')}</p>
            ) : group === 'station' ? (
              <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
                {feed.data.stations.map((st) => (
                  <Card key={st.station_id} className="gap-3 p-3">
                    <h3 className="flex items-center gap-2 text-base font-bold text-foreground">
                      <ChefHat className="size-5 text-primary" /> {st.station_name}
                      <span className="text-sm font-normal text-muted-foreground">({st.items.length})</span>
                    </h3>
                    <div className="grid gap-2">
                      {st.items.map((it) => <ItemCard key={it.item_id} it={it} t={t} act={act} />)}
                      {st.items.length === 0 && <span className="text-sm text-muted-foreground">{t('mx.kds_empty_station')}</span>}
                    </div>
                  </Card>
                ))}
              </div>
            ) : group === 'table' ? (
              <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
                {groupByTable(allItems).map(([label, items]) => (
                  <Card key={label} className="gap-3 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="flex items-center gap-2 text-base font-bold text-foreground">
                        <Utensils className="size-5 text-primary" /> {label === '__ta' ? t('mx.kds_takeaway') : t('mx.kds_table', { label })}
                        <span className="text-sm font-normal text-muted-foreground">({items.length})</span>
                      </h3>
                      <div className="flex shrink-0 flex-col gap-1">
                        <Button variant="outline" size="sm" disabled={start.isPending || !items.some((i) => i.kds_status === 'queued')} onClick={() => start.mutate(items[0].order_no)}>{t('mx.kds_start_ticket')}</Button>
                        <Button variant="outline" size="sm" disabled={serve.isPending || !items.some((i) => i.kds_status === 'ready')} onClick={() => serve.mutate(items[0].order_no)}>{t('mx.kds_serve_ticket')}</Button>
                      </div>
                    </div>
                    <div className="grid gap-2">{items.map((it) => <ItemCard key={it.item_id} it={it} t={t} act={act} />)}</div>
                  </Card>
                ))}
              </div>
            ) : (
              // time (oldest lot first) or priority (highest first) — one flat, wrapping grid
              <div className="grid items-start gap-2 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
                {[...allItems].sort(group === 'time' ? byTime : byPriority).map((it) => <ItemCard key={it.item_id} it={it} t={t} act={act} />)}
              </div>
            ))}
          </StateView>
        </>
      )}

      {/* ── Expo / order-ready pass: ready lines aggregated by order, ready-to-run first ── */}
      {view === 'expo' && (
        <StateView q={expo}>
          {expo.data && (
            <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
              {expo.data.tickets.length === 0 && <p className="text-sm text-muted-foreground">{t('mx.kds_expo_none')}</p>}
              {expo.data.tickets.map((tk) => (
                <Card key={tk.order_id} className={cn('gap-2 p-3', tk.all_ready ? 'border-2 border-success' : 'border-warning')}>
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="text-base font-bold">{tk.table_label ? t('mx.kds_table', { label: tk.table_label }) : t('mx.kds_takeaway')}</h3>
                    <span className="text-xs text-muted-foreground tabular">{tk.order_no}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={tk.all_ready ? 'success' : 'warning'} className="gap-1 text-[11px]">
                      <BellRing className="size-3" /> {tk.all_ready ? t('mx.kds_expo_all_ready') : t('mx.kds_expo_ready_count', { count: tk.ready_count })}
                    </Badge>
                    {!tk.all_ready && <Badge variant="outline" className="text-[11px]">{t('mx.kds_expo_left', { count: tk.pending_count })}</Badge>}
                    <span className="text-xs text-muted-foreground">{t('mx.kds_wait_min', { min: tk.oldest_ready_min })}</span>
                  </div>
                  <ul className="grid gap-1">
                    {tk.ready_items.map((it) => (
                      <li key={it.item_id} className="flex items-baseline justify-between gap-2 rounded-md bg-muted/50 px-2 py-1 text-sm">
                        <span className="font-medium">{it.qty}× {it.name}</span>
                        <span className="text-xs text-muted-foreground">{it.station_name}</span>
                      </li>
                    ))}
                  </ul>
                  {/* scan or tap to clear the whole ticket off the pass */}
                  <Button size="sm" variant={tk.all_ready ? 'default' : 'outline'} disabled={serve.isPending} onClick={() => serve.mutate(tk.order_no)}>
                    {t('mx.kds_serve_ticket')}
                  </Button>
                </Card>
              ))}
            </div>
          )}
        </StateView>
      )}

      {/* ── Station load: WIP per station + all-day bump/recall counts (card list + table) ── */}
      {view === 'load' && (
        <StateView q={load}>
          {load.data && (load.data.stations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('mx.kds_load_none')}</p>
          ) : (
            <>
              <div className="space-y-3 sm:hidden">
                {load.data.stations.map((s) => (
                  <Card key={s.station_id} className="gap-2 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="flex items-center gap-2 text-base font-bold"><ChefHat className="size-4 text-primary" /> {s.station_name}</h3>
                      <Badge variant={s.overdue > 0 ? 'destructive' : s.active > 0 ? 'warning' : 'muted'}>{t('mx.kds_col_active')} {s.active}</Badge>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                      <div className="flex justify-between"><dt className="text-muted-foreground">{t('mx.kds_col_overdue')}</dt><dd className={cn('tabular font-medium', s.overdue > 0 && 'text-destructive')}>{s.overdue}</dd></div>
                      <div className="flex justify-between"><dt className="text-muted-foreground">{t('mx.kds_col_oldest')}</dt><dd className="tabular font-medium">{s.oldest_min}′</dd></div>
                      <div className="flex justify-between"><dt className="text-muted-foreground">{t('mx.kds_col_avg')}</dt><dd className="tabular font-medium">{s.avg_elapsed_min}′</dd></div>
                      <div className="flex justify-between"><dt className="text-muted-foreground">{t('mx.kds_col_bumped')}</dt><dd className="tabular font-medium text-success">{s.bumped_today}</dd></div>
                      <div className="flex justify-between"><dt className="text-muted-foreground">{t('mx.kds_col_recalls')}</dt><dd className="tabular font-medium">{s.recalls_today}</dd></div>
                    </dl>
                    {s.all_day.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        <span className="text-xs text-muted-foreground">{t('mx.kds_allday')}:</span>
                        {s.all_day.map((a) => <Badge key={a.name} variant="secondary" className="text-[11px]">{a.qty}× {a.name}</Badge>)}
                      </div>
                    )}
                  </Card>
                ))}
              </div>
              <div className="hidden sm:block">
                <Card className="overflow-hidden p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-medium">{t('mx.kds_col_station')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('mx.kds_col_active')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('mx.kds_col_overdue')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('mx.kds_col_oldest')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('mx.kds_col_avg')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('mx.kds_col_bumped')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('mx.kds_col_recalls')}</th>
                          <th className="px-3 py-2 font-medium">{t('mx.kds_allday')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {load.data.stations.map((s) => (
                          <tr key={s.station_id} className="border-b last:border-0">
                            <td className="px-3 py-2 font-medium">{s.station_name}</td>
                            <td className="px-3 py-2 text-right tabular">{s.active}</td>
                            <td className={cn('px-3 py-2 text-right tabular', s.overdue > 0 && 'font-bold text-destructive')}>{s.overdue}</td>
                            <td className="px-3 py-2 text-right tabular">{s.oldest_min}′</td>
                            <td className="px-3 py-2 text-right tabular">{s.avg_elapsed_min}′</td>
                            <td className="px-3 py-2 text-right tabular text-success">{s.bumped_today}</td>
                            <td className="px-3 py-2 text-right tabular">{s.recalls_today}</td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap gap-1">
                                {s.all_day.map((a) => <Badge key={a.name} variant="secondary" className="text-[11px]">{a.qty}× {a.name}</Badge>)}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </div>
            </>
          ))}
        </StateView>
      )}
    </div>
  );
}

// same-lot rule: oldest fire time first; within one lot the higher food-priority plates out first.
const byTime = (a: KdsItem, b: KdsItem) => (a.fired_at ?? '').localeCompare(b.fired_at ?? '') || (b.priority ?? 0) - (a.priority ?? 0) || (a.course ?? 1) - (b.course ?? 1);
// priority-first view: highest food-priority first, then oldest fire time.
const byPriority = (a: KdsItem, b: KdsItem) => (b.priority ?? 0) - (a.priority ?? 0) || (a.fired_at ?? '').localeCompare(b.fired_at ?? '');

// group the flat feed by table (takeaway → '__ta'), tables in first-fired order, lines within by same-lot rule
function groupByTable(items: KdsItem[]): [string, KdsItem[]][] {
  const map = new Map<string, KdsItem[]>();
  for (const it of items) {
    const key = it.table_label ?? '__ta';
    (map.get(key) ?? map.set(key, []).get(key)!).push(it);
  }
  return [...map.entries()]
    .map(([k, v]) => [k, v.sort(byTime)] as [string, KdsItem[]])
    .sort((a, b) => (a[1][0]?.fired_at ?? '').localeCompare(b[1][0]?.fired_at ?? ''));
}

// one kitchen line card — SLA aging colour, stuck alarm, food-priority + course/buffet/diner badges, actions.
function ItemCard({ it, t, act }: { it: KdsItem; t: (k: string, v?: Record<string, string | number>) => string; act: { isPending: boolean; mutate: (v: { id: number; action: string }) => void } }) {
  const nxt = NEXT[it.kds_status];
  const u = URGENCY[slaOf(it)];
  const canRecall = it.kds_status === 'preparing' || it.kds_status === 'ready';
  return (
    <div className={cn('rounded-lg border-2 bg-card p-2', it.stuck ? 'border-destructive ring-2 ring-destructive/40' : u.border)}>
      <div className="flex items-baseline justify-between gap-2">
        <strong className="text-base">{it.qty}× {it.name}</strong>
        <span className={cn('flex items-center gap-1 text-base font-bold tabular', it.stuck ? 'text-destructive' : u.text)}>
          {it.stuck && <AlarmClock className="size-4 animate-pulse" />}{it.elapsed_min}′
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">{it.table_label ? t('mx.kds_table', { label: it.table_label }) : t('mx.kds_takeaway')} · {it.order_no}</div>
        <div className="flex flex-wrap justify-end gap-1">
          {it.kds_status === 'queued' && it.elapsed_min < 2 && <Badge variant="success" className="px-1.5 text-[10px]">{t('mx.kds_new')}</Badge>}
          {(it.priority ?? 0) > 0 && <Badge variant="warning" className="px-1.5 text-[10px]">{t('mx.kds_priority_badge', { n: it.priority ?? 0 })}</Badge>}
          {(it.course ?? 1) > 1 && <Badge variant="outline" className="px-1.5 text-[10px]">{t('mx.kds_course', { course: it.course ?? 1 })}</Badge>}
          {it.is_buffet && <Badge variant="secondary" className="gap-0.5 px-1.5 text-[10px]"><Utensils className="size-2.5" /> {t('mx.kds_buffet')}</Badge>}
          {it.from_diner && <Badge variant="outline" className="gap-0.5 px-1.5 text-[10px]"><Smartphone className="size-2.5" /> {t('mx.kds_diner_order')}</Badge>}
        </div>
      </div>
      {(it.modifiers?.length > 0 || it.notes) && (
        <div className="mt-0.5 text-xs font-medium text-warning-foreground dark:text-warning">
          {(it.modifiers ?? []).map((m) => m.label).join(', ')}{it.notes ? ` · ${it.notes}` : ''}
        </div>
      )}
      {((it.guest_allergies?.length ?? 0) > 0 || it.guest_dietary) && (
        <div className="mt-0.5 text-xs font-bold text-destructive">
          ⚠️ {(it.guest_allergies?.length ?? 0) > 0 ? `${t('px.gp_allergies')}: ${(it.guest_allergies ?? []).join(', ')}` : ''}{(it.guest_allergies?.length ?? 0) > 0 && it.guest_dietary ? ' · ' : ''}{it.guest_dietary ?? ''}
        </div>
      )}
      {(nxt || canRecall) && (
        <div className="mt-1.5 flex gap-1.5">
          {nxt && (
            <Button className="flex-1" size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: it.item_id, action: nxt.action })}>
              {t(nxt.label)}
            </Button>
          )}
          {canRecall && (
            <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: it.item_id, action: 'recall' })} aria-label={t('mx.kds_recall')} title={t('mx.kds_recall')}>
              <Undo2 className="size-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
