'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CircleDollarSign, Package, ShieldCheck, Sparkles, Gauge } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { statusVariant } from '@/components/ui';

type Plan = { code: string; name: string; price_monthly: number; features?: any };

export default function BillingPage() {
  const qc = useQueryClient();
  const sub = useQuery<any>({ queryKey: ['subscription'], queryFn: () => api('/api/billing/subscription') });
  const plans = useQuery<{ plans: Plan[] }>({ queryKey: ['plans'], queryFn: () => api('/api/billing/plans') });
  const aiUsage = useQuery<any>({ queryKey: ['ai-usage'], queryFn: () => api('/api/billing/ai-usage') });
  const [msg, setMsg] = useState('');

  const change = useMutation({
    mutationFn: (plan_code: string) => api('/api/billing/change-plan', { method: 'POST', body: JSON.stringify({ plan_code }) }),
    onSuccess: (_d, plan_code) => { setMsg(`✅ เปลี่ยนเป็นแพ็กเกจ ${plan_code} แล้ว`); qc.invalidateQueries({ queryKey: ['subscription'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  const currentCode = sub.data?.plan_code ?? sub.data?.plan?.code;
  // Render readable plan features. Internal AI-pricing keys (ceiling/overage rate) are surfaced in the
  // dedicated AI-usage card below, not dumped as raw numbers here.
  const HIDDEN = new Set(['ai_tokens_daily_max', 'ai_overage_rate_thb_per_1k', 'custom']);
  const featureList = (f: any): string[] => {
    if (Array.isArray(f)) return f.map(String);
    if (!f || typeof f !== 'object') return [];
    const labels: string[] = [];
    for (const [k, v] of Object.entries(f)) {
      if (HIDDEN.has(k)) continue;
      if (k === 'users') labels.push(Number(v) < 0 ? 'ผู้ใช้ไม่จำกัด' : `ผู้ใช้สูงสุด ${v} คน`);
      else if (k === 'locations') labels.push(Number(v) < 0 ? 'สาขาไม่จำกัด' : `${v} สาขา`);
      else if (k === 'ai_chat') labels.push(v ? 'ผู้ช่วย AI ในตัว' : 'ไม่รวมผู้ช่วย AI');
      else if (k === 'ai_tokens_daily') { if (Number(v) > 0) labels.push(`AI ${(Number(v) / 1000).toLocaleString()}k โทเคน/วัน`); }
      else if (k === 'reports') labels.push(`รายงาน: ${v}`);
      else labels.push(String(v));
    }
    return labels;
  };
  const ai = aiUsage.data;
  const overageCharge = Number(ai?.today?.projected_overage_thb ?? 0);

  return (
    <div>
      <PageHeader title="แพ็กเกจการใช้งาน" description="จัดการการสมัครสมาชิกและแพ็กเกจ" />
      <div className="space-y-6">
        <StateView q={sub}>
          {sub.data && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="แพ็กเกจปัจจุบัน" value={(currentCode ?? '—').toUpperCase()} icon={Package} tone="primary" />
              <StatCard label="สถานะ" value={<Badge variant={statusVariant(sub.data.status ?? 'Active')}>{sub.data.status ?? 'Active'}</Badge>} icon={ShieldCheck} />
              {sub.data.price_monthly != null && <StatCard label="ราคา/เดือน" value={baht(sub.data.price_monthly)} icon={CircleDollarSign} />}
              {sub.data.trial_ends_at && <StatCard label="ทดลองถึง" value={thaiDate(sub.data.trial_ends_at)} icon={CalendarClock} tone="warning" />}
            </div>
          )}
        </StateView>

        {/* AI usage — today's consumption vs the plan's included cap + hard ceiling, plus the metered overage
            charge so the AI cost is visible (PwC follow-up: connect the COGS meter to a price). */}
        {ai && Number(ai.daily_max) > 0 && (
          <Card className="gap-4 p-5">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <strong className="text-sm">การใช้งาน AI วันนี้</strong>
              <span className="ml-auto text-xs text-muted-foreground">รีเซ็ตเที่ยงคืน (เวลาไทย)</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="ใช้ไปวันนี้" value={`${Number(ai.today?.total_tokens ?? 0).toLocaleString()} โทเคน`} icon={Gauge} tone={ai.today?.over_budget ? 'warning' : 'primary'} />
              <StatCard label="รวมในแพ็กเกจ" value={`${Number(ai.daily_limit).toLocaleString()} /วัน`} icon={Package} />
              <StatCard label="เพดานสูงสุด" value={`${Number(ai.daily_max).toLocaleString()} /วัน`} icon={ShieldCheck} />
              <StatCard
                label={`ค่าใช้เกิน (${Number(ai.overage_rate_thb_per_1k)} ฿/1k)`}
                value={baht(overageCharge)}
                icon={CircleDollarSign}
                tone={overageCharge > 0 ? 'warning' : undefined}
              />
            </div>
            {Number(ai.today?.overage_tokens ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground">
                ใช้เกินโควต้าในแพ็กเกจ {Number(ai.today.overage_tokens).toLocaleString()} โทเคน — คิดค่าบริการส่วนเกินตามอัตรา {Number(ai.overage_rate_thb_per_1k)} ฿ ต่อ 1,000 โทเคน
              </p>
            )}
          </Card>
        )}

        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">เลือกแพ็กเกจ</h3>
          <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
          <StateView q={plans}>
            {plans.data && (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {plans.data.plans.map((p) => {
                  const current = p.code === currentCode;
                  return (
                    <Card key={p.code} className={cn('gap-3 p-5', current && 'border-2 border-primary')}>
                      <div className="flex items-center justify-between">
                        <strong className="text-lg">{p.name}</strong>
                        {current && <Badge variant="success">ปัจจุบัน</Badge>}
                      </div>
                      <div className="text-2xl font-bold text-primary">
                        {p.price_monthly > 0 ? baht(p.price_monthly) : 'ฟรี'}
                        {p.price_monthly > 0 && <span className="text-sm font-normal text-muted-foreground"> /เดือน</span>}
                      </div>
                      <ul className="min-h-[60px] list-disc pl-5 text-sm text-muted-foreground">
                        {featureList(p.features).map((f, i) => <li key={i}>{f}</li>)}
                      </ul>
                      <Button
                        className="w-full"
                        variant={current ? 'secondary' : 'default'}
                        disabled={current || change.isPending}
                        onClick={() => change.mutate(p.code)}
                      >
                        {current ? 'กำลังใช้งาน' : 'เลือกแพ็กเกจนี้'}
                      </Button>
                    </Card>
                  );
                })}
              </div>
            )}
          </StateView>
        </div>
      </div>
    </div>
  );
}
