'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { baht } from '@/lib/format';

interface Cfg { enabled: boolean; points_per_baht: number; baht_per_point: number; min_redeem: number; expiry_days: number; transfer_day_cap: number }
interface Tier { id?: number; tier: string; min_lifetime: number; earn_mult: number; redeem_mult: number }
interface Coalition { id: number; code: string; name: string; active: boolean; members: { tenant_id: number; active: boolean }[] }
interface Plan { id: number; code: string; name: string; tier: string; price: number; period_months: number; active: boolean }
interface Resolved { coalition: string; member_id: number; member_code: string; name: string | null; tier: string | null; balance: number; home_tenant_code: string | null; home_tenant_name: string | null; is_home: boolean }

export default function LoyaltyConfig() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<Cfg>({ queryKey: ['loy-cfg'], queryFn: () => api('/api/loyalty/config') });
  const tiersQ = useQuery<{ tiers: Tier[] }>({ queryKey: ['loy-tiers'], queryFn: () => api('/api/loyalty/tiers') });
  const coalQ = useQuery<{ coalitions: Coalition[] }>({ queryKey: ['coalitions'], queryFn: () => api('/api/coalition') });
  const plansQ = useQuery<{ plans: Plan[] }>({ queryKey: ['vip-plans'], queryFn: () => api('/api/loyalty/membership-plans') });
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [tierDraft, setTierDraft] = useState<Tier>({ tier: '', min_lifetime: 0, earn_mult: 1, redeem_mult: 1 });
  const [coalDraft, setCoalDraft] = useState({ code: '', name: '' });
  const [shopDraft, setShopDraft] = useState({ coalition_id: 0, tenant_id: 0 });
  const [planDraft, setPlanDraft] = useState({ code: '', name: '', tier: '', price: 0, period_months: 12 });
  const [sellDraft, setSellDraft] = useState({ member_id: 0, plan_id: 0 });
  const [sellMsg, setSellMsg] = useState('');
  const [resolvePhone, setResolvePhone] = useState('');
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [resolveErr, setResolveErr] = useState('');
  useEffect(() => { if (q.data && !cfg) setCfg(q.data); }, [q.data, cfg]);

  const save = useMutation({
    mutationFn: () => api('/api/loyalty/config', { method: 'PUT', body: JSON.stringify(cfg) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['loy-cfg'] }),
  });
  const saveTier = useMutation({
    mutationFn: (tr: Tier) => api('/api/loyalty/tiers', { method: 'POST', body: JSON.stringify(tr) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['loy-tiers'] }); setTierDraft({ tier: '', min_lifetime: 0, earn_mult: 1, redeem_mult: 1 }); },
  });
  const createCoal = useMutation({
    mutationFn: () => api('/api/coalition', { method: 'POST', body: JSON.stringify(coalDraft) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['coalitions'] }); setCoalDraft({ code: '', name: '' }); },
  });
  const addShop = useMutation({
    mutationFn: () => api(`/api/coalition/${shopDraft.coalition_id}/members`, { method: 'POST', body: JSON.stringify({ tenant_id: shopDraft.tenant_id }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['coalitions'] }),
  });
  const savePlan = useMutation({
    mutationFn: () => api('/api/loyalty/membership-plans', { method: 'POST', body: JSON.stringify(planDraft) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['vip-plans'] }); setPlanDraft({ code: '', name: '', tier: '', price: 0, period_months: 12 }); },
  });
  const sellVip = useMutation({
    mutationFn: () => api('/api/loyalty/memberships/sell', { method: 'POST', body: JSON.stringify(sellDraft) }),
    onSuccess: (r: any) => setSellMsg('✅ ' + t('ly.cf_sold', { plan: r.plan, member: r.member_id, end: r.end_date })),
    onError: (e) => setSellMsg((e as Error).message),
  });
  const doResolve = async () => {
    setResolved(null); setResolveErr('');
    try { setResolved(await api(`/api/coalition/resolve?phone=${encodeURIComponent(resolvePhone)}`)); }
    catch (e) { setResolveErr((e as Error).message); }
  };
  const set = (p: Partial<Cfg>) => setCfg((c) => (c ? { ...c, ...p } : c));

  return (
    <div>
      <PageHeader title={t('ly.cf_title')} description={t('ly.cf_desc')} />
      <div className="flex flex-wrap items-start gap-4">
        <StateView q={q}>
          {cfg && (
            <Card className="max-w-md gap-4 p-5">
              <Label className="gap-2">
                <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                <span className="font-semibold">{t('ly.cf_enable')}</span>
              </Label>
              <div className="grid gap-2">
                <Label>{t('ly.cf_ppb')}</Label>
                <Input type="number" value={cfg.points_per_baht} onChange={(e) => set({ points_per_baht: +e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>{t('ly.cf_bpp')}</Label>
                <Input type="number" value={cfg.baht_per_point} onChange={(e) => set({ baht_per_point: +e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>{t('ly.cf_min_redeem')}</Label>
                <Input type="number" value={cfg.min_redeem} onChange={(e) => set({ min_redeem: +e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>{t('ly.cf_expiry')}</Label>
                <Input type="number" value={cfg.expiry_days} onChange={(e) => set({ expiry_days: +e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>{t('ly.cf_transfer_cap')}</Label>
                <Input type="number" value={cfg.transfer_day_cap} onChange={(e) => set({ transfer_day_cap: +e.target.value })} />
              </div>
              <div>
                <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? t('ly.saving') : t('fin.save')}</Button>
              </div>
              {save.isSuccess && <Msg ok>✅ {t('ly.cf_saved')}</Msg>}
              {save.error && <Msg>{(save.error as Error).message}</Msg>}
            </Card>
          )}
        </StateView>

        {/* G13 (audit): staff point transfers over the threshold are staged for a DISTINCT approver. */}
        <TransferApprovals />

        {/* W1 (docs/27) — tier ladder: earn multiplier now applies on the REAL earn path (earnInTx) */}
        <Card className="max-w-lg gap-3 p-5">
          <div className="font-semibold">{t('ly.cf_tiers_title')}</div>
          <p className="text-sm text-muted-foreground">{t('ly.cf_tiers_desc')}</p>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-muted-foreground"><th className="py-1">{t('ly.lc_tier')}</th><th>{t('ly.cf_min_lifetime')}</th><th>{t('ly.cf_mult_earn')}</th><th>{t('ly.cf_mult_redeem')}</th></tr></thead>
            <tbody>
              {(tiersQ.data?.tiers ?? []).map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="py-1 font-medium">{row.tier}</td><td>{row.min_lifetime}</td><td>×{row.earn_mult}</td><td>×{row.redeem_mult}</td>
                </tr>
              ))}
              {!tiersQ.data?.tiers?.length && <tr><td colSpan={4} className="py-2 text-muted-foreground">{t('ly.cf_no_tiers')}</td></tr>}
            </tbody>
          </table>
          <div className="grid grid-cols-4 items-end gap-2">
            <div className="grid gap-1"><Label className="text-xs">{t('ly.lc_tier')}</Label><Input value={tierDraft.tier} onChange={(e) => setTierDraft({ ...tierDraft, tier: e.target.value })} placeholder="Gold" /></div>
            <div className="grid gap-1"><Label className="text-xs">{t('ly.cf_min')}</Label><Input type="number" value={tierDraft.min_lifetime} onChange={(e) => setTierDraft({ ...tierDraft, min_lifetime: +e.target.value })} /></div>
            <div className="grid gap-1"><Label className="text-xs">×earn</Label><Input type="number" step="0.1" value={tierDraft.earn_mult} onChange={(e) => setTierDraft({ ...tierDraft, earn_mult: +e.target.value })} /></div>
            <Button variant="outline" disabled={!tierDraft.tier || saveTier.isPending} onClick={() => saveTier.mutate(tierDraft)}>{t('ly.cf_add_edit')}</Button>
          </div>
          {saveTier.error && <Msg>{(saveTier.error as Error).message}</Msg>}
        </Card>

        {/* V4 (docs/29) — paid VIP membership plans (LYL-21): fee deferred to 2410, recognized monthly */}
        <Card className="max-w-lg gap-3 p-5">
          <div className="font-semibold">{t('ly.cf_vip_title')}</div>
          <p className="text-sm text-muted-foreground">{t('ly.cf_vip_desc')}</p>
          {(plansQ.data?.plans ?? []).map((pl) => (
            <div key={pl.id} className="rounded border p-2 text-sm">
              <span className="font-medium">{pl.code}</span> — {pl.name} · {t('ly.lc_tier')} {pl.tier} · {baht(pl.price)} / {pl.period_months} {t('ly.cf_months')} {!pl.active && t('ly.cf_closed')}
            </div>
          ))}
          <div className="grid grid-cols-5 items-end gap-2">
            <div className="grid gap-1"><Label className="text-xs">{t('ly.col_code')}</Label><Input value={planDraft.code} onChange={(e) => setPlanDraft({ ...planDraft, code: e.target.value })} placeholder="VIP12" /></div>
            <div className="grid gap-1"><Label className="text-xs">{t('ly.col_name')}</Label><Input value={planDraft.name} onChange={(e) => setPlanDraft({ ...planDraft, name: e.target.value })} /></div>
            <div className="grid gap-1"><Label className="text-xs">{t('ly.lc_tier')}</Label><Input value={planDraft.tier} onChange={(e) => setPlanDraft({ ...planDraft, tier: e.target.value })} placeholder="Platinum" /></div>
            <div className="grid gap-1"><Label className="text-xs">{t('ly.cf_price')}</Label><Input type="number" value={planDraft.price || ''} onChange={(e) => setPlanDraft({ ...planDraft, price: +e.target.value })} /></div>
            <Button variant="outline" disabled={!planDraft.code || !planDraft.tier || planDraft.price <= 0 || savePlan.isPending} onClick={() => savePlan.mutate()}>{t('ly.cf_add_plan')}</Button>
          </div>
          <div className="grid grid-cols-3 items-end gap-2 border-t pt-3">
            <div className="grid gap-1"><Label className="text-xs">{t('ly.cf_member_id')}</Label><Input type="number" value={sellDraft.member_id || ''} onChange={(e) => setSellDraft({ ...sellDraft, member_id: +e.target.value })} /></div>
            <div className="grid gap-1"><Label className="text-xs">{t('ly.cf_plan_id')}</Label><Input type="number" value={sellDraft.plan_id || ''} onChange={(e) => setSellDraft({ ...sellDraft, plan_id: +e.target.value })} /></div>
            <Button disabled={!sellDraft.member_id || !sellDraft.plan_id || sellVip.isPending} onClick={() => sellVip.mutate()}>{t('ly.cf_sell')}</Button>
          </div>
          {sellMsg && <Msg ok={sellMsg.startsWith('✅')}>{sellMsg}</Msg>}
          {(savePlan.error) && <Msg>{(savePlan.error as Error).message}</Msg>}
        </Card>

        {/* W2 (docs/27) — coalition network: earn/burn anywhere, settled through intercompany (LYL-19) */}
        <Card className="max-w-lg gap-3 p-5">
          <div className="font-semibold">{t('ly.cf_coal_title')}</div>
          <p className="text-sm text-muted-foreground">{t('ly.cf_coal_desc')}</p>
          {(coalQ.data?.coalitions ?? []).map((c) => (
            <div key={c.id} className="rounded border p-2 text-sm">
              <span className="font-medium">{c.code}</span> — {c.name} {!c.active && <span className="text-muted-foreground">{t('ly.cf_closed')}</span>}
              <span className="ml-2 text-muted-foreground">{t('ly.cf_shops_in')}: {c.members.filter((m) => m.active).map((m) => m.tenant_id).join(', ') || '—'}</span>
            </div>
          ))}
          <div className="grid grid-cols-3 items-end gap-2">
            <div className="grid gap-1"><Label className="text-xs">{t('ly.col_code')}</Label><Input value={coalDraft.code} onChange={(e) => setCoalDraft({ ...coalDraft, code: e.target.value })} placeholder="THAICOAL" /></div>
            <div className="grid gap-1"><Label className="text-xs">{t('ly.cf_coal_name')}</Label><Input value={coalDraft.name} onChange={(e) => setCoalDraft({ ...coalDraft, name: e.target.value })} /></div>
            <Button variant="outline" disabled={!coalDraft.code || !coalDraft.name || createCoal.isPending} onClick={() => createCoal.mutate()}>{t('ly.cf_create_coal')}</Button>
          </div>
          <div className="grid grid-cols-3 items-end gap-2">
            <div className="grid gap-1"><Label className="text-xs">{t('ly.cf_coal_id')}</Label><Input type="number" value={shopDraft.coalition_id || ''} onChange={(e) => setShopDraft({ ...shopDraft, coalition_id: +e.target.value })} /></div>
            <div className="grid gap-1"><Label className="text-xs">{t('ly.cf_shop_id')}</Label><Input type="number" value={shopDraft.tenant_id || ''} onChange={(e) => setShopDraft({ ...shopDraft, tenant_id: +e.target.value })} /></div>
            <Button variant="outline" disabled={!shopDraft.coalition_id || !shopDraft.tenant_id || addShop.isPending} onClick={() => addShop.mutate()}>{t('ly.cf_add_shop')}</Button>
          </div>
          {(createCoal.error || addShop.error) && <Msg>{((createCoal.error ?? addShop.error) as Error).message}</Msg>}
          <div className="border-t pt-3">
            <Label className="text-xs">{t('ly.cf_resolve_label')}</Label>
            <div className="mt-1 flex gap-2">
              <Input value={resolvePhone} onChange={(e) => setResolvePhone(e.target.value)} placeholder="08x-xxx-xxxx" />
              <Button variant="outline" disabled={!resolvePhone} onClick={doResolve}>{t('ly.search')}</Button>
            </div>
            {resolved && (
              <div className="mt-2 rounded border p-2 text-sm">
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">{t('ly.cf_coal_badge')} · {resolved.coalition}</span>
                <div className="mt-1">{resolved.member_code} — {resolved.name ?? '—'} · {resolved.tier ?? '—'} · {resolved.balance} {t('ly.an_pts')}</div>
                <div className="text-muted-foreground">{t('ly.cf_home_shop')}: {resolved.home_tenant_name ?? resolved.home_tenant_code ?? resolved.member_id} {resolved.is_home ? t('ly.cf_this_shop') : ''}</div>
              </div>
            )}
            {resolveErr && <Msg>{resolveErr}</Msg>}
          </div>
        </Card>
      </div>
    </div>
  );
}

// G13 (audit): a staff P2P point transfer above the threshold is staged as PendingApproval and executed
// only when a DISTINCT approver (approvals/exec) releases it (self-approval → 403 SOD_VIOLATION).
function TransferApprovals() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ pending: { req_no: string; from_member_id: number; to_member_id: number; points: number; note: string | null; requested_by: string }[] }>({
    queryKey: ['loy-transfers-pending'], queryFn: () => api('/api/loyalty/transfers/pending'),
  });
  const decide = useMutation({
    mutationFn: ({ reqNo, action }: { reqNo: string; action: 'approve' | 'reject' }) => api<any>(`/api/loyalty/transfers/${reqNo}/${action}`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (_r, v) => { setMsg(v.action === 'approve' ? '✅ ' + t('ly.tr_approved') : t('ly.tr_rejected')); q.refetch(); qc.invalidateQueries({ queryKey: ['loy-members'] }); },
    onError: (e) => setMsg((e as Error).message),
  });
  const [msg, setMsg] = useState('');
  const rows = q.data?.pending ?? [];
  if (!rows.length) return null;
  return (
    <Card className="max-w-lg gap-3 border-amber-300 p-5 dark:border-amber-700">
      <div className="font-semibold">{t('ly.tr_title')}</div>
      <p className="text-sm text-muted-foreground">{t('ly.tr_desc')}</p>
      {rows.map((r) => (
        <div key={r.req_no} className="flex flex-wrap items-center gap-2 rounded border p-2 text-sm">
          <span className="font-medium">{r.points} {t('ly.an_pts')}</span>
          <span className="text-muted-foreground">M-{r.from_member_id} → M-{r.to_member_id}</span>
          {r.note && <span className="text-xs text-muted-foreground">· {r.note}</span>}
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.requested_by}</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ reqNo: r.req_no, action: 'approve' })}>{t('fin.approve')}</Button>
            <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ reqNo: r.req_no, action: 'reject' })}>{t('fnx.bank.reject')}</Button>
          </div>
        </div>
      ))}
      {msg && <Msg ok={msg.startsWith('✅')}>{msg}</Msg>}
    </Card>
  );
}
