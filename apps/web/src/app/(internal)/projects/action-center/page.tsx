'use client';

import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, BellRing, CircleAlert, Inbox, Wifi, WifiOff } from 'lucide-react';
import { api } from '@/lib/api';
import { useRealtime } from '@/hooks/use-realtime';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

// Severity → tone for the badge + the left accent rail. high = act now, medium = approvals/schedule, low = hygiene.
const sevBadge: Record<string, 'destructive' | 'warning' | 'muted'> = { high: 'destructive', medium: 'warning', low: 'muted' };
const sevRail: Record<string, string> = { high: 'border-l-destructive', medium: 'border-l-warning', low: 'border-l-muted-foreground/40' };
const sevLabel: Record<string, string> = { high: 'ด่วน (High)', medium: 'ปานกลาง (Medium)', low: 'ทั่วไป (Low)' };

interface ActionItem {
  kind: string; severity: 'high' | 'medium' | 'low';
  project_code: string | null; title_th: string; title_en: string; href: string; ref: string | null;
}

export default function ActionCenterPage() {
  const router = useRouter();
  const q = useQuery<any>({ queryKey: ['projects', 'action-center'], queryFn: () => api('/api/projects/action-center') });
  // Proactive: a project_action event (project went red / unmitigated-high risk logged) re-pulls the worklist
  // the instant it happens, rather than waiting for the next manual refresh.
  const { connected } = useRealtime((e) => { if (e.type === 'project_action') void q.refetch(); }, { path: '/api/bi/live/stream' });

  const d = q.data;
  const items: ActionItem[] = d?.items ?? [];
  const groups: Array<['high' | 'medium' | 'low', ActionItem[]]> = (['high', 'medium', 'low'] as const)
    .map((s) => [s, items.filter((i) => i.severity === s)] as ['high' | 'medium' | 'low', ActionItem[]])
    .filter(([, xs]) => xs.length > 0);

  return (
    <div>
      <PageHeader
        title="ศูนย์งานที่ต้องทำ (Action Center)"
        description="รายการเดียวจบ — สิ่งที่ต้องอนุมัติ ตัดสินใจ หรือแก้ไขทั่วทั้งพอร์ตโครงการ จัดเรียงตามความเร่งด่วน"
        actions={
          <Badge variant={connected ? 'success' : 'muted'} className="gap-1">
            {connected ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
            {connected ? 'เรียลไทม์' : 'ออฟไลน์'}
          </Badge>
        }
      />

      <StateView q={q}>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="ทั้งหมด (Total)" value={d?.summary?.total ?? 0} icon={Inbox} tone="default" />
            <StatCard label="ด่วน (High)" value={d?.summary?.high ?? 0} icon={AlertTriangle} tone={(d?.summary?.high ?? 0) > 0 ? 'danger' : 'success'} hint="ต้องลงมือทันที" />
            <StatCard label="ปานกลาง (Medium)" value={d?.summary?.medium ?? 0} icon={CircleAlert} tone={(d?.summary?.medium ?? 0) > 0 ? 'warning' : 'default'} hint="รออนุมัติ / กำหนดการ" />
            <StatCard label="ทั่วไป (Low)" value={d?.summary?.low ?? 0} icon={BellRing} tone="default" hint="สุขภาพ / ธรรมาภิบาล" />
          </div>

          {items.length === 0 ? (
            <Card className="flex flex-col items-center gap-2 p-10 text-center">
              <Inbox className="size-8 text-muted-foreground" />
              <p className="text-base font-medium">ไม่มีงานค้าง</p>
              <p className="text-sm text-muted-foreground">ทุกโครงการอยู่ในเกณฑ์ — ไม่มีรายการที่ต้องดำเนินการ</p>
            </Card>
          ) : (
            groups.map(([sev, xs]) => (
              <div key={sev} className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge variant={sevBadge[sev]}>{sevLabel[sev]}</Badge>
                  <span className="text-sm text-muted-foreground">{xs.length} รายการ</span>
                </div>
                <div className="space-y-2">
                  {xs.map((it, i) => (
                    <Card
                      key={`${it.kind}-${it.project_code}-${i}`}
                      className={`flex items-center justify-between gap-3 border-l-4 p-3.5 ${sevRail[sev]}`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{it.title_th}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {it.project_code ? <span className="tabular font-mono">{it.project_code}</span> : '—'} · {it.title_en}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" className="shrink-0" onClick={() => router.push(it.href)}>
                        เปิด <ArrowRight className="size-4" />
                      </Button>
                    </Card>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </StateView>
    </div>
  );
}
