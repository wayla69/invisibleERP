'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Banknote, ShoppingCart, Receipt, Users, Search, Cake, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { SimpleBarChart } from '@/components/charts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

// GET /api/crm/branch-kpi → { date, today: {revenue, orders, avg_order_value, active_members},
//   by_channel: { [channel]: { count, revenue } }, hourly_revenue: [{ hour, revenue }] }
interface BranchKpi {
  date: string;
  today: { revenue: number; orders: number; avg_order_value: number; active_members: number };
  by_channel: Record<string, { count: number; revenue: number }>;
  hourly_revenue: { hour: number; revenue: number }[];
}

// GET /api/crm/profile/:memberId → 360 view
interface Profile {
  member: { id: number; member_code: string; name: string; phone: string | null; balance: number; lifetime: number; tier: string | null };
  crm: null | { rfm_segment: string; total_orders: number; total_spend: number; rfm_recency: number; rfm_frequency: number; rfm_monetary: number; preferred_channel: string | null; avg_order_value: number; refreshed_at: string };
  recent_orders: { order_no: string; total: number; channel: string; opened_at: string }[];
}

export default function CrmPage() {
  return (
    <div>
      <PageHeader title="CRM 360" description="ภาพรวมประสิทธิภาพสาขาวันนี้ และมุมมองลูกค้า 360 องศา (RFM)" />
      <div className="space-y-6">
        <BranchKpi />
        <CustomerLookup />
        <Messaging />
      </div>
    </div>
  );
}

function BranchKpi() {
  const q = useQuery<BranchKpi>({ queryKey: ['crm-branch-kpi'], queryFn: () => api('/api/crm/branch-kpi') });

  const channelRows = Object.entries(q.data?.by_channel ?? {}).map(([channel, v]) => ({
    channel,
    count: v.count,
    revenue: v.revenue,
  }));
  const hourly = (q.data?.hourly_revenue ?? []).map((r) => ({ label: `${String(r.hour).padStart(2, '0')}:00`, revenue: r.revenue }));

  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>ข้อมูลประจำวันที่</span>
            <Badge variant="muted">{thaiDate(q.data.date)}</Badge>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="ยอดขายวันนี้" value={baht(q.data.today.revenue)} icon={Banknote} tone="primary" />
            <StatCard label="ออเดอร์วันนี้" value={num(q.data.today.orders)} icon={ShoppingCart} tone="info" />
            <StatCard label="ยอดเฉลี่ย/ออเดอร์" value={baht(q.data.today.avg_order_value)} icon={Receipt} tone="default" />
            <StatCard label="สมาชิกที่ใช้งานวันนี้" value={num(q.data.today.active_members)} icon={Users} tone="success" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">รายได้ตามช่องทาง (วันนี้)</CardTitle>
              </CardHeader>
              <CardContent>
                {channelRows.length ? (
                  <SimpleBarChart data={channelRows} xKey="channel" yKey="revenue" color="var(--chart-2)" fmt={(v) => baht(v)} />
                ) : (
                  <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">ยังไม่มียอดขายวันนี้</div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">รายได้รายชั่วโมง (วันนี้)</CardTitle>
              </CardHeader>
              <CardContent>
                {q.data.today.revenue > 0 ? (
                  <SimpleBarChart data={hourly} xKey="label" yKey="revenue" color="var(--chart-1)" fmt={(v) => baht(v)} />
                ) : (
                  <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">ยังไม่มียอดขายวันนี้</div>
                )}
              </CardContent>
            </Card>
          </div>

          {channelRows.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">สรุปตามช่องทาง</h3>
              <DataTable
                rows={channelRows}
                columns={[
                  { key: 'channel', label: 'ช่องทาง' },
                  { key: 'count', label: 'จำนวนออเดอร์', align: 'right', render: (r) => <span className="tabular">{num(r.count)}</span> },
                  { key: 'revenue', label: 'รายได้', align: 'right', render: (r) => <span className="tabular">{baht(r.revenue)}</span> },
                ]}
              />
            </div>
          )}
        </div>
      )}
    </StateView>
  );
}

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

interface Member { id: number; member_code: string; name: string | null; phone: string | null }
interface Msg { id: number; channel: string; recipient: string | null; body: string; status: string; provider: string | null; campaign: string | null; created_at: string }

function Messaging() {
  const qc = useQueryClient();
  const bdays = useQuery<{ window: string; count: number; members: Member[] }>({ queryKey: ['crm-birthdays'], queryFn: () => api('/api/loyalty/members/birthdays?window=month') });
  const log = useQuery<{ messages: Msg[] }>({ queryKey: ['crm-msg-log'], queryFn: () => api('/api/messaging/log?limit=20') });

  const [audience, setAudience] = useState('birthdays_today');
  const [segment, setSegment] = useState('Champions');
  const [channel, setChannel] = useState('sms');
  const [body, setBody] = useState('');

  const blast = useMutation({
    mutationFn: () => api<{ sent: number; skipped: number; targeted: number }>('/api/messaging/blast', { method: 'POST', body: JSON.stringify({ audience, segment: audience === 'segment' ? segment : undefined, channel, body }) }),
    onSuccess: (r) => { notifySuccess(`ส่งสำเร็จ ${r.sent} · ข้าม ${r.skipped} · เป้าหมาย ${r.targeted}`); setBody(''); qc.invalidateQueries({ queryKey: ['crm-msg-log'] }); },
    onError: (e: Error) => notifyError(e.message),
  });

  return (
    <Card className="gap-4">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Send className="size-4" /> การตลาด & ข้อความถึงลูกค้า</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border p-3">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Cake className="size-4 text-primary" /> วันเกิดเดือนนี้ ({num(bdays.data?.count ?? 0)})</h3>
            <StateView q={bdays}>
              <DataTable
                rows={bdays.data?.members ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: 'member_code', label: 'รหัส' },
                  { key: 'name', label: 'ชื่อ', render: (r) => r.name ?? '—' },
                  { key: 'phone', label: 'เบอร์', render: (r) => r.phone ?? '—' },
                ]}
                emptyState={{ icon: Cake, title: 'ไม่มีวันเกิดเดือนนี้' }}
              />
            </StateView>
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <h3 className="text-sm font-semibold">ส่งข้อความหากลุ่มลูกค้า</h3>
            <div className="flex flex-wrap gap-2">
              <select className={selectCls} aria-label="กลุ่มเป้าหมาย" value={audience} onChange={(e) => setAudience(e.target.value)}>
                <option value="birthdays_today">วันเกิดวันนี้</option>
                <option value="segment">กลุ่ม RFM</option>
                <option value="all">สมาชิกทั้งหมด</option>
              </select>
              {audience === 'segment' && (
                <select className={selectCls} aria-label="กลุ่ม RFM" value={segment} onChange={(e) => setSegment(e.target.value)}>
                  {['Champions', 'Loyal', 'At Risk', 'Lost', 'New'].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
              <select className={selectCls} aria-label="ช่องทางการส่ง" value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="sms">SMS</option>
                <option value="line">LINE</option>
                <option value="email">Email</option>
              </select>
            </div>
            <Input value={body} onChange={(e) => setBody(e.target.value)} aria-label="ข้อความถึงลูกค้า" placeholder="ข้อความ เช่น สุขสันต์วันเกิด รับส่วนลด 10%" />
            <Button disabled={!body.trim() || blast.isPending} onClick={() => blast.mutate()}><Send className="size-4" /> {blast.isPending ? 'กำลังส่ง…' : 'ส่งข้อความ'}</Button>
          </div>
        </div>

        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ประวัติการส่งล่าสุด</h3>
          <StateView q={log}>
            <DataTable
              rows={log.data?.messages ?? []}
              rowKey={(r) => r.id}
              columns={[
                { key: 'channel', label: 'ช่องทาง', render: (r) => <Badge variant="info">{r.channel}</Badge> },
                { key: 'recipient', label: 'ผู้รับ', render: (r) => r.recipient ?? '—' },
                { key: 'body', label: 'ข้อความ', render: (r) => <span className="line-clamp-1">{r.body}</span> },
                { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={r.status === 'sent' ? 'success' : r.status === 'skipped' ? 'muted' : 'destructive'}>{r.status}</Badge> },
                { key: 'provider', label: 'ผู้ให้บริการ', render: (r) => r.provider ?? '—' },
              ]}
              emptyState={{ icon: Send, title: 'ยังไม่มีการส่งข้อความ', description: 'ประวัติการส่งข้อความถึงลูกค้าจะแสดงที่นี่' }}
            />
          </StateView>
        </div>
      </CardContent>
    </Card>
  );
}

function CustomerLookup() {
  const [input, setInput] = useState('');
  const [memberId, setMemberId] = useState<number | null>(null);

  const q = useQuery<Profile>({
    queryKey: ['crm-profile', memberId],
    queryFn: () => api(`/api/crm/profile/${memberId}`),
    enabled: memberId != null,
  });

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">มุมมองลูกค้า 360 องศา</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); const id = Number(input); if (Number.isFinite(id) && id > 0) setMemberId(id); }}
        >
          <div className="grid gap-2">
            <Label htmlFor="crm-member">รหัสสมาชิก (Member ID)</Label>
            <Input id="crm-member" type="number" min="1" value={input} onChange={(e) => setInput(e.target.value)} placeholder="เช่น 1" className="w-40" />
          </div>
          <Button type="submit" disabled={!input.trim()}>
            <Search className="size-4" /> ค้นหา
          </Button>
        </form>

        {memberId != null && (
          <StateView q={q}>
            {q.data && (
              <div className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <StatCard
                    label={q.data.member.name || q.data.member.member_code}
                    value={
                      q.data.crm
                        ? <Badge variant={statusVariant(q.data.crm.rfm_segment)}>{q.data.crm.rfm_segment}</Badge>
                        : <Badge variant="muted">ยังไม่มีโปรไฟล์ RFM</Badge>
                    }
                    hint={`${q.data.member.member_code}${q.data.member.tier ? ` · ${q.data.member.tier}` : ''}`}
                  />
                  <StatCard label="ยอดสะสมตลอดชีพ" value={baht(q.data.member.lifetime)} tone="primary" />
                  <StatCard label="ยอดใช้จ่ายรวม" value={baht(q.data.crm?.total_spend ?? 0)} tone="info" hint={`${num(q.data.crm?.total_orders ?? 0)} ออเดอร์`} />
                  <StatCard label="ยอดเฉลี่ย/ออเดอร์" value={baht(q.data.crm?.avg_order_value ?? 0)} />
                </div>

                {q.data.crm && (
                  <div className="grid gap-4 sm:grid-cols-3">
                    <StatCard label="Recency (วันล่าสุด)" value={num(q.data.crm.rfm_recency)} hint="วันตั้งแต่ออเดอร์ล่าสุด" />
                    <StatCard label="Frequency (90 วัน)" value={num(q.data.crm.rfm_frequency)} hint="จำนวนครั้งที่ซื้อ" />
                    <StatCard label="Monetary (90 วัน)" value={baht(q.data.crm.rfm_monetary)} hint={q.data.crm.preferred_channel ? `ช่องทางหลัก: ${q.data.crm.preferred_channel}` : undefined} />
                  </div>
                )}

                <div>
                  <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ออเดอร์ล่าสุด</h3>
                  <DataTable
                    rows={q.data.recent_orders}
                    emptyState={{ icon: Receipt, title: 'ยังไม่มีออเดอร์', description: 'ลูกค้ารายนี้ยังไม่มีประวัติการสั่งซื้อ' }}
                    columns={[
                      { key: 'order_no', label: 'เลขที่' },
                      { key: 'channel', label: 'ช่องทาง', render: (r) => <Badge variant="info">{r.channel}</Badge> },
                      { key: 'opened_at', label: 'วันที่', render: (r) => thaiDate(r.opened_at) },
                      { key: 'total', label: 'ยอด', align: 'right', render: (r) => <span className="tabular">{baht(r.total)}</span> },
                    ]}
                  />
                </div>
              </div>
            )}
          </StateView>
        )}
      </CardContent>
    </Card>
  );
}
