'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

type Flag = { key: string; label: string; description: string; tier: 'CORE' | 'LABS'; enabled: boolean; source: string };

export default function LabsSettingsPage() {
  const qc = useQueryClient();
  const q = useQuery<{ flags: Flag[] }>({ queryKey: ['feature-flags'], queryFn: () => api('/api/feature-flags') });

  const toggle = useMutation({
    mutationFn: (v: { key: string; enabled: boolean }) => api(`/api/feature-flags/${encodeURIComponent(v.key)}`, { method: 'PUT', body: JSON.stringify({ enabled: v.enabled }) }),
    onSuccess: () => { notifySuccess('บันทึกการตั้งค่าแล้ว'); qc.invalidateQueries({ queryKey: ['feature-flags'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const labs = (q.data?.flags ?? []).filter((f) => f.tier === 'LABS');
  const master = (q.data?.flags ?? []).find((f) => f.key === 'labs_visible');

  return (
    <div>
      <PageHeader
        title="โมดูลทดลอง (Labs)"
        description="เปิด/ปิดโมดูลเสริมที่ยังไม่ใช่ส่วนหลักของระบบ — ซ่อนไว้เพื่อให้หน้าจอกระชับ และเปิดเมื่อต้องการใช้งานจริง"
      />
      <StateView q={q}>
        {q.data && (
          <div className="space-y-6">
            {master && (
              <div className="flex items-center justify-between rounded-xl border bg-card p-4">
                <div>
                  <div className="font-medium">{master.label}</div>
                  <div className="text-sm text-muted-foreground">{master.description}</div>
                </div>
                <Button variant={master.enabled ? 'default' : 'outline'} disabled={toggle.isPending} onClick={() => toggle.mutate({ key: master.key, enabled: !master.enabled })}>
                  {master.enabled ? 'เปิดอยู่' : 'ปิดอยู่'}
                </Button>
              </div>
            )}
            <div className="rounded-xl border bg-card">
              <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold"><FlaskConical className="size-4 text-primary" /> โมดูล Labs</div>
              <ul className="divide-y">
                {labs.map((f) => (
                  <li key={f.key} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <div className="flex items-center gap-2 font-medium">{f.label} <Badge variant="muted" className="text-[10px]">Labs</Badge></div>
                      <div className="text-sm text-muted-foreground">{f.description}</div>
                    </div>
                    <Button size="sm" variant={f.enabled ? 'default' : 'outline'} disabled={toggle.isPending} onClick={() => toggle.mutate({ key: f.key, enabled: !f.enabled })}>
                      {f.enabled ? 'เปิด' : 'ปิด'}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </StateView>
    </div>
  );
}
