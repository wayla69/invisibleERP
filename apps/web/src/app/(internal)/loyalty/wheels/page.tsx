'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Disc3, Plus, Trash2, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/form-controls';


interface Segment { id?: number; label: string; prize_kind: string; prize_points: number; coupon_kind?: string; coupon_value?: number; weight: number; stock: number | null; won_count?: number }
interface Wheel { id: number; wheel_code: string; name: string; cost_points: number; daily_free_spins: number; active: boolean; segments: Segment[] }

const emptySeg = (): Segment => ({ label: '', prize_kind: 'points', prize_points: 10, weight: 1, stock: null });

export default function WheelsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const list = useQuery<{ wheels: Wheel[]; count: number }>({ queryKey: ['loy-wheels'], queryFn: () => api('/api/loyalty/wheels') });

  const [name, setName] = useState('');
  const [cost, setCost] = useState(0);
  const [freeSpins, setFreeSpins] = useState(1);
  const [segs, setSegs] = useState<Segment[]>([{ label: t('ly.wh_seg_grand'), prize_kind: 'points', prize_points: 100, weight: 1, stock: 10 }, { label: t('ly.wh_seg_consolation'), prize_kind: 'points', prize_points: 5, weight: 5, stock: null }, { label: t('ly.wh_seg_none'), prize_kind: 'none', prize_points: 0, weight: 4, stock: null }]);
  const [msg, setMsg] = useState('');
  const setSeg = (i: number, p: Partial<Segment>) => setSegs((a) => a.map((s, j) => (j === i ? { ...s, ...p } : s)));

  const create = useMutation({
    mutationFn: () => api('/api/loyalty/wheels', { method: 'POST', body: JSON.stringify({
      name, cost_points: Number(cost), daily_free_spins: Number(freeSpins),
      segments: segs.map((s) => ({ label: s.label, prize_kind: s.prize_kind, prize_points: Number(s.prize_points) || 0, coupon_kind: s.coupon_kind, coupon_value: Number(s.coupon_value) || 0, weight: Number(s.weight) || 0, stock: s.stock === null || (s.stock as any) === '' ? null : Number(s.stock) })),
    }) }),
    onSuccess: () => { setMsg('✅ ' + t('ly.wh_created')); setName(''); qc.invalidateQueries({ queryKey: ['loy-wheels'] }); },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });
  const toggle = useMutation({ mutationFn: (w: Wheel) => api(`/api/loyalty/wheels/${w.id}`, { method: 'PATCH', body: JSON.stringify({ active: !w.active }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['loy-wheels'] }) });

  const totalWeight = segs.reduce((a, s) => a + (Number(s.weight) || 0), 0);

  return (
    <div>
      <PageHeader title={t('ly.wh_title')} description={t('ly.wh_desc')} actions={<Link href="/loyalty/members"><Button variant="outline"><Users className="size-4" /> {t('ly.members')}</Button></Link>} />

      <div className="space-y-6">
        <Card className="gap-4">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="size-4" /> {t('ly.wh_create')}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5 sm:col-span-1"><Label>{t('ly.wh_name')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('ly.wh_name_ph')} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.wh_cost')}</Label><Input type="number" min="0" value={cost} onChange={(e) => setCost(+e.target.value)} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.wh_free_per_day')}</Label><Input type="number" min="0" value={freeSpins} onChange={(e) => setFreeSpins(+e.target.value)} /></div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between"><Label>{t('ly.wh_segments', { total: totalWeight })}</Label><Button type="button" size="sm" variant="outline" onClick={() => setSegs((a) => [...a, emptySeg()])}><Plus className="size-3.5" /> {t('ly.wh_add_seg')}</Button></div>
              <div className="hidden grid-cols-6 gap-2 px-2 text-xs font-medium text-muted-foreground sm:grid">
                <span className="col-span-2">{t('ly.wh_col_label')}</span><span>{t('ly.wh_col_kind')}</span><span>{t('ly.wh_col_value')}</span><span>{t('ly.wh_col_weight')}</span><span>{t('ly.wh_col_stock')}</span>
              </div>
              {segs.map((s, i) => (
                <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-border/60 p-2 sm:grid-cols-6">
                  <Input className="sm:col-span-2" value={s.label} onChange={(e) => setSeg(i, { label: e.target.value })} placeholder={t('ly.wh_col_label')} aria-label={t('ly.wh_aria_label', { n: i + 1 })} />
                  <Select className="w-auto" value={s.prize_kind} onChange={(e) => setSeg(i, { prize_kind: e.target.value })} aria-label={t('ly.wh_aria_kind', { n: i + 1 })}><option value="points">{t('ly.wh_opt_points')}</option><option value="coupon">{t('ly.wh_opt_coupon')}</option><option value="none">{t('ly.wh_opt_none')}</option></Select>
                  <Input type="number" inputMode="numeric" min="0" value={s.prize_kind === 'points' ? s.prize_points : (s.coupon_value ?? 0)} onChange={(e) => setSeg(i, s.prize_kind === 'points' ? { prize_points: +e.target.value } : { coupon_value: +e.target.value })} placeholder={t('ly.wh_col_value')} title={t('ly.wh_value_title')} aria-label={t('ly.wh_aria_value', { n: i + 1 })} />
                  <Input type="number" inputMode="numeric" min="0" value={s.weight} onChange={(e) => setSeg(i, { weight: +e.target.value })} placeholder={t('ly.wh_col_weight')} title={t('ly.wh_weight_title')} aria-label={t('ly.wh_aria_weight', { n: i + 1 })} />
                  <div className="flex items-center gap-1">
                    <Input type="number" inputMode="numeric" min="0" value={s.stock ?? ''} onChange={(e) => setSeg(i, { stock: e.target.value === '' ? null : +e.target.value })} placeholder={t('ly.wh_stock_ph')} title={t('ly.wh_stock_title')} aria-label={t('ly.wh_aria_stock', { n: i + 1 })} />
                    {segs.length > 1 && <button type="button" onClick={() => setSegs((a) => a.filter((_, j) => j !== i))} aria-label={t('ly.wh_aria_remove', { n: i + 1 })} className="text-muted-foreground hover:text-destructive"><Trash2 className="size-4" /></button>}
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">{t('ly.wh_odds_note')}</p>
            </div>
            <div className="flex items-center gap-3"><Button onClick={() => { setMsg(''); create.mutate(); }} disabled={!name.trim() || totalWeight <= 0 || create.isPending}>{create.isPending ? t('ly.wh_creating') : t('ly.wh_create')}</Button>{msg && <span className={msg.startsWith('✅') ? 'text-sm text-success' : 'text-sm text-destructive'}>{msg}</span>}</div>
          </CardContent>
        </Card>

        <StateView q={list}>
          {list.data?.wheels?.map((w) => (
            <Card key={w.id} className="gap-3">
              <CardHeader className="pb-0"><CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2"><Disc3 className="size-4" /> {w.name} <span className="font-mono text-xs text-muted-foreground">{w.wheel_code}</span></span>
                <span className="flex items-center gap-2 text-sm font-normal text-muted-foreground">{w.cost_points > 0 ? t('ly.wh_cost_per', { n: num(w.cost_points) }) : t('ly.wh_free')} · {t('ly.wh_free_daily', { n: w.daily_free_spins })}
                  <button onClick={() => toggle.mutate(w)}>{w.active ? <Badge variant="success">{t('ly.wh_on')}</Badge> : <Badge variant="muted">{t('ly.wh_off')}</Badge>}</button></span>
              </CardTitle></CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {w.segments.map((s) => (
                    <div key={s.id} className="rounded-lg border border-border/60 px-3 py-1.5 text-xs">
                      <span className="font-medium">{s.label}</span> · {s.prize_kind === 'points' ? t('ly.wh_points_val', { n: num(s.prize_points) }) : s.prize_kind === 'coupon' ? t('ly.wh_coupon_val', { n: num(s.coupon_value ?? 0) }) : t('ly.wh_opt_none')} · {t('ly.wh_weight_val', { n: s.weight })} · {s.stock == null ? t('ly.wh_stock_inf') : t('ly.wh_stock_left', { n: num(s.stock) })} · {t('ly.wh_won', { n: num(s.won_count ?? 0) })}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </StateView>
      </div>
    </div>
  );
}
