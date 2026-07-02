'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
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
interface Resolved { coalition: string; member_id: number; member_code: string; name: string | null; tier: string | null; balance: number; home_tenant_code: string | null; home_tenant_name: string | null; is_home: boolean }

export default function LoyaltyConfig() {
  const qc = useQueryClient();
  const q = useQuery<Cfg>({ queryKey: ['loy-cfg'], queryFn: () => api('/api/loyalty/config') });
  const tiersQ = useQuery<{ tiers: Tier[] }>({ queryKey: ['loy-tiers'], queryFn: () => api('/api/loyalty/tiers') });
  const coalQ = useQuery<{ coalitions: Coalition[] }>({ queryKey: ['coalitions'], queryFn: () => api('/api/coalition') });
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [tierDraft, setTierDraft] = useState<Tier>({ tier: '', min_lifetime: 0, earn_mult: 1, redeem_mult: 1 });
  const [coalDraft, setCoalDraft] = useState({ code: '', name: '' });
  const [shopDraft, setShopDraft] = useState({ coalition_id: 0, tenant_id: 0 });
  const [resolvePhone, setResolvePhone] = useState('');
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [resolveErr, setResolveErr] = useState('');
  useEffect(() => { if (q.data && !cfg) setCfg(q.data); }, [q.data, cfg]);

  const save = useMutation({
    mutationFn: () => api('/api/loyalty/config', { method: 'PUT', body: JSON.stringify(cfg) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['loy-cfg'] }),
  });
  const saveTier = useMutation({
    mutationFn: (t: Tier) => api('/api/loyalty/tiers', { method: 'POST', body: JSON.stringify(t) }),
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
  const doResolve = async () => {
    setResolved(null); setResolveErr('');
    try { setResolved(await api(`/api/coalition/resolve?phone=${encodeURIComponent(resolvePhone)}`)); }
    catch (e) { setResolveErr((e as Error).message); }
  };
  const set = (p: Partial<Cfg>) => setCfg((c) => (c ? { ...c, ...p } : c));

  return (
    <div>
      <PageHeader title="ตั้งค่าระบบสะสมแต้ม" description="กำหนดอัตราการสะสม/แลกแต้ม เพดานโอนแต้ม และตัวคูณตามระดับสมาชิก" />
      <div className="flex flex-wrap items-start gap-4">
        <StateView q={q}>
          {cfg && (
            <Card className="max-w-md gap-4 p-5">
              <Label className="gap-2">
                <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                <span className="font-semibold">เปิดใช้งานระบบสะสมแต้ม</span>
              </Label>
              <div className="grid gap-2">
                <Label>แต้มต่อบาท (earn)</Label>
                <Input type="number" value={cfg.points_per_baht} onChange={(e) => set({ points_per_baht: +e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>บาทต่อแต้ม (redeem)</Label>
                <Input type="number" value={cfg.baht_per_point} onChange={(e) => set({ baht_per_point: +e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>แต้มขั้นต่ำที่แลกได้</Label>
                <Input type="number" value={cfg.min_redeem} onChange={(e) => set({ min_redeem: +e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>อายุแต้ม (วัน, 0 = ไม่หมดอายุ)</Label>
                <Input type="number" value={cfg.expiry_days} onChange={(e) => set({ expiry_days: +e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>เพดานโอนแต้มต่อวัน (แต้ม, 0 = ปิดการโอน)</Label>
                <Input type="number" value={cfg.transfer_day_cap} onChange={(e) => set({ transfer_day_cap: +e.target.value })} />
              </div>
              <div>
                <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'กำลังบันทึก…' : 'บันทึก'}</Button>
              </div>
              {save.isSuccess && <Msg ok>✅ บันทึกแล้ว</Msg>}
              {save.error && <Msg>{(save.error as Error).message}</Msg>}
            </Card>
          )}
        </StateView>

        {/* W1 (docs/27) — tier ladder: earn multiplier now applies on the REAL earn path (earnInTx) */}
        <Card className="max-w-lg gap-3 p-5">
          <div className="font-semibold">ระดับสมาชิก (ตัวคูณแต้ม)</div>
          <p className="text-sm text-muted-foreground">สมาชิกระดับสูงสะสมแต้มเร็วขึ้น เช่น Gold ×2 — ตัวคูณมีผลกับการสะสมจริงที่จุดขาย</p>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-muted-foreground"><th className="py-1">ระดับ</th><th>แต้มสะสมขั้นต่ำ</th><th>ตัวคูณ earn</th><th>ตัวคูณ redeem</th></tr></thead>
            <tbody>
              {(tiersQ.data?.tiers ?? []).map((t) => (
                <tr key={t.id} className="border-t">
                  <td className="py-1 font-medium">{t.tier}</td><td>{t.min_lifetime}</td><td>×{t.earn_mult}</td><td>×{t.redeem_mult}</td>
                </tr>
              ))}
              {!tiersQ.data?.tiers?.length && <tr><td colSpan={4} className="py-2 text-muted-foreground">ยังไม่กำหนดระดับ — สมาชิกทุกคนสะสม ×1</td></tr>}
            </tbody>
          </table>
          <div className="grid grid-cols-4 items-end gap-2">
            <div className="grid gap-1"><Label className="text-xs">ระดับ</Label><Input value={tierDraft.tier} onChange={(e) => setTierDraft({ ...tierDraft, tier: e.target.value })} placeholder="Gold" /></div>
            <div className="grid gap-1"><Label className="text-xs">ขั้นต่ำ</Label><Input type="number" value={tierDraft.min_lifetime} onChange={(e) => setTierDraft({ ...tierDraft, min_lifetime: +e.target.value })} /></div>
            <div className="grid gap-1"><Label className="text-xs">×earn</Label><Input type="number" step="0.1" value={tierDraft.earn_mult} onChange={(e) => setTierDraft({ ...tierDraft, earn_mult: +e.target.value })} /></div>
            <Button variant="outline" disabled={!tierDraft.tier || saveTier.isPending} onClick={() => saveTier.mutate(tierDraft)}>เพิ่ม/แก้ไข</Button>
          </div>
          {saveTier.error && <Msg>{(saveTier.error as Error).message}</Msg>}
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
