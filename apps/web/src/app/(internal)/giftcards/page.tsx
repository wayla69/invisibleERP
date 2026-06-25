'use client';

import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { CreditCard, Wallet, BadgeCheck, Receipt, X } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

// Gift-card / store-credit register: every card + the OUTSTANDING liability (Σ Active balances = the
// unredeemed 2200 Customer-Deposits exposure) + per-card txn drill-down. The list/audit view the
// gift-card backend (issue/redeem/balance) never had — finance can size the liability, ops can look a card up.

const selectCls =
  'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

const statusTone = (s: string): 'success' | 'secondary' | 'destructive' =>
  s === 'Active' ? 'success' : s === 'Void' ? 'destructive' : 'secondary';
const statusTh: Record<string, string> = { Active: 'ใช้งานได้', Redeemed: 'ใช้หมดแล้ว', Void: 'ยกเลิก' };

interface GiftCard {
  card_no: string; initial_amount: number; balance: number; status: string; currency: string;
  note: string | null; issued_by: string | null; created_at: string | null;
}
interface CardsResp { cards: GiftCard[]; count: number; total: number; active: number; outstanding: number }

export default function GiftCardsPage() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [pick, setPick] = useState<string | null>(null);

  const q = useQuery<CardsResp>({
    queryKey: ['gift-cards', status, search],
    queryFn: () => api(`/api/pos/gift-cards?${new URLSearchParams({ ...(status && { status }), ...(search && { search }) })}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;

  return (
    <div>
      <PageHeader
        title="บัตรของขวัญ / เครดิตร้าน (Gift Cards)"
        description="ทะเบียนบัตรของขวัญและเครดิตร้าน — ยอดคงค้าง (ภาระหนี้ 2200 เงินรับล่วงหน้า), สถานะ และประวัติการใช้รายใบ"
      />
      <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="กรองตามสถานะ">
            <option value="">ทุกสถานะ</option>
            <option value="Active">ใช้งานได้ (Active)</option>
            <option value="Redeemed">ใช้หมดแล้ว (Redeemed)</option>
            <option value="Void">ยกเลิก (Void)</option>
          </select>
          <Input className="w-full sm:w-64" placeholder="ค้นหาเลขบัตร (GC-…)" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="ค้นหาเลขบัตร" />
          {q.isFetching && !q.isLoading && <span className="text-xs text-muted-foreground">กำลังอัปเดต…</span>}
        </div>
        <StateView q={q}>
          {d && (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <StatCard label="บัตรทั้งหมด" value={num(d.total)} icon={CreditCard} tone="primary" hint={`แสดง ${num(d.count)} ใบ`} />
                <StatCard label="ใช้งานได้ (Active)" value={num(d.active)} icon={BadgeCheck} tone="success" />
                <StatCard label="ยอดคงค้างรวม (Outstanding)" value={`฿${num(d.outstanding)}`} icon={Wallet} tone={d.outstanding > 0 ? 'warning' : 'success'} hint="ภาระหนี้บัตร = บัญชี 2200 ที่ยังไม่ถูกใช้" />
              </div>
              <DataTable
                rows={d.cards}
                rowKey={(r) => r.card_no}
                emptyState={{ icon: CreditCard, title: 'ยังไม่มีบัตรของขวัญ', description: 'ออกบัตรจากหน้าขายหน้าร้าน (POS) — บัตรที่ออก/เครดิตคืนสินค้าจะปรากฏที่นี่' }}
                columns={[
                  { key: 'card_no', label: 'เลขบัตร', render: (r) => <span className="font-mono text-sm">{r.card_no}</span> },
                  { key: 'initial_amount', label: 'มูลค่าตั้งต้น', align: 'right', render: (r) => <span className="tabular text-muted-foreground">฿{num(r.initial_amount)}</span> },
                  { key: 'balance', label: 'ยอดคงเหลือ', align: 'right', render: (r) => <span className={cn('tabular font-medium', r.balance > 0 && 'text-success')}>฿{num(r.balance)}</span> },
                  { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusTone(r.status)}>{statusTh[r.status] ?? r.status}</Badge> },
                  { key: 'issued_by', label: 'ออกโดย', render: (r) => r.issued_by ?? '—' },
                  { key: 'created_at', label: 'วันที่ออก', render: (r) => (r.created_at ? thaiDate(r.created_at) : '—') },
                  { key: 'act', label: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" onClick={() => setPick(r.card_no)}><Receipt className="size-4" />ประวัติ</Button> },
                ]}
              />
            </>
          )}
        </StateView>
        {pick && <TxnHistory cardNo={pick} onClose={() => setPick(null)} />}
      </div>
    </div>
  );
}

interface Txn { txn_no: string; type: string; amount: number; balance_after: number; ref_doc: string | null; created_at: string | null }
interface TxnResp { card_no: string; initial_amount: number; balance: number; status: string; txns: Txn[] }

function TxnHistory({ cardNo, onClose }: { cardNo: string; onClose: () => void }) {
  const q = useQuery<TxnResp>({ queryKey: ['gift-card-txns', cardNo], queryFn: () => api(`/api/pos/gift-cards/${encodeURIComponent(cardNo)}/txns`) });
  const d = q.data;
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="font-semibold">ประวัติการใช้บัตร <span className="font-mono">{cardNo}</span></h3>
          {d && <p className="text-sm text-muted-foreground">ตั้งต้น ฿{num(d.initial_amount)} · คงเหลือ ฿{num(d.balance)} · {statusTh[d.status] ?? d.status}</p>}
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="ปิด"><X className="size-4" /></Button>
      </div>
      <StateView q={q}>
        {d && (
          <DataTable
            rows={d.txns}
            rowKey={(r) => r.txn_no}
            emptyState={{ icon: Receipt, title: 'ไม่มีรายการ', description: 'บัตรนี้ยังไม่มีความเคลื่อนไหว' }}
            columns={[
              { key: 'created_at', label: 'วันที่', render: (r) => (r.created_at ? thaiDate(r.created_at) : '—') },
              { key: 'type', label: 'ประเภท', render: (r) => <Badge variant={r.type === 'Redeem' ? 'destructive' : 'success'}>{r.type}</Badge> },
              { key: 'amount', label: 'จำนวน', align: 'right', render: (r) => <span className={cn('tabular font-medium', r.amount < 0 ? 'text-destructive' : 'text-success')}>{r.amount < 0 ? '−' : '+'}฿{num(Math.abs(r.amount))}</span> },
              { key: 'balance_after', label: 'คงเหลือหลังรายการ', align: 'right', render: (r) => <span className="tabular">฿{num(r.balance_after)}</span> },
              { key: 'ref_doc', label: 'เอกสารอ้างอิง', render: (r) => <span className="font-mono text-xs text-muted-foreground">{r.ref_doc ?? '—'}</span> },
            ]}
          />
        )}
      </StateView>
    </Card>
  );
}
