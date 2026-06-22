'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CircleDollarSign, Package, ShieldCheck } from 'lucide-react';
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
  const [msg, setMsg] = useState('');

  const change = useMutation({
    mutationFn: (plan_code: string) => api('/api/billing/change-plan', { method: 'POST', body: JSON.stringify({ plan_code }) }),
    onSuccess: (_d, plan_code) => { setMsg(`✅ เปลี่ยนเป็นแพ็กเกจ ${plan_code} แล้ว`); qc.invalidateQueries({ queryKey: ['subscription'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  const currentCode = sub.data?.plan_code ?? sub.data?.plan?.code;
  const featureList = (f: any): string[] => (Array.isArray(f) ? f : f && typeof f === 'object' ? Object.values(f).map(String) : []);

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
