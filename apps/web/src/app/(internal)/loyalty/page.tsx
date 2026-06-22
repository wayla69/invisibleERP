'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Cfg { enabled: boolean; points_per_baht: number; baht_per_point: number; min_redeem: number; expiry_days: number }

export default function LoyaltyConfig() {
  const qc = useQueryClient();
  const q = useQuery<Cfg>({ queryKey: ['loy-cfg'], queryFn: () => api('/api/loyalty/config') });
  const [cfg, setCfg] = useState<Cfg | null>(null);
  useEffect(() => { if (q.data && !cfg) setCfg(q.data); }, [q.data, cfg]);

  const save = useMutation({
    mutationFn: () => api('/api/loyalty/config', { method: 'PUT', body: JSON.stringify(cfg) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['loy-cfg'] }),
  });
  const set = (p: Partial<Cfg>) => setCfg((c) => (c ? { ...c, ...p } : c));

  return (
    <div>
      <PageHeader title="ตั้งค่าระบบสะสมแต้ม" description="กำหนดอัตราการสะสมและแลกแต้ม" />
      <StateView q={q}>
        {cfg && (
          <Card className="max-w-md gap-4 p-5">
            <Label className="gap-2">
              <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
              <span className="font-semibold">เปิดใช้งานระบบสะสมแต้ม</span>
            </Label>
            <div className="grid gap-2">
              <Label>แต้มต่อบาท (earn)</Label>
              <Input type="number" value={cfg.points_per_baht} onChange={(e) => set({ points_per_baht: +e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label>บาทต่อแต้ม (redeem)</Label>
              <Input type="number" value={cfg.baht_per_point} onChange={(e) => set({ baht_per_point: +e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label>แต้มขั้นต่ำที่แลกได้</Label>
              <Input type="number" value={cfg.min_redeem} onChange={(e) => set({ min_redeem: +e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label>อายุแต้ม (วัน, 0 = ไม่หมดอายุ)</Label>
              <Input type="number" value={cfg.expiry_days} onChange={(e) => set({ expiry_days: +e.target.value })} />
            </div>
            <div>
              <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'กำลังบันทึก…' : 'บันทึก'}</Button>
            </div>
            {save.isSuccess && <Msg ok>✅ บันทึกแล้ว</Msg>}
            {save.error && <Msg>{(save.error as Error).message}</Msg>}
          </Card>
        )}
      </StateView>
    </div>
  );
}
