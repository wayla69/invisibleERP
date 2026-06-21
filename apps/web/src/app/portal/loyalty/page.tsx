'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, Kpi, DataTable, StateView } from '@/components/ui';
import { Msg } from '@/components/tabs';
import { num, baht, thaiDate } from '@/lib/format';

export default function PortalLoyalty() {
  const qc = useQueryClient();
  const me = useQuery<any>({ queryKey: ['loyalty-me'], queryFn: () => api('/api/loyalty/me') });
  const [points, setPoints] = useState(100);
  const redeem = useMutation({
    mutationFn: () => api<{ redeem_val: number; balance: number }>('/api/loyalty/redeem', { method: 'POST', body: JSON.stringify({ points: Number(points) }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['loyalty-me'] }),
  });
  const d = me.data;
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>⭐ แต้มสะสม</h1>
      <StateView q={me}>
        {d && (
          <>
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              <Kpi label="แต้มคงเหลือ" value={num(d.balance)} accent="var(--navy)" />
              <Kpi label="แต้มสะสมตลอดชีพ" value={num(d.lifetime)} />
            </div>
            <Card style={{ maxWidth: 420, marginBottom: 16 }}>
              <h3 style={{ marginTop: 0 }}>แลกแต้มเป็นส่วนลด</h3>
              <label className="label">จำนวนแต้ม<input className="input" type="number" value={points} onChange={(e) => setPoints(+e.target.value)} /></label>
              <button className="btn" style={{ marginTop: 10 }} disabled={redeem.isPending} onClick={() => redeem.mutate()}>แลกแต้ม</button>
              {redeem.error && <Msg>{(redeem.error as Error).message}</Msg>}
              {redeem.data && <Msg ok>✅ แลกสำเร็จ — ได้ส่วนลด {baht(redeem.data.redeem_val)} (เหลือ {num(redeem.data.balance)} แต้ม)</Msg>}
            </Card>
            <h3>ประวัติแต้ม</h3>
            <DataTable rows={d.recent_txn} columns={[
              { key: 'txn_date', label: 'วันที่', render: (r) => thaiDate(r.txn_date) },
              { key: 'txn_type', label: 'ประเภท' },
              { key: 'points', label: 'แต้ม', render: (r) => <span style={{ color: Number(r.points) < 0 ? 'var(--ruby)' : '#059669' }}>{Number(r.points) > 0 ? '+' : ''}{num(r.points)}</span> },
              { key: 'balance_after', label: 'คงเหลือ', render: (r) => num(r.balance_after) },
              { key: 'ref_doc', label: 'อ้างอิง' },
            ]} />
          </>
        )}
      </StateView>
    </div>
  );
}
