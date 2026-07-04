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
          <div className="font-semibold">สมาชิก VIP แบบเสียเงิน (Paid membership)</div>
          <p className="text-sm text-muted-foreground">ขายแพ็กเกจระดับสมาชิก — เก็บเงินวันนี้ รับรู้รายได้รายเดือนตามมาตรฐาน และระดับหมดสิทธิ์เองเมื่อไม่ต่อ</p>
          {(plansQ.data?.plans ?? []).map((pl) => (
            <div key={pl.id} className="rounded border p-2 text-sm">
              <span className="font-medium">{pl.code}</span> — {pl.name} · ระดับ {pl.tier} · ฿{pl.price.toLocaleString()} / {pl.period_months} เดือน {!pl.active && '(ปิด)'}
            </div>
          ))}
          <div className="grid grid-cols-5 items-end gap-2">
            <div className="grid gap-1"><Label className="text-xs">รหัส</Label><Input value={planDraft.code} onChange={(e) => setPlanDraft({ ...planDraft, code: e.target.value })} placeholder="VIP12" /></div>
            <div className="grid gap-1"><Label className="text-xs">ชื่อ</Label><Input value={planDraft.name} onChange={(e) => setPlanDraft({ ...planDraft, name: e.target.value })} /></div>
            <div className="grid gap-1"><Label className="text-xs">ระดับ</Label><Input value={planDraft.tier} onChange={(e) => setPlanDraft({ ...planDraft, tier: e.target.value })} placeholder="Platinum" /></div>
            <div className="grid gap-1"><Label className="text-xs">ราคา ฿</Label><Input type="number" value={planDraft.price || ''} onChange={(e) => setPlanDraft({ ...planDraft, price: +e.target.value })} /></div>
            <Button variant="outline" disabled={!planDraft.code || !planDraft.tier || planDraft.price <= 0 || savePlan.isPending} onClick={() => savePlan.mutate()}>เพิ่มแผน</Button>
          </div>
          <div className="grid grid-cols-3 items-end gap-2 border-t pt-3">
            <div className="grid gap-1"><Label className="text-xs">สมาชิก (id)</Label><Input type="number" value={sellDraft.member_id || ''} onChange={(e) => setSellDraft({ ...sellDraft, member_id: +e.target.value })} /></div>
            <div className="grid gap-1"><Label className="text-xs">แผน (id)</Label><Input type="number" value={sellDraft.plan_id || ''} onChange={(e) => setSellDraft({ ...sellDraft, plan_id: +e.target.value })} /></div>
            <Button disabled={!sellDraft.member_id || !sellDraft.plan_id || sellVip.isPending} onClick={() => sellVip.mutate()}>ขายแพ็กเกจ</Button>
          </div>
          {sellMsg && <Msg ok={sellMsg.startsWith('✅')}>{sellMsg}</Msg>}
          {(savePlan.error) && <Msg>{(savePlan.error as Error).message}</Msg>}
        </Card>

        {/* W2 (docs/27) — coalition network: earn/burn anywhere, settled through intercompany (LYL-19) */}
        <Card className="max-w-lg gap-3 p-5">
          <div className="font-semibold">เครือข่ายพันธมิตรแต้ม (Coalition)</div>
          <p className="text-sm text-muted-foreground">สมาชิกสะสม/แลกแต้มได้ทุกร้านในเครือข่าย — แต้มอยู่ที่ร้านบ้าน ทุกการเคลื่อนไหวข้ามร้านตั้งหนี้ระหว่างกิจการอัตโนมัติ (ตั้งค่าโดยสำนักงานใหญ่)</p>
          {(coalQ.data?.coalitions ?? []).map((c) => (
            <div key={c.id} className="rounded border p-2 text-sm">
              <span className="font-medium">{c.code}</span> — {c.name} {!c.active && <span className="text-muted-foreground">(ปิด)</span>}
              <span className="ml-2 text-muted-foreground">ร้านในเครือ: {c.members.filter((m) => m.active).map((m) => m.tenant_id).join(', ') || '—'}</span>
            </div>
          ))}
          <div className="grid grid-cols-3 items-end gap-2">
            <div className="grid gap-1"><Label className="text-xs">รหัส</Label><Input value={coalDraft.code} onChange={(e) => setCoalDraft({ ...coalDraft, code: e.target.value })} placeholder="THAICOAL" /></div>
            <div className="grid gap-1"><Label className="text-xs">ชื่อเครือข่าย</Label><Input value={coalDraft.name} onChange={(e) => setCoalDraft({ ...coalDraft, name: e.target.value })} /></div>
            <Button variant="outline" disabled={!coalDraft.code || !coalDraft.name || createCoal.isPending} onClick={() => createCoal.mutate()}>สร้างเครือข่าย</Button>
          </div>
          <div className="grid grid-cols-3 items-end gap-2">
            <div className="grid gap-1"><Label className="text-xs">เครือข่าย (id)</Label><Input type="number" value={shopDraft.coalition_id || ''} onChange={(e) => setShopDraft({ ...shopDraft, coalition_id: +e.target.value })} /></div>
            <div className="grid gap-1"><Label className="text-xs">ร้าน (tenant id)</Label><Input type="number" value={shopDraft.tenant_id || ''} onChange={(e) => setShopDraft({ ...shopDraft, tenant_id: +e.target.value })} /></div>
            <Button variant="outline" disabled={!shopDraft.coalition_id || !shopDraft.tenant_id || addShop.isPending} onClick={() => addShop.mutate()}>เพิ่มร้านเข้าเครือ</Button>
          </div>
          {(createCoal.error || addShop.error) && <Msg>{((createCoal.error ?? addShop.error) as Error).message}</Msg>}
          <div className="border-t pt-3">
            <Label className="text-xs">ค้นหาสมาชิกเครือข่ายจากเบอร์โทร (หน้าร้านพันธมิตร)</Label>
            <div className="mt-1 flex gap-2">
              <Input value={resolvePhone} onChange={(e) => setResolvePhone(e.target.value)} placeholder="08x-xxx-xxxx" />
              <Button variant="outline" disabled={!resolvePhone} onClick={doResolve}>ค้นหา</Button>
            </div>
            {resolved && (
              <div className="mt-2 rounded border p-2 text-sm">
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">เครือข่ายพันธมิตรแต้ม · {resolved.coalition}</span>
                <div className="mt-1">{resolved.member_code} — {resolved.name ?? '—'} · {resolved.tier ?? '—'} · {resolved.balance} แต้ม</div>
                <div className="text-muted-foreground">ร้านบ้าน: {resolved.home_tenant_name ?? resolved.home_tenant_code ?? resolved.member_id} {resolved.is_home ? '(ร้านนี้)' : ''}</div>
              </div>
            )}
            {resolveErr && <Msg>{resolveErr}</Msg>}
          </div>
        </Card>
      </div>
    </div>
  );
}
