'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, Database, Layers } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Metrics = { uptime_s: number; node: string; cache: { provider: string; size: number; hits: number; misses: number }; scale: { cache_provider: string; queue_provider: string; note: string } };

// E5 (Phase 30) — ops / scale posture. Process metrics + cache/queue provider posture (health probes are /healthz, /readyz).
export default function OpsPage() {
  const { t } = useLang();
  const q = useQuery<Metrics>({ queryKey: ['ops-metrics'], queryFn: () => api('/api/ops/metrics'), refetchInterval: 10_000 });
  return (
    <div>
      <PageHeader title={t('st.ops.title')} description={t('st.ops.desc')} />
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 md:grid-cols-3">
            <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Activity className="size-4 text-primary" /> {t('st.ops.process')}</CardTitle></CardHeader><CardContent className="text-sm"><p>Uptime: {q.data.uptime_s}s</p><p>Node: {q.data.node}</p></CardContent></Card>
            <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Database className="size-4 text-primary" /> แคช (Cache)</CardTitle></CardHeader><CardContent className="text-sm"><p>Provider: {q.data.cache.provider}</p><p>Size {q.data.cache.size} · Hits {q.data.cache.hits} · Misses {q.data.cache.misses}</p></CardContent></Card>
            <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Layers className="size-4 text-primary" /> การขยายขนาด</CardTitle></CardHeader><CardContent className="text-sm"><p>Cache: {q.data.scale.cache_provider}</p><p>Queue: {q.data.scale.queue_provider}</p><p className="mt-2 text-xs text-muted-foreground">{q.data.scale.note}</p></CardContent></Card>
          </div>
        )}
      </StateView>
    </div>
  );
}
