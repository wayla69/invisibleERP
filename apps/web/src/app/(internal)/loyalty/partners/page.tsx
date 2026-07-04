'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Handshake, Plus, Gift, Users } from 'lucide-react';
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

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';
interface Priv { id: number; name: string; kind: string; value: number; tier_min: number | null; stock: number | null; per_member_limit: number | null; active: boolean }
interface Partner { id: number; partner_code: string; name: string; category: string | null; active: boolean; privileges: Priv[] }

export default function PartnersPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const list = useQuery<{ partners: Partner[] }>({ queryKey: ['loy-partners'], queryFn: () => api('/api/loyalty/partners') });
  const [pName, setPName] = useState(''); const [pCat, setPCat] = useState('dining');
  const [pv, setPv] = useState({ partner_id: 0, name: '', kind: 'discount_percent', value: 10, tier_min: '', stock: '', per_member_limit: '' });
  const set = (p: Partial<typeof pv>) => setPv((s) => ({ ...s, ...p }));
  const [msg, setMsg] = useState('');

  const addPartner = useMutation({
    mutationFn: () => api('/api/loyalty/partners', { method: 'POST', body: JSON.stringify({ name: pName, category: pCat }) }),
    onSuccess: () => { setMsg('✅ ' + t('ly.pt_partner_added')); setPName(''); qc.invalidateQueries({ queryKey: ['loy-partners'] }); }, onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });
  const addPriv = useMutation({
    mutationFn: () => api('/api/loyalty/privileges', { method: 'POST', body: JSON.stringify({
      partner_id: Number(pv.partner_id), name: pv.name, kind: pv.kind, value: Number(pv.value),
      ...(pv.tier_min !== '' ? { tier_min: Number(pv.tier_min) } : {}), ...(pv.stock !== '' ? { stock: Number(pv.stock) } : {}), ...(pv.per_member_limit !== '' ? { per_member_limit: Number(pv.per_member_limit) } : {}),
    }) }),
    onSuccess: () => { setMsg('✅ ' + t('ly.pt_priv_added')); setPv({ ...pv, name: '' }); qc.invalidateQueries({ queryKey: ['loy-partners'] }); }, onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });
  const toggleP = useMutation({ mutationFn: (p: Partner) => api('/api/loyalty/partners', { method: 'POST', body: JSON.stringify({ id: p.id, name: p.name, category: p.category, active: !p.active }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['loy-partners'] }) });
  const togglePriv = useMutation({ mutationFn: (v: Priv) => api(`/api/loyalty/privileges/${v.id}`, { method: 'PATCH', body: JSON.stringify({ active: !v.active }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['loy-partners'] }) });

  const partners = list.data?.partners ?? [];
  return (
    <div>
      <PageHeader title={t('ly.pt_title')} description={t('ly.pt_desc')}
        actions={<Link href="/loyalty/members"><Button variant="outline"><Users className="size-4" /> {t('ly.members')}</Button></Link>} />
      <div className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="gap-3">
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Handshake className="size-4" /> {t('ly.pt_add_partner')}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-1.5"><Label>{t('ly.pt_partner_name')}</Label><Input value={pName} onChange={(e) => setPName(e.target.value)} placeholder={t('ly.pt_partner_name_ph')} /></div>
              <div className="grid gap-1.5"><Label>{t('ly.pt_category')}</Label><select className={selectCls} value={pCat} onChange={(e) => setPCat(e.target.value)}><option value="dining">{t('ly.pt_cat_dining')}</option><option value="retail">{t('ly.pt_cat_retail')}</option><option value="travel">{t('ly.pt_cat_travel')}</option><option value="wellness">{t('ly.pt_cat_wellness')}</option></select></div>
              <Button onClick={() => { setMsg(''); addPartner.mutate(); }} disabled={!pName.trim() || addPartner.isPending}>{t('ly.pt_add_partner')}</Button>
            </CardContent>
          </Card>
          <Card className="gap-3">
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="size-4" /> {t('ly.pt_add_priv')}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-1.5"><Label>{t('ly.pt_partner')}</Label><select className={selectCls} value={pv.partner_id} onChange={(e) => set({ partner_id: +e.target.value })}><option value={0}>{t('ly.pt_select')}</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1.5 col-span-2"><Label>{t('ly.pt_priv_name')}</Label><Input value={pv.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('ly.pt_priv_name_ph')} /></div>
                <div className="grid gap-1.5"><Label>{t('ly.pt_kind')}</Label><select className={selectCls} value={pv.kind} onChange={(e) => set({ kind: e.target.value })}><option value="discount_percent">{t('ly.pt_k_disc_pct')}</option><option value="discount_amount">{t('ly.pt_k_disc_amt')}</option><option value="freebie">{t('ly.pt_k_freebie')}</option><option value="access">{t('ly.pt_k_access')}</option></select></div>
                <div className="grid gap-1.5"><Label>{t('ly.wh_col_value')}</Label><Input type="number" min="0" value={pv.value} onChange={(e) => set({ value: +e.target.value })} /></div>
                <div className="grid gap-1.5"><Label>{t('ly.pt_tier_min')}</Label><Input type="number" min="0" value={pv.tier_min} onChange={(e) => set({ tier_min: e.target.value })} /></div>
                <div className="grid gap-1.5"><Label>{t('ly.pt_stock')}</Label><Input type="number" min="0" value={pv.stock} onChange={(e) => set({ stock: e.target.value })} /></div>
                <div className="grid gap-1.5 col-span-2"><Label>{t('ly.pt_per_member')}</Label><Input type="number" min="1" value={pv.per_member_limit} onChange={(e) => set({ per_member_limit: e.target.value })} /></div>
              </div>
              <Button onClick={() => { setMsg(''); addPriv.mutate(); }} disabled={!pv.partner_id || !pv.name.trim() || addPriv.isPending}>{t('ly.pt_add_priv')}</Button>
            </CardContent>
          </Card>
        </div>
        {msg && <p className={msg.startsWith('✅') ? 'text-sm text-success' : 'text-sm text-destructive'}>{msg}</p>}

        <StateView q={list}>
          {partners.map((p) => (
            <Card key={p.id} className="gap-3">
              <CardHeader className="pb-0"><CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2"><Handshake className="size-4" /> {p.name} {p.category && <Badge variant="info">{p.category}</Badge>} <span className="font-mono text-xs text-muted-foreground">{p.partner_code}</span></span>
                <button onClick={() => toggleP.mutate(p)}>{p.active ? <Badge variant="success">{t('ly.wh_on')}</Badge> : <Badge variant="muted">{t('ly.wh_off')}</Badge>}</button>
              </CardTitle></CardHeader>
              <CardContent>
                {p.privileges.length === 0 ? <p className="text-xs text-muted-foreground">{t('ly.pt_no_priv')}</p> : (
                  <div className="flex flex-wrap gap-2">
                    {p.privileges.map((v) => (
                      <button key={v.id} onClick={() => togglePriv.mutate(v)} className="rounded-lg border border-border/60 px-3 py-1.5 text-left text-xs hover:bg-muted/50">
                        <span className="inline-flex items-center gap-1.5"><Gift className="size-3" />{v.name}</span> · {v.kind === 'discount_percent' ? `${v.value}%` : v.kind === 'discount_amount' ? `฿${v.value}` : v.kind}
                        {v.tier_min != null && ` · ${t('ly.pt_min_val', { n: num(v.tier_min) })}`}{v.stock != null && ` · ${t('ly.wh_stock_left', { n: num(v.stock) })}`}{!v.active && ` · ${t('ly.wh_off')}`}
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </StateView>
      </div>
    </div>
  );
}
