'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, Star } from 'lucide-react';
import { api } from '@/lib/api';
import { num, baht, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
      <PageHeader title="แต้มสะสม" description="ยอดแต้มและการแลกส่วนลด" />
      <StateView q={me}>
        {d && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <StatCard label="แต้มคงเหลือ" value={num(d.balance)} icon={Star} tone="primary" />
              <StatCard label="แต้มสะสมตลอดชีพ" value={num(d.lifetime)} icon={Gift} />
            </div>
            <Card className="max-w-md gap-4 p-5">
              <CardContent className="space-y-3 px-0">
                <h3 className="text-base font-semibold">แลกแต้มเป็นส่วนลด</h3>
                <div className="grid gap-2">
                  <Label htmlFor="points">จำนวนแต้ม</Label>
                  <Input id="points" type="number" value={points} onChange={(e) => setPoints(+e.target.value)} />
                </div>
                <Button disabled={redeem.isPending} onClick={() => redeem.mutate()}>
                  <Gift className="size-4" /> แลกแต้ม
                </Button>
                {redeem.error && <Msg>{(redeem.error as Error).message}</Msg>}
                {redeem.data && <Msg ok>✅ แลกสำเร็จ — ได้ส่วนลด {baht(redeem.data.redeem_val)} (เหลือ {num(redeem.data.balance)} แต้ม)</Msg>}
              </CardContent>
            </Card>
            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ประวัติแต้ม</h3>
              <DataTable rows={d.recent_txn} columns={[
                { key: 'txn_date', label: 'วันที่', render: (r) => thaiDate(r.txn_date) },
                { key: 'txn_type', label: 'ประเภท' },
                { key: 'points', label: 'แต้ม', align: 'right', render: (r) => <span className={cn('tabular', Number(r.points) < 0 ? 'text-destructive' : 'text-success')}>{Number(r.points) > 0 ? '+' : ''}{num(r.points)}</span> },
                { key: 'balance_after', label: 'คงเหลือ', align: 'right', render: (r) => num(r.balance_after) },
                { key: 'ref_doc', label: 'อ้างอิง' },
              ]} />
            </div>
          </div>
        )}
      </StateView>
    </div>
  );
}
