'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, Star } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
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
  const { t } = useLang();
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
      <PageHeader title={t('pt.loy.title')} description={t('pt.loy.desc')} />
      <StateView q={me}>
        {d && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <StatCard label={t('pt.loy.balance')} value={num(d.balance)} icon={Star} tone="primary" />
              <StatCard label={t('pt.loy.lifetime')} value={num(d.lifetime)} icon={Gift} />
            </div>
            <Card className="max-w-md gap-4 p-5">
              <CardContent className="space-y-3 px-0">
                <h3 className="text-base font-semibold">{t('pt.loy.redeem_title')}</h3>
                <div className="grid gap-2">
                  <Label htmlFor="points">{t('pt.loy.points_qty')}</Label>
                  <Input id="points" type="number" value={points} onChange={(e) => setPoints(+e.target.value)} />
                </div>
                <Button disabled={redeem.isPending} onClick={() => redeem.mutate()}>
                  <Gift className="size-4" /> {t('pt.loy.redeem')}
                </Button>
                {redeem.error && <Msg>{(redeem.error as Error).message}</Msg>}
                {redeem.data && <Msg ok>{t('pt.loy.redeem_ok', { value: baht(redeem.data.redeem_val), balance: num(redeem.data.balance) })}</Msg>}
              </CardContent>
            </Card>
            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('pt.loy.history')}</h3>
              <DataTable rows={d.recent_txn} columns={[
                { key: 'txn_date', label: t('pt.col_date'), render: (r) => thaiDate(r.txn_date) },
                { key: 'txn_type', label: t('pt.loy.col_type') },
                { key: 'points', label: t('pt.col_points'), align: 'right', render: (r) => <span className={cn('tabular', Number(r.points) < 0 ? 'text-destructive' : 'text-success')}>{Number(r.points) > 0 ? '+' : ''}{num(r.points)}</span> },
                { key: 'balance_after', label: t('pt.loy.col_after'), align: 'right', render: (r) => num(r.balance_after) },
                { key: 'ref_doc', label: t('pt.loy.col_ref') },
              ]} />
            </div>
          </div>
        )}
      </StateView>
    </div>
  );
}
