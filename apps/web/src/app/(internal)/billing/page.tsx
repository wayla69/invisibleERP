'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, Kpi, Badge, StateView } from '@/components/ui';
import { Msg } from '@/components/tabs';
import { baht, thaiDate } from '@/lib/format';

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
      <h1 style={{ marginTop: 0 }}>💳 แพ็กเกจการใช้งาน (Subscription)</h1>

      <StateView q={sub}>
        {sub.data && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            <Kpi label="แพ็กเกจปัจจุบัน" value={(currentCode ?? '—').toUpperCase()} accent="var(--navy)" />
            <Kpi label="สถานะ" value={<Badge value={sub.data.status ?? 'Active'} />} />
            {sub.data.price_monthly != null && <Kpi label="ราคา/เดือน" value={baht(sub.data.price_monthly)} />}
            {sub.data.trial_ends_at && <Kpi label="ทดลองถึง" value={thaiDate(sub.data.trial_ends_at)} accent="var(--ruby)" />}
          </div>
        )}
      </StateView>

      <h3>เลือกแพ็กเกจ</h3>
      <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      <StateView q={plans}>
        {plans.data && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
            {plans.data.plans.map((p) => {
              const current = p.code === currentCode;
              return (
                <Card key={p.code} style={{ border: current ? '2px solid var(--navy)' : undefined }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: 18 }}>{p.name}</strong>
                    {current && <Badge value="ปัจจุบัน" />}
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--navy)', margin: '8px 0' }}>
                    {p.price_monthly > 0 ? baht(p.price_monthly) : 'ฟรี'}
                    {p.price_monthly > 0 && <span style={{ fontSize: 13, fontWeight: 400 }}> /เดือน</span>}
                  </div>
                  <ul style={{ paddingLeft: 18, margin: '8px 0', fontSize: 13, color: 'var(--muted)', minHeight: 60 }}>
                    {featureList(p.features).map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                  <button
                    className="btn"
                    style={{ width: '100%', background: current ? 'var(--muted)' : undefined }}
                    disabled={current || change.isPending}
                    onClick={() => change.mutate(p.code)}
                  >
                    {current ? 'กำลังใช้งาน' : 'เลือกแพ็กเกจนี้'}
                  </button>
                </Card>
              );
            })}
          </div>
        )}
      </StateView>
    </div>
  );
}
