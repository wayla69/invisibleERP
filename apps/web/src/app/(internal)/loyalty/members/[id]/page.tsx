'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ShieldCheck, Gift, Trophy, Target, UserPlus, History, Users, Award } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

interface Member { id: number; member_code: string; name: string | null; phone: string | null; card_no: string | null; email: string | null; birthday: string | null; marketing_opt_in: boolean; balance: number; lifetime: number; tier: string | null; active: boolean }
interface Profile { crm: null | { rfm_segment: string; total_orders: number; total_spend: number; rfm_recency: number; rfm_frequency: number; rfm_monetary: number; preferred_channel: string | null; avg_order_value: number; churn_risk: number | null; predicted_ltv: number | null; score_version: string | null } }
interface History { balance: number; history: { txn_date: string; txn_type: string; points: number; redeem_value: number; balance_after: number; ref_doc: string | null }[] }
interface Consents { member_id: number; marketing_opt_in: boolean; consents: { purpose: string; granted: boolean; source: string | null; updated_at: string | null }[] }

const PURPOSES: { key: string; label: string }[] = [
  { key: 'marketing', label: 'การตลาดทั่วไป' },
  { key: 'line', label: 'LINE' },
  { key: 'sms', label: 'SMS' },
  { key: 'email', label: 'อีเมล' },
  { key: 'profiling', label: 'วิเคราะห์พฤติกรรม (Profiling)' },
];

export default function Member360Page() {
  const { id } = useParams<{ id: string }>();
  const member = useQuery<Member>({ queryKey: ['loy-member', id], queryFn: () => api(`/api/loyalty/members/${id}`) });
  const profile = useQuery<Profile>({ queryKey: ['loy-member-profile', id], queryFn: () => api(`/api/crm/profile/${id}`) });
  const history = useQuery<History>({ queryKey: ['loy-member-history', id], queryFn: () => api(`/api/loyalty/members/${id}/history`) });

  return (
    <div>
      <PageHeader
        title={member.data?.name || member.data?.member_code || `สมาชิก #${id}`}
        description="มุมมองสมาชิก 360 องศา — แต้ม ประวัติ และความยินยอม (PDPA)"
        actions={<Link href="/loyalty/members"><Button variant="outline"><ArrowLeft className="size-4" /> รายชื่อสมาชิก</Button></Link>}
      />

      <div className="space-y-6">
        <StateView q={member}>
          {member.data && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label={member.data.member_code}
                value={profile.data?.crm ? <Badge variant={statusVariant(profile.data.crm.rfm_segment)}>{profile.data.crm.rfm_segment}</Badge> : <Badge variant="muted">ยังไม่มีโปรไฟล์ RFM</Badge>}
                hint={`${member.data.tier ?? 'Standard'}${member.data.active ? '' : ' · ปิดใช้งาน'}`}
              />
              <StatCard label="แต้มคงเหลือ" value={num(member.data.balance)} tone="primary" hint={member.data.phone ?? undefined} />
              <StatCard label="แต้มสะสมตลอดชีพ" value={num(member.data.lifetime)} tone="info" />
              <StatCard label="ยอดใช้จ่ายรวม" value={baht(profile.data?.crm?.total_spend ?? 0)} hint={`${num(profile.data?.crm?.total_orders ?? 0)} ออเดอร์`} />
              {profile.data?.crm?.churn_risk != null && (
                <StatCard
                  label="ความเสี่ยงหาย (Churn risk)"
                  value={<Badge variant={profile.data.crm.churn_risk >= 70 ? 'destructive' : profile.data.crm.churn_risk >= 40 ? 'warning' : 'success'}>{profile.data.crm.churn_risk}/100</Badge>}
                  hint={`LTV คาดการณ์ 12 ด. ~${baht(profile.data.crm.predicted_ltv ?? 0)} · สูตร ${profile.data.crm.score_version ?? '—'} (ค่าประมาณ)`}
                />
              )}
            </div>
          )}
        </StateView>

        <TierPanel id={id} />

        <ConsentPanel id={id} />

        <WalletPanel id={id} />

        <MissionsPanel id={id} />

        <ReferralsPanel id={id} />

        <Card className="gap-4">
          <CardHeader><CardTitle className="text-base">ประวัติแต้ม</CardTitle></CardHeader>
          <CardContent>
            <StateView q={history}>
              <DataTable
                rows={history.data?.history ?? []}
                rowKey={(_r, i) => i}
                emptyState={{ icon: History, title: 'ยังไม่มีรายการแต้ม', description: 'รายการได้แต้มและแลกแต้มของสมาชิกจะแสดงที่นี่' }}
                columns={[
                  { key: 'txn_date', label: 'วันที่', render: (r) => thaiDate(r.txn_date) },
                  { key: 'txn_type', label: 'ประเภท', render: (r) => <Badge variant={r.txn_type === 'Earn' ? 'success' : r.txn_type === 'Redeem' ? 'info' : 'muted'}>{r.txn_type}</Badge> },
                  { key: 'points', label: 'แต้ม', align: 'right', render: (r) => <span className="tabular">{r.points > 0 ? `+${num(r.points)}` : num(r.points)}</span> },
                  { key: 'redeem_value', label: 'มูลค่าแลก', align: 'right', render: (r) => r.redeem_value ? baht(r.redeem_value) : '—' },
                  { key: 'balance_after', label: 'คงเหลือ', align: 'right', render: (r) => <span className="tabular">{num(r.balance_after)}</span> },
                  { key: 'ref_doc', label: 'อ้างอิง', render: (r) => r.ref_doc ?? '—' },
                ]}
              />
            </StateView>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface Referral { id: number; code: string; status: string; referred_member_id: number | null; referred_phone: string | null; referrer_points: number; referred_points: number }

function ReferralsPanel({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery<{ referrals: Referral[] }>({ queryKey: ['loy-member-referrals', id], queryFn: () => api(`/api/loyalty/members/${id}/referrals`) });
  const [refId, setRefId] = useState('');
  const inval = () => { qc.invalidateQueries({ queryKey: ['loy-member-referrals', id] }); qc.invalidateQueries({ queryKey: ['loy-member', id] }); };
  const refer = useMutation({ mutationFn: () => api('/api/loyalty/referrals', { method: 'POST', body: JSON.stringify({ referrer_member_id: Number(id), referred_member_id: Number(refId) }) }), onSuccess: () => { notifySuccess('บันทึกการแนะนำแล้ว'); setRefId(''); inval(); }, onError: (e: Error) => notifyError(e.message) });
  const reward = useMutation({ mutationFn: (rid: number) => api(`/api/loyalty/referrals/${rid}/reward`, { method: 'POST', body: '{}' }), onSuccess: inval });
  return (
    <Card className="gap-4">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><UserPlus className="size-4" /> แนะนำเพื่อน (Referrals)</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); refer.mutate(); }}>
          <div className="grid gap-1.5"><Label htmlFor="ref-id">รหัสสมาชิกที่ถูกแนะนำ (Member ID)</Label><Input id="ref-id" type="number" min="1" value={refId} onChange={(e) => setRefId(e.target.value)} placeholder="เช่น 2" className="w-44" /></div>
          <Button type="submit" disabled={!refId.trim() || refer.isPending}>แนะนำ</Button>
        </form>
        <StateView q={q}>
          <DataTable
            rows={q.data?.referrals ?? []}
            rowKey={(r) => r.id}
            emptyState={{ icon: Users, title: 'ยังไม่มีการแนะนำ', description: 'กรอกรหัสสมาชิกที่ถูกแนะนำด้านบนเพื่อบันทึกการแนะนำเพื่อนรายการแรก' }}
            columns={[
              { key: 'code', label: 'รหัส', render: (r) => <span className="font-mono text-xs">{r.code}</span> },
              { key: 'referred', label: 'ผู้ถูกแนะนำ', render: (r) => r.referred_member_id != null ? `#${r.referred_member_id}` : (r.referred_phone ?? '—') },
              { key: 'points', label: 'แต้ม (แนะนำ/ถูกแนะนำ)', align: 'right', render: (r) => <span className="tabular">{num(r.referrer_points)} / {num(r.referred_points)}</span> },
              { key: 'status', label: 'สถานะ', align: 'center', render: (r) => r.status === 'rewarded' ? <Badge variant="success">ให้รางวัลแล้ว</Badge> : r.status === 'void' ? <Badge variant="destructive">ยกเลิก</Badge> : <Badge variant="muted">รอ</Badge> },
              { key: 'action', label: '', align: 'right', render: (r) => r.status === 'pending' && r.referred_member_id != null ? <Button variant="outline" onClick={() => reward.mutate(r.id)} disabled={reward.isPending}>ให้รางวัล</Button> : null },
            ]}
          />
        </StateView>
      </CardContent>
    </Card>
  );
}

interface Tier { tier: string | null; lifetime: number; current_tier: string | null; next_tier: string | null; to_next: number; progress_pct: number; history: { from_tier: string | null; to_tier: string; reason: string | null; effective_at: string }[] }

function TierPanel({ id }: { id: string }) {
  const q = useQuery<Tier>({ queryKey: ['loy-member-tier', id], queryFn: () => api(`/api/loyalty/members/${id}/tier`) });
  return (
    <Card className="gap-4">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Trophy className="size-4" /> ระดับสมาชิก (Tier journey)</CardTitle></CardHeader>
      <CardContent>
        <StateView q={q}>
          {q.data && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge variant="info">{q.data.current_tier ?? q.data.tier ?? 'Standard'}</Badge>
                {q.data.next_tier ? (
                  <span className="text-sm text-muted-foreground">อีก <span className="tabular font-medium text-foreground">{num(q.data.to_next)}</span> แต้มสะสม → <Badge variant="muted">{q.data.next_tier}</Badge></span>
                ) : <span className="text-sm text-success">ระดับสูงสุดแล้ว</span>}
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${q.data.progress_pct}%` }} /></div>
              {q.data.history.length > 0 && (
                <p className="text-xs text-muted-foreground">ปรับระดับล่าสุด: {q.data.history[0].from_tier ?? '—'} → {q.data.history[0].to_tier} ({thaiDate(q.data.history[0].effective_at)})</p>
              )}
            </div>
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

interface MemberMission { id: number; name: string; type: string; goal: number; reward_kind: string; reward_points: number; reward_coupon_value: number; progress: number; completed: boolean; claimed: boolean }

function MissionsPanel({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery<{ missions: MemberMission[] }>({ queryKey: ['loy-member-missions', id], queryFn: () => api(`/api/loyalty/members/${id}/missions`) });
  const inval = () => { qc.invalidateQueries({ queryKey: ['loy-member-missions', id] }); qc.invalidateQueries({ queryKey: ['loy-member', id] }); };
  const stamp = useMutation({ mutationFn: (mid: number) => api(`/api/loyalty/missions/${mid}/progress`, { method: 'POST', body: JSON.stringify({ member_id: Number(id), amount: 1 }) }), onSuccess: inval });
  const claim = useMutation({ mutationFn: (mid: number) => api(`/api/loyalty/missions/${mid}/claim`, { method: 'POST', body: JSON.stringify({ member_id: Number(id) }) }), onSuccess: inval });
  return (
    <Card className="gap-4">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Target className="size-4" /> ภารกิจ & แสตมป์ (Missions)</CardTitle></CardHeader>
      <CardContent>
        <StateView q={q}>
          {(q.data?.missions.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">ยังไม่มีภารกิจที่เปิดอยู่</p> : (
            <div className="space-y-3">
              {q.data?.missions.map((m) => (
                <div key={m.id} className="rounded-lg border p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{m.name}</span>
                    <span className="text-xs text-muted-foreground">{m.reward_kind === 'points' ? `+${num(m.reward_points)} แต้ม` : `คูปอง ${baht(m.reward_coupon_value)}`}</span>
                  </div>
                  <div className="mb-2 flex items-center gap-2">
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.round((m.progress / m.goal) * 100))}%` }} /></div>
                    <span className="tabular text-xs text-muted-foreground">{num(m.progress)}/{num(m.goal)}</span>
                  </div>
                  <div className="flex gap-2">
                    {m.claimed ? <Badge variant="muted">รับรางวัลแล้ว</Badge> : m.completed ? <Button onClick={() => claim.mutate(m.id)} disabled={claim.isPending}>รับรางวัล</Button> : <Button variant="outline" onClick={() => stamp.mutate(m.id)} disabled={stamp.isPending}>+ แสตมป์</Button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

interface Wallet { redemptions: { redemption_code: string; reward: string | null; reward_type: string | null; point_cost: number; value: number; status: string; used_ref: string | null }[]; coupons: { code: string; kind: string; value: number; source: string | null; status: string }[] }

function WalletPanel({ id }: { id: string }) {
  const q = useQuery<Wallet>({ queryKey: ['loy-member-wallet', id], queryFn: () => api(`/api/loyalty/members/${id}/wallet`) });
  const statusBadge = (s: string) => s === 'used' ? 'muted' : s === 'issued' || s === 'active' ? 'success' : 'destructive';
  return (
    <Card className="gap-4">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Gift className="size-4" /> ของรางวัล & คูปอง (Wallet)</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        <StateView q={q}>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">ของรางวัลที่แลก (Redemptions)</h3>
            <DataTable
              rows={q.data?.redemptions ?? []}
              rowKey={(r) => r.redemption_code}
              emptyState={{ icon: Award, title: 'ยังไม่มีการแลกของรางวัล', description: 'ของรางวัลที่สมาชิกแลกด้วยแต้มจะแสดงที่นี่' }}
              columns={[
                { key: 'redemption_code', label: 'รหัส', render: (r) => <span className="font-mono text-xs">{r.redemption_code}</span> },
                { key: 'reward', label: 'รางวัล', render: (r) => r.reward ?? '—' },
                { key: 'point_cost', label: 'แต้ม', align: 'right', render: (r) => <span className="tabular">{num(r.point_cost)}</span> },
                { key: 'value', label: 'มูลค่า', align: 'right', render: (r) => baht(r.value) },
                { key: 'status', label: 'สถานะ', align: 'center', render: (r) => <Badge variant={statusBadge(r.status)}>{r.status}</Badge> },
              ]}
            />
          </div>
          {(q.data?.coupons?.length ?? 0) > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-muted-foreground">คูปอง (Coupons)</h3>
              <DataTable
                rows={q.data?.coupons ?? []}
                rowKey={(r) => r.code}
                columns={[
                  { key: 'code', label: 'รหัส', render: (r) => <span className="font-mono text-xs">{r.code}</span> },
                  { key: 'kind', label: 'ชนิด', render: (r) => <Badge variant="info">{r.kind}</Badge> },
                  { key: 'value', label: 'มูลค่า', align: 'right', render: (r) => baht(r.value) },
                  { key: 'source', label: 'ที่มา', render: (r) => r.source ?? '—' },
                  { key: 'status', label: 'สถานะ', align: 'center', render: (r) => <Badge variant={statusBadge(r.status)}>{r.status}</Badge> },
                ]}
              />
            </div>
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

function ConsentPanel({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery<Consents>({ queryKey: ['loy-member-consents', id], queryFn: () => api(`/api/loyalty/members/${id}/consents`) });
  const set = useMutation({
    mutationFn: (v: { purpose: string; granted: boolean }) => api(`/api/loyalty/members/${id}/consents`, { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['loy-member-consents', id] }),
  });
  const granted = (purpose: string) => q.data?.consents.find((c) => c.purpose === purpose)?.granted ?? (purpose === 'marketing' ? q.data?.marketing_opt_in : false) ?? false;

  return (
    <Card className="gap-4">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-4" /> ความยินยอม (PDPA)</CardTitle></CardHeader>
      <CardContent>
        <StateView q={q}>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {PURPOSES.map((p) => {
              const on = granted(p.key);
              return (
                <label key={p.key} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <span className="text-sm">{p.label}</span>
                  <input
                    type="checkbox"
                    checked={!!on}
                    disabled={set.isPending}
                    onChange={(e) => set.mutate({ purpose: p.key, granted: e.target.checked })}
                  />
                </label>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">การปิด “การตลาดทั่วไป” จะหยุดการส่งข้อความการตลาดถึงสมาชิกรายนี้ทันที (ใช้ร่วมกับระบบส่งข้อความ)</p>
        </StateView>
      </CardContent>
    </Card>
  );
}
