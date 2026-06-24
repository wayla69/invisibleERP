'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Search, Users, Coins, Wallet, Settings } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { statusVariant } from '@/components/ui';

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';
const SEGMENTS = ['', 'Champions', 'Loyal', 'At Risk', 'Lost', 'New'];

interface MemberRow { id: number; member_code: string; name: string | null; phone: string | null; card_no: string | null; tier: string | null; balance: number; lifetime: number; active: boolean; marketing_opt_in: boolean; segment: string | null }
interface ListResp { limit: number; offset: number; count: number; members: MemberRow[] }
interface Liability { control_account: string; fair_value_per_point: number; outstanding_points: number; active_members: number; liability_value: number; posted_liability: number; unposted_value: number; movements: { earned_points: number; redeemed_points: number; redeemed_value: number; adjusted_points: number } }

export default function MembersPage() {
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  const [segment, setSegment] = useState('');

  const liab = useQuery<Liability>({ queryKey: ['loy-liability'], queryFn: () => api('/api/loyalty/liability') });
  const list = useQuery<ListResp>({
    queryKey: ['loy-members', q, segment],
    queryFn: () => api(`/api/loyalty/members?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}${segment ? `&segment=${encodeURIComponent(segment)}` : ''}`),
  });

  return (
    <div>
      <PageHeader
        title="สมาชิก & แต้ม"
        description="ทะเบียนสมาชิก มุมมอง 360 องศา และหนี้สินแต้มสะสม"
        actions={<Link href="/loyalty"><Button variant="outline"><Settings className="size-4" /> ตั้งค่าแต้ม</Button></Link>}
      />

      <div className="space-y-6">
        <StateView q={liab}>
          {liab.data && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="สมาชิกที่ใช้งาน" value={num(liab.data.active_members)} icon={Users} tone="primary" />
              <StatCard label="แต้มคงค้าง" value={num(liab.data.outstanding_points)} icon={Coins} tone="info" hint={`มูลค่า ${liab.data.fair_value_per_point} บาท/แต้ม`} />
              <StatCard label={`หนี้สินแต้ม (บัญชี ${liab.data.control_account})`} value={baht(liab.data.liability_value)} icon={Wallet} tone="warning" hint={`ลงบัญชีแล้ว ${baht(liab.data.posted_liability)}${liab.data.unposted_value ? ` · รอลง ${baht(liab.data.unposted_value)}` : ''}`} />
              <StatCard label="แลกแล้ว (สะสม)" value={num(liab.data.movements.redeemed_points)} hint={`คิดเป็น ${baht(liab.data.movements.redeemed_value)}`} />
            </div>
          )}
        </StateView>

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); setQ(term.trim()); }}
        >
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="m-search">ค้นหา (ชื่อ / เบอร์ / บัตร / รหัส)</label>
            <Input id="m-search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="เช่น 0812345678 หรือ M-000123" className="w-72" />
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="m-seg">กลุ่ม RFM</label>
            <select id="m-seg" className={selectCls} value={segment} onChange={(e) => setSegment(e.target.value)}>
              {SEGMENTS.map((s) => <option key={s} value={s}>{s || 'ทั้งหมด'}</option>)}
            </select>
          </div>
          <Button type="submit"><Search className="size-4" /> ค้นหา</Button>
        </form>

        <StateView q={list}>
          {list.data && (
            <DataTable
              rows={list.data.members}
              rowKey={(r) => r.id}
              emptyText="ไม่พบสมาชิก"
              columns={[
                { key: 'member_code', label: 'รหัส', render: (r) => <Link className="text-primary underline-offset-2 hover:underline" href={`/loyalty/members/${r.id}`}>{r.member_code}</Link> },
                { key: 'name', label: 'ชื่อ', render: (r) => r.name ?? '—' },
                { key: 'phone', label: 'เบอร์', render: (r) => r.phone ?? '—' },
                { key: 'segment', label: 'กลุ่ม', render: (r) => r.segment ? <Badge variant={statusVariant(r.segment)}>{r.segment}</Badge> : <span className="text-muted-foreground">—</span> },
                { key: 'tier', label: 'ระดับ', render: (r) => r.tier ?? '—' },
                { key: 'balance', label: 'แต้มคงเหลือ', align: 'right', render: (r) => <span className="tabular">{num(r.balance)}</span> },
                { key: 'marketing_opt_in', label: 'รับข่าวสาร', align: 'center', render: (r) => r.marketing_opt_in ? <Badge variant="success">ยินยอม</Badge> : <Badge variant="muted">ปฏิเสธ</Badge> },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}
