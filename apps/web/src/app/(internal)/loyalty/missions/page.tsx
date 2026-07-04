'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Target, Plus, SearchX, Users } from 'lucide-react';
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

interface Mission { id: number; mission_code: string; name: string; type: string; goal: number; reward_kind: string; reward_points: number; reward_coupon_value: number; active: boolean }

export default function MissionsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const list = useQuery<{ missions: Mission[] }>({ queryKey: ['loy-missions'], queryFn: () => api('/api/loyalty/missions') });
  const [form, setForm] = useState({ name: '', type: 'stamp', goal: 10, reward_kind: 'points', reward_points: 100, reward_coupon_value: 0 });
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));

  const create = useMutation({
    mutationFn: () => api('/api/loyalty/missions', { method: 'POST', body: JSON.stringify({
      name: form.name, type: form.type, goal: Number(form.goal), reward_kind: form.reward_kind,
      ...(form.reward_kind === 'points' ? { reward_points: Number(form.reward_points) } : { reward_coupon_kind: 'amount', reward_coupon_value: Number(form.reward_coupon_value) }),
    }) }),
    onSuccess: () => { notifySuccess(t('ly.ms_added')); setForm({ name: '', type: 'stamp', goal: 10, reward_kind: 'points', reward_points: 100, reward_coupon_value: 0 }); qc.invalidateQueries({ queryKey: ['loy-missions'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const toggle = useMutation({ mutationFn: (m: Mission) => api(`/api/loyalty/missions/${m.id}`, { method: 'PATCH', body: JSON.stringify({ active: !m.active }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['loy-missions'] }) });

  const [search, setSearch] = useState('');
  const [active, setActive] = useState<'all' | 'on' | 'off'>('all');
  const missions = list.data?.missions ?? [];
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return missions.filter((m) => {
      if (active === 'on' && !m.active) return false;
      if (active === 'off' && m.active) return false;
      if (!term) return true;
      return [m.mission_code, m.name, m.type].some((v) => String(v ?? '').toLowerCase().includes(term));
    });
  }, [missions, search, active]);

  return (
    <div>
      <PageHeader
        title={t('ly.ms_title')}
        description={t('ly.ms_desc')}
        actions={<Link href="/loyalty/members"><Button variant="outline"><Users className="size-4" /> {t('ly.members')}</Button></Link>}
      />
      <div className="space-y-6">
        <Card className="gap-4">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="size-4" /> {t('ly.ms_add')}</CardTitle></CardHeader>
          <CardContent>
            <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
              <div className="grid gap-1.5 sm:col-span-2"><Label>{t('ly.ms_name')}</Label><Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('ly.ms_name_ph')} required /></div>
              <div className="grid gap-1.5"><Label>{t('ly.col_type')}</Label>
                <select className={selectCls} value={form.type} onChange={(e) => set({ type: e.target.value })}><option value="stamp">{t('ly.ms_type_stamp')}</option><option value="quest">{t('ly.ms_type_quest')}</option></select>
              </div>
              <div className="grid gap-1.5"><Label>{t('ly.ms_goal_label')}</Label><Input type="number" min="1" value={form.goal} onChange={(e) => set({ goal: +e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.ms_reward')}</Label>
                <select className={selectCls} value={form.reward_kind} onChange={(e) => set({ reward_kind: e.target.value })}><option value="points">{t('ly.ms_r_points')}</option><option value="coupon">{t('ly.ms_r_coupon')}</option></select>
              </div>
              {form.reward_kind === 'points'
                ? <div className="grid gap-1.5"><Label>{t('ly.ms_r_points')}</Label><Input type="number" min="0" value={form.reward_points} onChange={(e) => set({ reward_points: +e.target.value })} /></div>
                : <div className="grid gap-1.5"><Label>{t('ly.ms_coupon_value')}</Label><Input type="number" min="0" value={form.reward_coupon_value} onChange={(e) => set({ reward_coupon_value: +e.target.value })} /></div>}
              <div className="flex items-end"><Button type="submit" disabled={!form.name.trim() || create.isPending}>{create.isPending ? t('ly.saving') : t('ly.ms_add')}</Button></div>
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
                  ariaLabel={t('ly.ms_search_aria')}
                  count={t('ly.ms_count', { n: num(filtered.length) })}
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
                      title: t('ly.ms_no_match'),
                      description: t('ly.no_match_desc'),
                      action: (
                        <Button variant="outline" size="sm" onClick={() => { setSearch(''); setActive('all'); }}>
                          {t('inv.clear_filter')}
                        </Button>
                      ),
                    }
                  : { icon: Target, title: t('ly.ms_empty'), description: t('ly.ms_empty_desc') }
              }
              columns={[
                { key: 'mission_code', label: t('ly.col_code'), render: (r) => <span className="font-mono text-xs">{r.mission_code}</span> },
                { key: 'name', label: t('ly.col_name'), render: (r) => <span className="inline-flex items-center gap-1.5"><Target className="size-3.5 text-muted-foreground" />{r.name}</span> },
                { key: 'type', label: t('ly.col_type'), render: (r) => <Badge variant="info">{r.type}</Badge> },
                { key: 'goal', label: t('ly.ms_col_goal'), align: 'right', render: (r) => <span className="tabular">{num(r.goal)}</span> },
                { key: 'reward', label: t('ly.ms_reward'), align: 'right', render: (r) => r.reward_kind === 'points' ? t('ly.ms_points_plus', { n: num(r.reward_points) }) : baht(r.reward_coupon_value) },
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
