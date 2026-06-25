'use client';

import { useEffect, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Banknote, PackageCheck, Receipt, RotateCcw, SearchX, Undo2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ModulePage } from '@/components/module-page';
import { SearchInput } from '@/components/search-input';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

// Returns register (REV-07): tenant-wide view of POS returns/refunds for ops · finance · audit —
// refund method, amount, restocked status, GL journal + credit-note links, with a per-return drill-down.

const selectCls =
  'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

interface Ret {
  return_no: string; sale_no: string; refund_no: string | null; refund_method: string | null;
  subtotal_returned: number; vat_returned: number; total_returned: number; restocked: boolean;
  journal_no: string | null; credit_note_no: string | null; status: string; return_date: string | null;
}
interface RegResp { returns: Ret[]; count: number; total_count: number; total_refunded: number; restocked_count: number }
interface RetDetail extends Ret { items: { item_id: string; name: string; qty: number; amount: number; restocked: boolean }[] }

export default function ReturnsPage() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [method, setMethod] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(search), 300); return () => clearTimeout(t); }, [search]);

  const q = useQuery<RegResp>({
    queryKey: ['returns-register', debounced, method],
    queryFn: () => api(`/api/pos/returns?limit=200${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}${method ? `&method=${encodeURIComponent(method)}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const filtering = debounced.length > 0 || !!method;

  return (
    <ModulePage
      title="คืนสินค้า & คืนเงิน (Returns Register)"
      description="ทะเบียนการคืนสินค้า/คืนเงินทั้งหมด — วิธีคืนเงิน, ยอดคืน, การคืนเข้าสต๊อก, ลิงก์บัญชี (REV-07)"
      query={q}
      toolbar={
        <>
          <SearchInput value={search} onChange={setSearch} placeholder="ค้นหา เลขที่คืน / เลขที่ขาย…" ariaLabel="ค้นหารายการคืน" count={d ? `${num(d.count)} รายการ` : undefined} />
          <select className={selectCls} value={method} onChange={(e) => setMethod(e.target.value)} aria-label="กรองตามวิธีคืนเงิน">
            <option value="">ทุกวิธีคืนเงิน</option>
            <option value="Cash">เงินสด (Cash)</option>
            <option value="Transfer">โอน (Transfer)</option>
            <option value="Card">บัตร (Card)</option>
            <option value="StoreCredit">เครดิตร้าน (Store credit)</option>
          </select>
          {q.isFetching && !q.isLoading && <span className="text-xs text-muted-foreground">กำลังอัปเดต…</span>}
        </>
      }
      stats={
        d && (
          <>
            <StatCard label="จำนวนรายการคืน" value={num(d.total_count)} icon={Undo2} tone="primary" />
            <StatCard label="ยอดคืนเงินรวม" value={`฿${num(d.total_refunded)}`} icon={Banknote} hint="รวมภาษี" />
            <StatCard label="คืนเข้าสต๊อก" value={`${num(d.restocked_count)} / ${num(d.total_count)}`} icon={PackageCheck} tone={d.restocked_count > 0 ? 'success' : 'default'} hint="รายการที่คืนของเข้าคลัง" />
          </>
        )
      }
      statsClassName="xl:grid-cols-3"
    >
      {d && (
        <>
          <DataTable
            rows={d.returns}
            rowKey={(r) => r.return_no}
            emptyState={
              filtering
                ? { icon: SearchX, title: 'ไม่พบรายการคืนที่ตรงกับตัวกรอง', description: 'ลองปรับคำค้นหา หรือล้างตัวกรอง', action: <Button variant="outline" size="sm" onClick={() => { setSearch(''); setMethod(''); }}>ล้างตัวกรอง</Button> }
                : { icon: RotateCcw, title: 'ยังไม่มีรายการคืนสินค้า', description: 'การคืน/คืนเงินจะถูกบันทึกจากหน้า POS แล้วแสดงที่นี่' }
            }
            columns={[
              { key: 'return_no', label: 'เลขที่คืน', render: (r) => <button onClick={() => setSelected(r.return_no)} className={cn('font-medium text-primary hover:underline', selected === r.return_no && 'underline')}>{r.return_no}</button> },
              { key: 'return_date', label: 'วันที่', render: (r) => (r.return_date ? thaiDate(r.return_date) : '—') },
              { key: 'sale_no', label: 'เลขที่ขาย' },
              { key: 'refund_method', label: 'วิธีคืนเงิน', render: (r) => <Badge variant="outline">{r.refund_method ?? '—'}</Badge> },
              { key: 'total_returned', label: 'ยอดคืน', align: 'right', render: (r) => <span className="tabular font-medium">฿{num(r.total_returned)}</span> },
              { key: 'restocked', label: 'คืนสต๊อก', render: (r) => (r.restocked ? <Badge variant="secondary">คืนแล้ว</Badge> : <span className="text-muted-foreground">—</span>) },
              { key: 'journal_no', label: 'บัญชี (JE)', render: (r) => r.journal_no ?? '—' },
            ]}
          />
          {selected && <ReturnDetail returnNo={selected} onClose={() => setSelected(null)} />}
        </>
      )}
    </ModulePage>
  );
}

function ReturnDetail({ returnNo, onClose }: { returnNo: string; onClose: () => void }) {
  const q = useQuery<RetDetail>({ queryKey: ['return-detail', returnNo], queryFn: () => api(`/api/pos/returns/${encodeURIComponent(returnNo)}`) });
  const r = q.data;
  return (
    <Card className="mt-5 gap-3 p-5">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-semibold"><Receipt className="size-4" /> รายละเอียดการคืน {returnNo}</h3>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="ปิด"><X className="size-4" /></Button>
      </div>
      <StateView q={q}>
        {r && (
          <div className="space-y-4">
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Info label="เลขที่ขายเดิม" value={r.sale_no} />
              <Info label="ใบคืนเงิน" value={r.refund_no ?? '—'} />
              <Info label="วิธีคืนเงิน" value={r.refund_method ?? '—'} />
              <Info label="วันที่" value={r.return_date ? thaiDate(r.return_date) : '—'} />
              <Info label="มูลค่าก่อนภาษี" value={`฿${num(r.subtotal_returned)}`} />
              <Info label="ภาษี (VAT)" value={`฿${num(r.vat_returned)}`} />
              <Info label="ยอดคืนรวม" value={`฿${num(r.total_returned)}`} />
              <Info label="ใบลดหนี้ / JE" value={`${r.credit_note_no ?? '—'} · ${r.journal_no ?? '—'}`} />
            </div>
            <DataTable
              rows={r.items}
              rowKey={(it) => it.item_id}
              columns={[
                { key: 'item_id', label: 'รหัส' },
                { key: 'name', label: 'สินค้า' },
                { key: 'qty', label: 'จำนวนคืน', align: 'right', render: (it) => <span className="tabular">{num(it.qty)}</span> },
                { key: 'amount', label: 'มูลค่า', align: 'right', render: (it) => <span className="tabular">฿{num(it.amount)}</span> },
                { key: 'restocked', label: 'คืนสต๊อก', render: (it) => (it.restocked ? <Badge variant="secondary">คืนแล้ว</Badge> : <span className="text-muted-foreground">—</span>) },
              ]}
            />
          </div>
        )}
      </StateView>
    </Card>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="font-medium tabular">{value}</p></div>;
}
