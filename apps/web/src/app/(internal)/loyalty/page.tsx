'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, StateView } from '@/components/ui';
import { Msg } from '@/components/tabs';

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
      <h1 style={{ marginTop: 0 }}>⭐ ตั้งค่าระบบสะสมแต้ม</h1>
      <StateView q={q}>
        {cfg && (
          <Card style={{ maxWidth: 460 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
              <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
              <strong>เปิดใช้งานระบบสะสมแต้ม</strong>
            </label>
            <label className="label">แต้มต่อบาท (earn)<input className="input" type="number" value={cfg.points_per_baht} onChange={(e) => set({ points_per_baht: +e.target.value })} /></label>
            <div style={{ height: 10 }} />
            <label className="label">บาทต่อแต้ม (redeem)<input className="input" type="number" value={cfg.baht_per_point} onChange={(e) => set({ baht_per_point: +e.target.value })} /></label>
            <div style={{ height: 10 }} />
            <label className="label">แต้มขั้นต่ำที่แลกได้<input className="input" type="number" value={cfg.min_redeem} onChange={(e) => set({ min_redeem: +e.target.value })} /></label>
            <div style={{ height: 10 }} />
            <label className="label">อายุแต้ม (วัน, 0 = ไม่หมดอายุ)<input className="input" type="number" value={cfg.expiry_days} onChange={(e) => set({ expiry_days: +e.target.value })} /></label>
            <button className="btn" style={{ marginTop: 16 }} disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'กำลังบันทึก…' : 'บันทึก'}</button>
            {save.isSuccess && <Msg ok>✅ บันทึกแล้ว</Msg>}
            {save.error && <Msg>{(save.error as Error).message}</Msg>}
          </Card>
        )}
      </StateView>
    </div>
  );
}
