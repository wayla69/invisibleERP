'use client';

import { useQuery } from '@tanstack/react-query';
import { HeartPulse, Wallet, TrendingUp, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { StatCard } from '@/components/stat-card';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const GRADE_TONE: Record<string, 'success' | 'info' | 'warning' | 'danger'> = { A: 'success', B: 'success', C: 'info', D: 'warning', E: 'danger' };

export default function FinancialHealthPage() {
  const q = useQuery<any>({ queryKey: ['financial-health'], queryFn: () => api('/api/finance/health') });

  return (
    <div>
      <PageHeader
        title="สุขภาพการเงิน (Financial health)"
        description="คะแนนเงินทุนหมุนเวียน 0–100 (เกรด A–E) จากเงินสด เทียบลูกหนี้/เจ้าหนี้ หนี้ค้างชำระ และยอดขาย — ดูพยากรณ์กระแสเงินสดรายสัปดาห์ได้ที่งบกระแสเงินสด"
      />
      <StateView q={q}>
        {q.data && (
          <>
            <div className="mb-4 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
              <StatCard
                label="คะแนนสุขภาพการเงิน"
                value={`${q.data.score}/100 · ${q.data.grade}`}
                icon={HeartPulse}
                tone={GRADE_TONE[q.data.grade] ?? 'info'}
                hint={`เงินสดอยู่ได้ ~${q.data.days_cash_on_hand ?? '∞'} วัน · current ratio ${q.data.current_ratio ?? '—'}`}
              />
              <StatCard label="เงินสดคงเหลือ" value={baht(q.data.cash_on_hand)} icon={Wallet} />
              <StatCard label="ลูกหนี้คงค้าง" value={baht(q.data.ar_outstanding)} hint={`ค้างชำระ ${q.data.overdue_ar_pct}% (${baht(q.data.overdue_ar)})`} tone={q.data.overdue_ar_pct > 20 ? 'warning' : 'default'} />
              <StatCard label="เจ้าหนี้คงค้าง" value={baht(q.data.ap_outstanding)} icon={AlertTriangle} />
              <StatCard label="ยอดขาย/วัน (run-rate)" value={baht(q.data.pos_daily_run_rate)} icon={TrendingUp} tone="info" />
            </div>

            <Card className="gap-3 p-4">
              <h3 className="text-sm font-semibold text-muted-foreground">ปัจจัยที่ใช้คำนวณคะแนน (drivers)</h3>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
                <Driver label="สภาพคล่อง (Liquidity)" score={q.data.drivers.liquidity} hint={`${q.data.days_cash_on_hand ?? '∞'} วันของเงินสด · เต็ม 100 ที่ ≥60 วัน`} />
                <Driver label="ลูกหนี้ (Receivables)" score={q.data.drivers.receivables} hint={`หักตามสัดส่วนหนี้ค้างชำระ (${q.data.overdue_ar_pct}%)`} />
              </div>
              <p className="text-xs text-muted-foreground">คะแนนรวม = สภาพคล่อง×0.6 + ลูกหนี้×0.4 · อ่านอย่างเดียว ไม่กระทบบัญชี</p>
            </Card>
          </>
        )}
      </StateView>
    </div>
  );
}

function Driver({ label, score, hint }: { label: string; score: number; hint: string }) {
  const tone = score >= 70 ? 'bg-success' : score >= 45 ? 'bg-warning' : 'bg-destructive';
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Badge variant="muted">{score}/100</Badge>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
