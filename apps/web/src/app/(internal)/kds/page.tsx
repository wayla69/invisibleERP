'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChefHat, Smartphone, Utensils, Wifi, WifiOff } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { useRealtime } from '@/hooks/use-realtime';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type KdsItem = { item_id: number; order_no: string; table_label: string | null; name: string; qty: number; modifiers: { label: string }[]; notes: string | null; kds_status: string; elapsed_min: number; prep_min: number; is_buffet?: boolean; from_diner?: boolean; course?: number; guest_allergies?: string[]; guest_dietary?: string | null };
type Station = { station_id: number; station_code: string; station_name: string; items: KdsItem[] };

const NEXT: Record<string, { action: string; label: string }> = {
  queued: { action: 'start', label: 'mx.kds_start' },
  preparing: { action: 'ready', label: 'mx.kds_ready' },
  ready: { action: 'serve', label: 'mx.kds_serve' },
};

// Urgency by elapsed vs prep time → semantic token classes (high contrast for kitchen).
type Urgency = { border: string; text: string };
const URGENCY = {
  ok: { border: 'border-success', text: 'text-success' },
  warn: { border: 'border-warning', text: 'text-warning-foreground dark:text-warning' },
  late: { border: 'border-destructive', text: 'text-destructive' },
} satisfies Record<string, Urgency>;

export default function KdsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  // Live via SSE: another terminal advancing an item refreshes this screen instantly. Polling stays as a
  // 15s fallback for when the stream is down (vs 3s before — the realtime push carries the load now).
  const { connected } = useRealtime((e) => { if (e.type === 'kds_item') qc.invalidateQueries({ queryKey: ['kds'] }); });
  const feed = useQuery<{ stations: Station[] }>({ queryKey: ['kds'], queryFn: () => api('/api/restaurant/kds/feed'), refetchInterval: connected ? 15000 : 3000 });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: number; action: string }) => api(`/api/restaurant/kds/items/${id}`, { method: 'PATCH', body: JSON.stringify({ action }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kds'] }),
  });

  const urgency = (el: number, prep: number): Urgency => (el < prep ? URGENCY.ok : el < prep * 1.5 ? URGENCY.warn : URGENCY.late);

  return (
    <div>
      <PageHeader
        title={t('mx.kds_title')}
        description={t('mx.kds_desc')}
        actions={
          <Badge variant={connected ? 'success' : 'muted'} className="gap-1">
            {connected ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />} {connected ? t('mx.kds_realtime') : t('mx.kds_connecting')}
          </Badge>
        }
      />
      <StateView q={feed}>
        {feed.data && (
          <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
            {feed.data.stations.length === 0 && <p className="text-sm text-muted-foreground">{t('mx.kds_no_orders')}</p>}
            {feed.data.stations.map((st) => (
              <Card key={st.station_id} className="gap-3 p-3">
                <h3 className="flex items-center gap-2 text-base font-bold text-foreground">
                  <ChefHat className="size-5 text-primary" />
                  {st.station_name}
                  <span className="text-sm font-normal text-muted-foreground">({st.items.length})</span>
                </h3>
                <div className="grid gap-2">
                  {st.items.map((it) => {
                    const nxt = NEXT[it.kds_status];
                    const u = urgency(it.elapsed_min, it.prep_min);
                    return (
                      <div key={it.item_id} className={cn('rounded-lg border-2 bg-card p-2', u.border)}>
                        <div className="flex items-baseline justify-between gap-2">
                          <strong className="text-base">{it.qty}× {it.name}</strong>
                          <span className={cn('text-base font-bold tabular', u.text)}>{it.elapsed_min}′</span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs text-muted-foreground">{it.table_label ? t('mx.kds_table', { label: it.table_label }) : t('mx.kds_takeaway')} · {it.order_no}</div>
                          <div className="flex gap-1">
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
                        {/* consent-gated guest dining cautions (computed live — never stored on the ticket) */}
                        {((it.guest_allergies?.length ?? 0) > 0 || it.guest_dietary) && (
                          <div className="mt-0.5 text-xs font-bold text-destructive">
                            ⚠️ {(it.guest_allergies?.length ?? 0) > 0 ? `${t('px.gp_allergies')}: ${(it.guest_allergies ?? []).join(', ')}` : ''}{(it.guest_allergies?.length ?? 0) > 0 && it.guest_dietary ? ' · ' : ''}{it.guest_dietary ?? ''}
                          </div>
                        )}
                        {nxt && (
                          <Button className="mt-1.5 w-full" size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: it.item_id, action: nxt.action })}>
                            {t(nxt.label)}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                  {st.items.length === 0 && <span className="text-sm text-muted-foreground">{t('mx.kds_empty_station')}</span>}
                </div>
              </Card>
            ))}
          </div>
        )}
      </StateView>
    </div>
  );
}
