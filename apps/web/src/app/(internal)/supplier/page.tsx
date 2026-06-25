'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Check, FileText, PackageCheck, ClipboardList } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

// ── API contract (apps/api/src/modules/supplier) — vendor self-service ─────────
interface Po { po_no: string; po_date: string | null; status: string; total_amount: number; expected_date: string | null; acknowledged_at: string | null }
interface PoItem { item_id: string; description: string | null; order_qty: number; unit_price: number; amount: number; received_qty: number }
interface PoDetail { po_no: string; status: string; total_amount: number; acknowledged_at: string | null; items: PoItem[] }
interface Invoice { txn_no: string; invoice_no: string; ref_doc: string | null; amount: number; vat_amount: number; status: string; created_at: string | null }

export default function SupplierPage() {
  return (
    <div>
      <PageHeader
        title="พอร์ทัลซัพพลายเออร์"
        description="สำหรับคู่ค้า/ผู้ขาย — ดูใบสั่งซื้อที่ได้รับ ยืนยันรับทราบ PO และส่งใบแจ้งหนี้เข้าระบบเพื่อให้ฝ่ายจัดซื้อจับคู่และชำระเงิน (เห็นเฉพาะข้อมูลของตนเอง)"
      />
      <Tabs
        tabs={[
          { key: 'po', label: 'ใบสั่งซื้อ (PO)', content: <PoTab /> },
          { key: 'inv', label: 'ใบแจ้งหนี้', content: <InvoiceTab /> },
        ]}
      />
    </div>
  );
}

function PoTab() {
  const qc = useQueryClient();
  const q = useQuery<{ vendor: string; purchase_orders: Po[]; count: number }>({
    queryKey: ['sup-pos'],
    queryFn: () => api('/api/supplier/purchase-orders'),
  });
  const [selected, setSelected] = useState<string | null>(null);

  const rows = q.data?.purchase_orders ?? [];
  const unack = rows.filter((r) => !r.acknowledged_at).length;
  const totalOpen = rows.reduce((s, r) => s + (r.total_amount || 0), 0);

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="ใบสั่งซื้อทั้งหมด" value={num(rows.length)} icon={ClipboardList} tone="primary" hint={q.data.vendor ? `ผู้ขาย: ${q.data.vendor}` : undefined} />
            <StatCard label="ยังไม่ได้ยืนยันรับทราบ" value={num(unack)} tone="warning" />
            <StatCard label="มูลค่ารวม" value={baht(totalOpen)} tone="info" />
          </div>
        )}
      </StateView>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            rowKey={(r) => r.po_no}
            onRowClick={(r) => setSelected((id) => (id === r.po_no ? null : r.po_no))}
            emptyState={{ icon: ClipboardList, title: 'ยังไม่มีใบสั่งซื้อ', description: 'ใบสั่งซื้อที่ผู้ซื้อออกให้คุณจะปรากฏที่นี่ — คลิกเพื่อดูรายการและยืนยันรับทราบ' }}
            columns={[
              { key: 'po_no', label: 'เลขที่ PO', render: (r) => <span className="font-medium">{r.po_no}</span> },
              { key: 'po_date', label: 'วันที่', render: (r) => thaiDate(r.po_date) },
              { key: 'expected_date', label: 'กำหนดส่ง', render: (r) => thaiDate(r.expected_date) },
              { key: 'total_amount', label: 'มูลค่า', align: 'right', render: (r) => <span className="tabular">{baht(r.total_amount)}</span> },
              { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              { key: 'acknowledged_at', label: 'รับทราบ', render: (r) => (r.acknowledged_at ? <Badge variant="success">รับทราบแล้ว</Badge> : <Badge variant="secondary">ยังไม่ยืนยัน</Badge>) },
            ]}
          />
        )}
      </StateView>

      {selected && <PoDetailCard poNo={selected} onAck={() => qc.invalidateQueries({ queryKey: ['sup-pos'] })} />}
    </div>
  );
}

function PoDetailCard({ poNo, onAck }: { poNo: string; onAck: () => void }) {
  const qc = useQueryClient();
  const q = useQuery<PoDetail>({ queryKey: ['sup-po', poNo], queryFn: () => api(`/api/supplier/purchase-orders/${poNo}`) });

  const ack = useMutation({
    mutationFn: () => api(`/api/supplier/purchase-orders/${poNo}/acknowledge`, { method: 'POST' }),
    onSuccess: (r: any) => {
      notifySuccess(r.already ? 'PO นี้ยืนยันรับทราบไปแล้ว' : `ยืนยันรับทราบ ${poNo} แล้ว`);
      qc.invalidateQueries({ queryKey: ['sup-po', poNo] });
      onAck();
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="gap-4 border-primary/30">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><PackageCheck className="size-4" /> รายละเอียด {poNo}</span>
          {q.data && !q.data.acknowledged_at && (
            <Button size="sm" disabled={ack.isPending} onClick={() => ack.mutate()}>
              <Check className="size-4" /> {ack.isPending ? 'กำลังยืนยัน…' : 'ยืนยันรับทราบ PO'}
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={q.data.items}
              rowKey={(_r, i) => i}
              emptyText="ไม่มีรายการ"
              columns={[
                { key: 'item_id', label: 'รหัสสินค้า', render: (r) => <span className="font-medium">{r.item_id}</span> },
                { key: 'description', label: 'รายละเอียด', render: (r) => r.description ?? '—' },
                { key: 'order_qty', label: 'สั่ง', align: 'right', render: (r) => <span className="tabular">{num(r.order_qty)}</span> },
                { key: 'received_qty', label: 'รับแล้ว', align: 'right', render: (r) => <span className="tabular">{num(r.received_qty)}</span> },
                { key: 'unit_price', label: 'ราคา/หน่วย', align: 'right', render: (r) => <span className="tabular">{baht(r.unit_price)}</span> },
                { key: 'amount', label: 'รวม', align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
              ]}
            />
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

function InvoiceTab() {
  const qc = useQueryClient();
  const q = useQuery<{ invoices: Invoice[]; count: number }>({ queryKey: ['sup-inv'], queryFn: () => api('/api/supplier/invoices') });

  const [poNo, setPoNo] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [amount, setAmount] = useState('');
  const [vatAmount, setVatAmount] = useState('');

  const submit = useMutation({
    mutationFn: () =>
      api('/api/supplier/invoices', {
        method: 'POST',
        body: JSON.stringify({
          po_no: poNo || undefined,
          invoice_no: invoiceNo,
          invoice_date: invoiceDate || undefined,
          amount: Number(amount) || 0,
          vat_amount: vatAmount ? Number(vatAmount) : undefined,
        }),
      }),
    onSuccess: (r: any) => {
      notifySuccess(`ส่งใบแจ้งหนี้แล้ว: ${r.invoice_no}`, `เลขรายการ ${r.txn_no} · สถานะ ${r.status}`);
      setInvoiceNo(''); setAmount(''); setVatAmount(''); setPoNo('');
      qc.invalidateQueries({ queryKey: ['sup-inv'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const rows = q.data?.invoices ?? [];
  const unpaid = rows.filter((r) => r.status === 'Unpaid').reduce((s, r) => s + (r.amount || 0), 0);

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="ใบแจ้งหนี้ทั้งหมด" value={num(rows.length)} icon={FileText} tone="primary" />
            <StatCard label="ค้างชำระ (มูลค่า)" value={baht(unpaid)} tone="warning" />
            <StatCard label="ชำระแล้ว" value={num(rows.filter((r) => r.status !== 'Unpaid').length)} tone="success" />
          </div>
        )}
      </StateView>

      <Card className="max-w-4xl gap-4">
        <CardHeader><CardTitle className="text-base">ส่งใบแจ้งหนี้</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="iv-po">อ้างอิง PO (ถ้ามี)</Label>
              <Input id="iv-po" value={poNo} onChange={(e) => setPoNo(e.target.value)} placeholder="เลขที่ PO" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="iv-no">เลขใบแจ้งหนี้</Label>
              <Input id="iv-no" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="INV-xxxx" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="iv-date">วันที่ใบแจ้งหนี้</Label>
              <Input id="iv-date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="iv-amt">มูลค่าก่อน VAT (฿)</Label>
              <Input id="iv-amt" type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="iv-vat">VAT (฿)</Label>
              <Input id="iv-vat" type="number" min="0" value={vatAmount} onChange={(e) => setVatAmount(e.target.value)} placeholder="0" />
            </div>
          </div>
          <Button disabled={submit.isPending || !invoiceNo.trim() || !amount} onClick={() => submit.mutate()}>
            <Plus className="size-4" /> {submit.isPending ? 'กำลังส่ง…' : 'ส่งใบแจ้งหนี้'}
          </Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            rowKey={(r) => r.txn_no}
            emptyState={{ icon: FileText, title: 'ยังไม่มีใบแจ้งหนี้', description: 'ส่งใบแจ้งหนี้แรกจากแบบฟอร์มด้านบนเพื่อเข้าสู่กระบวนการจ่ายของผู้ซื้อ' }}
            columns={[
              { key: 'invoice_no', label: 'เลขใบแจ้งหนี้', render: (r) => <span className="font-medium">{r.invoice_no}</span> },
              { key: 'ref_doc', label: 'อ้างอิง', render: (r) => r.ref_doc ?? '—' },
              { key: 'created_at', label: 'ส่งเมื่อ', render: (r) => thaiDate(r.created_at) },
              { key: 'amount', label: 'มูลค่า', align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
              { key: 'vat_amount', label: 'VAT', align: 'right', render: (r) => <span className="tabular">{baht(r.vat_amount)}</span> },
              { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
