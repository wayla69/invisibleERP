'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { BarChart3, Users, AlertTriangle, Coins, Ticket, TrendingDown } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Overview {
  members: { total: number; active: number; opted_in: number; at_risk: number };
  tier_mix: Record<string, number>;
  points: { open_balance: number; lifetime: number; earned: number; adjusted: number; redeemed: number; expired: number };
  redemption: { rewards_issued: number; rewards_used: number; coupons_issued: number; coupons_used: number; redemption_rate_pct: number };
  liability: { open_points: number; baht_per_point: number; fair_value: number; posted_2250: number };
  breakage_rate_pct: number; churn_rate_pct: number; active_rate_pct: number;
}
interface Churn { at_risk: { id: number; member_code: string; name: string; tier: string; balance: number; last_activity: string }[] }

function Stat({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Card className="gap-1">
      <CardContent className="pt-5">
        <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">{label}</span><span className={tone ?? 'text-muted-foreground'}>{icon}</span></div>
        <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export default function LoyaltyAnalyticsPage() {
  const ov = useQuery<Overview>({ queryKey: ['loy-analytics'], queryFn: () => api('/api/loyalty/analytics') });
  const churn = useQuery<Churn>({ queryKey: ['loy-churn'], queryFn: () => api('/api/loyalty/analytics/churn?limit=20') });
  const maxTier = ov.data ? Math.max(1, ...Object.values(ov.data.tier_mix)) : 1;

  return (
    <div>
      <PageHeader title="วิเคราะห์ลอยัลตี้ (Loyalty Analytics)" description="หนี้สินแต้ม · กรวยการแลก · อัตราการหมดอายุ (breakage) · สัดส่วนระดับสมาชิก · ความเสี่ยงลูกค้าหาย (churn)"
        actions={<Link href="/loyalty/members"><Button variant="outline"><Users className="size-4" /> สมาชิก</Button></Link>} />
      <StateView q={ov}>
        {ov.data && (
          <div className="space-y-6">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat icon={<Users className="size-4" />} label="สมาชิกทั้งหมด" value={num(ov.data.members.total)} sub={`ใช้งาน ${num(ov.data.members.active)} · รับข่าวสาร ${num(ov.data.members.opted_in)}`} />
              <Stat icon={<Coins className="size-4" />} label="หนี้สินแต้ม (มูลค่ายุติธรรม)" value={baht(ov.data.liability.fair_value)} sub={`${num(ov.data.liability.open_points)} แต้ม × ฿${ov.data.liability.baht_per_point} · ลง GL 2250 ฿${num(ov.data.liability.posted_2250)}`} tone="text-primary" />
              <Stat icon={<Ticket className="size-4" />} label="อัตราการแลก" value={`${ov.data.redemption.redemption_rate_pct}%`} sub={`ใช้ ${num(ov.data.redemption.rewards_used + ov.data.redemption.coupons_used)} / ออก ${num(ov.data.redemption.rewards_issued + ov.data.redemption.coupons_issued)}`} tone="text-success" />
              <Stat icon={<TrendingDown className="size-4" />} label="อัตราหมดอายุ (breakage)" value={`${ov.data.breakage_rate_pct}%`} sub={`หมดอายุ ${num(ov.data.points.expired)} แต้ม`} tone="text-warning" />
              <Stat icon={<AlertTriangle className="size-4" />} label="เสี่ยงหาย (churn)" value={`${ov.data.churn_rate_pct}%`} sub={`${num(ov.data.members.at_risk)} คนเงียบ ≥90 วัน (ยังมีแต้ม)`} tone="text-destructive" />
              <Stat icon={<BarChart3 className="size-4" />} label="อัตราสมาชิกใช้งาน" value={`${ov.data.active_rate_pct}%`} />
              <Stat icon={<Coins className="size-4" />} label="แต้มสะสมรวม" value={num(ov.data.points.open_balance)} sub={`ได้ ${num(ov.data.points.earned)} · แลก ${num(ov.data.points.redeemed)} · ปรับ ${num(ov.data.points.adjusted)}`} />
            </div>

            <Card className="gap-3">
              <CardHeader className="pb-0"><CardTitle className="text-base">สัดส่วนระดับสมาชิก (Tier mix)</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {Object.entries(ov.data.tier_mix).sort((a, b) => b[1] - a[1]).map(([tier, c]) => (
                  <div key={tier} className="flex items-center gap-3">
                    <span className="w-20 shrink-0 text-sm">{tier}</span>
                    <div className="h-3 flex-1 rounded-full bg-muted"><div className="h-3 rounded-full bg-primary" style={{ width: `${(c / maxTier) * 100}%` }} /></div>
                    <span className="w-12 shrink-0 text-right text-sm tabular-nums">{num(c)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="gap-3">
              <CardHeader className="pb-0"><CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="size-4 text-destructive" /> ลูกค้าเสี่ยงหาย — เป้าหมาย win-back</CardTitle></CardHeader>
              <CardContent>
                <StateView q={churn}>
                  {churn.data && (churn.data.at_risk.length === 0 ? <p className="py-2 text-center text-sm text-muted-foreground">ไม่มีสมาชิกเสี่ยงหาย 🎉</p> : (
                    <div className="space-y-1">
                      {churn.data.at_risk.map((m) => (
                        <Link key={m.id} href={`/loyalty/members/${m.id}`} className="flex items-center justify-between rounded-lg border border-border/60 p-2 hover:bg-muted/50">
                          <span className="text-sm"><span className="font-medium">{m.name ?? m.member_code}</span> <Badge variant="muted" className="ml-1">{m.tier}</Badge></span>
                          <span className="text-sm tabular-nums">{num(m.balance)} แต้ม</span>
                        </Link>
                      ))}
                    </div>
                  ))}
                </StateView>
              </CardContent>
            </Card>
          </div>
        )}
      </StateView>
    </div>
  );
}
