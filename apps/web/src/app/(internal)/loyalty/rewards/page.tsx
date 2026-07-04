'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Gift, Plus, SearchX, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { SearchInput } from '@/components/search-input';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

interface Reward { id: number; reward_code: string; name: string; type: string; point_cost: number; cash_value: number; coupon_kind: string | null; coupon_value: number; stock: number | null; per_member_limit: number | null; tier_min: number | null; active: boolean }

export default function RewardsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const list = useQuery<{ rewards: Reward[]; count: number }>({ queryKey: ['loy-rewards'], queryFn: () => api('/api/loyalty/rewards') });

  const [form, setForm] = useState({ name: '', type: 'evoucher', point_cost: 100, cash_value: 0, coupon_kind: 'amount', coupon_value: 0, stock: '', per_member_limit: '' });
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));

  const create = useMutation({
    mutationFn: () => api('/api/loyalty/rewards', { method: 'POST', body: JSON.stringify({
      name: form.name, type: form.type, point_cost: Number(form.point_cost), cash_value: Number(form.cash_value),
      coupon_kind: form.coupon_kind, coupon_value: Number(form.coupon_value),
      ...(form.stock !== '' ? { stock: Number(form.stock) } : {}),
      ...(form.per_member_limit !== '' ? { per_member_limit: Number(form.per_member_limit) } : {}),
    }) }),
    onSuccess: () => { notifySuccess(t('ly.rw_added')); setForm({ name: '', type: 'evoucher', point_cost: 100, cash_value: 0, coupon_kind: 'amount', coupon_value: 0, stock: '', per_member_limit: '' }); qc.invalidateQueries({ queryKey: ['loy-rewards'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const toggle = useMutation({
    mutationFn: (r: Reward) => api(`/api/loyalty/rewards/${r.id}`, { method: 'PATCH', body: JSON.stringify({ active: !r.active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['loy-rewards'] }),
  });

  const [search, setSearch] = useState('');
  const [active, setActive] = useState<'all' | 'on' | 'off'>('all');
  const rewards = list.data?.rewards ?? [];
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rewards.filter((r) => {
      if (active === 'on' && !r.active) return false;
      if (active === 'off' && r.active) return false;
      if (!term) return true;
      return [r.reward_code, r.name, r.type].some((v) => String(v ?? '').toLowerCase().includes(term));
    });
  }, [rewards, search, active]);

  return (
    <div>
      <PageHeader
        title={t('ly.rw_title')}
        description={t('ly.rw_desc')}
        actions={<Link href="/loyalty/members"><Button variant="outline"><Users className="size-4" /> {t('ly.members')}</Button></Link>}
      />

      <div className="space-y-6">
        <Card className="gap-4">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="size-4" /> {t('ly.rw_add')}</CardTitle></CardHeader>
          <CardContent>
            <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
              <div className="grid gap-1.5 sm:col-span-2"><Label>{t('ly.rw_name')}</Label><Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('ly.rw_name_ph')} required /></div>
              <div className="grid gap-1.5"><Label>{t('ly.col_type')}</Label>
                <select className={selectCls} value={form.type} onChange={(e) => set({ type: e.target.value })}>
                  <option value="evoucher">e-Voucher</option><option value="discount">{t('ly.rw_t_discount')}</option><option value="product">{t('ly.rw_t_product')}</option><option value="privilege">{t('ly.rw_t_privilege')}</option>
                </select>
              </div>
              <div className="grid gap-1.5"><Label>{t('ly.rw_point_cost')}</Label><Input type="number" min="1" value={form.point_cost} onChange={(e) => set({ point_cost: +e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.rw_cash_value')}</Label><Input type="number" min="0" value={form.cash_value} onChange={(e) => set({ cash_value: +e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.rw_coupon_kind')}</Label>
                <select className={selectCls} value={form.coupon_kind} onChange={(e) => set({ coupon_kind: e.target.value })}>
                  <option value="amount">{t('ly.rw_ck_amount')}</option><option value="percent">{t('ly.rw_ck_percent')}</option><option value="free_item">{t('ly.pt_k_freebie')}</option>
                </select>
              </div>
              <div className="grid gap-1.5"><Label>{t('ly.rw_coupon_value')}</Label><Input type="number" min="0" value={form.coupon_value} onChange={(e) => set({ coupon_value: +e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.rw_stock')}</Label><Input type="number" min="0" value={form.stock} onChange={(e) => set({ stock: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.rw_per_member')}</Label><Input type="number" min="1" value={form.per_member_limit} onChange={(e) => set({ per_member_limit: e.target.value })} /></div>
              <div className="flex items-end"><Button type="submit" disabled={!form.name.trim() || create.isPending}>{create.isPending ? t('ly.saving') : t('ly.rw_add_short')}</Button></div>
            </form>
          </CardContent>
        </Card>

        <StateView q={list}>
          {list.data && (
            <div className="space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder={t('ly.ms_search_ph')}
                  ariaLabel={t('ly.rw_search_aria')}
                  count={t('ly.rw_count', { n: num(filtered.length) })}
                />
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('ly.filter_by_status')}>
                  {([['all', t('ly.all')], ['on', t('ly.wh_on')], ['off', t('ly.wh_off')]] as const).map(([v, l]) => (
                    <Button key={v} variant={active === v ? 'secondary' : 'ghost'} size="sm" aria-pressed={active === v} onClick={() => setActive(v)}>{l}</Button>
                  ))}
                </div>
              </div>
            <DataTable
              rows={filtered}
              rowKey={(r) => r.id}
              emptyState={
                search || active !== 'all'
                  ? {
                      icon: SearchX,
                      title: t('ly.rw_no_match'),
                      description: t('ly.no_match_desc'),
                      action: (
                        <Button variant="outline" size="sm" onClick={() => { setSearch(''); setActive('all'); }}>
                          {t('inv.clear_filter')}
                        </Button>
                      ),
                    }
                  : {
                      icon: Gift,
                      title: t('ly.rw_empty'),
                      description: t('ly.rw_empty_desc'),
                    }
              }
              columns={[
                { key: 'reward_code', label: t('ly.col_code'), render: (r) => <span className="font-mono text-xs">{r.reward_code}</span> },
                { key: 'name', label: t('ly.col_name'), render: (r) => <span className="inline-flex items-center gap-1.5"><Gift className="size-3.5 text-muted-foreground" />{r.name}</span> },
                { key: 'type', label: t('ly.col_type'), render: (r) => <Badge variant="info">{r.type}</Badge> },
                { key: 'point_cost', label: t('ly.an_pts'), align: 'right', render: (r) => <span className="tabular">{num(r.point_cost)}</span> },
                { key: 'cash_value', label: t('ly.wh_col_value'), align: 'right', render: (r) => baht(r.cash_value) },
                { key: 'stock', label: t('ly.wh_col_stock'), align: 'right', render: (r) => r.stock == null ? '∞' : num(r.stock) },
                { key: 'per_member_limit', label: t('ly.rw_col_limit'), align: 'right', render: (r) => r.per_member_limit == null ? '∞' : num(r.per_member_limit) },
                { key: 'active', label: t('fin.col_status'), align: 'center', render: (r) => <button onClick={() => toggle.mutate(r)} className="cursor-pointer">{r.active ? <Badge variant="success">{t('ly.wh_on')}</Badge> : <Badge variant="muted">{t('ly.wh_off')}</Badge>}</button> },
              ]}
            />
            </div>
          )}
        </StateView>
      </div>
    </div>
  );
}
