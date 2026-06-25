'use client';

import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Award, Gauge, TrendingDown, Trophy } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

// Supplier-performance register (EXP — vendor management): ranks suppliers by scorecard so procurement
// can see who is underperforming. Surfaces supplier_scorecards, which had compute + storage but no list/UI.

interface Scorecard {
  vendor_id: number; vendor_name: string | null; period: string | null;
  on_time_pct: number; quality_pct: number; price_var_pct: number; score: number; gr_count: number; claim_count: number;
}
interface Resp { scorecards: Scorecard[]; count: number; avg_score: number; underperformers: number }

const scoreTone = (s: number): 'success' | 'warning' | 'destructive' =>
  s >= 85 ? 'success' : s >= 70 ? 'warning' : 'destructive';

export default function SupplierScorecardsPage() {
  const [period, setPeriod] = useState('');

  const q = useQuery<Resp>({
    queryKey: ['supplier-scorecards', period],
    queryFn: () => api(`/api/procurement/scorecards${period ? `?period=${encodeURIComponent(period)}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;

  return (
    <ModulePage
      title="คะแนนซัพพลายเออร์ (Supplier Scorecards)"
      description="จัดอันดับผลงานผู้ขายตาม scorecard — ตรงเวลา · คุณภาพ · ส่วนต่างราคา เพื่อบริหารจัดการผู้ขาย"
      query={q}
      toolbar={
        <>
          <label className="text-sm text-muted-foreground" htmlFor="sc-period">งวด</label>
          <Input id="sc-period" className="w-40" placeholder="ทุกงวด (ล่าสุด/ราย)" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="กรองตามงวด (YYYY-MM)" />
          {period && <span className="text-xs text-muted-foreground">รูปแบบ YYYY-MM · เว้นว่าง = ล่าสุดต่อราย</span>}
          {q.isFetching && !q.isLoading && <span className="text-xs text-muted-foreground">กำลังอัปเดต…</span>}
        </>
      }
      stats={
        d && (
          <>
            <StatCard label="ซัพพลายเออร์ (มี scorecard)" value={num(d.count)} icon={Award} tone="primary" />
            <StatCard label="คะแนนเฉลี่ย" value={num(d.avg_score)} icon={Gauge} tone={d.avg_score >= 85 ? 'success' : d.avg_score >= 70 ? 'warning' : 'danger'} hint="เต็ม 100" />
            <StatCard label="ต่ำกว่าเกณฑ์ (< 70)" value={num(d.underperformers)} icon={TrendingDown} tone={d.underperformers > 0 ? 'danger' : 'success'} hint="ควรทบทวน/ตรวจสอบ" />
          </>
        )
      }
      statsClassName="xl:grid-cols-3"
    >
      {d && (
        <DataTable
          rows={d.scorecards.map((s, i) => ({ ...s, rank: i + 1 }))}
          rowKey={(r) => `${r.vendor_id}-${r.period}`}
          emptyState={{ icon: Award, title: 'ยังไม่มีคะแนนซัพพลายเออร์', description: 'คำนวณ scorecard จากหน้าจัดซื้อ (suppliers/:id/scorecard) แล้วผลจะแสดงและจัดอันดับที่นี่' }}
          columns={[
            { key: 'rank', label: 'อันดับ', render: (r) => <span className="tabular text-muted-foreground">{r.rank === 1 ? <Trophy className="inline size-4 text-warning-foreground dark:text-warning" /> : `#${r.rank}`}</span> },
            { key: 'vendor_name', label: 'ซัพพลายเออร์', render: (r) => <span className="font-medium">{r.vendor_name ?? `#${r.vendor_id}`}</span> },
            { key: 'score', label: 'คะแนน', align: 'right', render: (r) => <Badge variant={scoreTone(r.score)}>{num(r.score)}</Badge> },
            { key: 'on_time_pct', label: 'ตรงเวลา %', align: 'right', render: (r) => <span className="tabular">{num(r.on_time_pct)}%</span> },
            { key: 'quality_pct', label: 'คุณภาพ %', align: 'right', render: (r) => <span className="tabular">{num(r.quality_pct)}%</span> },
            { key: 'price_var_pct', label: 'ส่วนต่างราคา %', align: 'right', render: (r) => <span className={cn('tabular', r.price_var_pct > 0 && 'text-destructive')}>{num(r.price_var_pct)}%</span> },
            { key: 'gr_count', label: 'รับของ', align: 'right', render: (r) => <span className="tabular">{num(r.gr_count)}</span> },
            { key: 'claim_count', label: 'เคลม', align: 'right', render: (r) => <span className={cn('tabular', r.claim_count > 0 && 'font-medium text-destructive')}>{num(r.claim_count)}</span> },
            { key: 'period', label: 'งวด', render: (r) => r.period ?? '—' },
          ]}
        />
      )}
    </ModulePage>
  );
}
