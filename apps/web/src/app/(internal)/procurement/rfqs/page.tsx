'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Plus, X, Award, FileSearch, Inbox, FileText, Quote } from 'lucide-react';
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { statusVariant } from '@/components/ui';

export default function RfqsPage() {
  return (
    <div>
      <PageHeader
        title="ขอใบเสนอราคา (RFQ)"
        description="ออก RFQ → รับใบเสนอราคาจากผู้ขาย → เลือกผู้ชนะ (award) ระบบสร้าง PO อัตโนมัติจากใบที่ชนะ"
      />
      <Tabs
        tabs={[
          { key: 'list', label: 'รายการ RFQ', content: <RfqList /> },
          { key: 'create', label: 'สร้าง RFQ', content: <RfqCreate /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── List + detail ─────────────────────────
function RfqList() {
  const q = useQuery<any>({ queryKey: ['rfqs'], queryFn: () => api('/api/procurement/rfqs') });
  const [selected, setSelected] = useState<string | null>(null);

  const rfqs: any[] = q.data?.rfqs ?? [];
  const open = rfqs.filter((r) => r.status === 'Open').length;
  const awarded = rfqs.filter((r) => r.status === 'Awarded').length;

  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <StatCard label="RFQ ทั้งหมด" value={num(rfqs.length)} icon={ClipboardList} tone="primary" />
            <StatCard label="เปิดอยู่" value={num(open)} icon={FileSearch} tone="info" />
            <StatCard label="เลือกผู้ชนะแล้ว" value={num(awarded)} icon={Award} tone="success" />
          </div>
          <DataTable
            rows={rfqs}
            onRowClick={(r: any) => setSelected(r.rfq_no)}
            columns={[
              { key: 'rfq_no', label: 'เลขที่ RFQ' },
              { key: 'rfq_date', label: 'วันที่', render: (r: any) => thaiDate(r.rfq_date) },
              { key: 'required_date', label: 'ต้องการภายใน', render: (r: any) => (r.required_date ? thaiDate(r.required_date) : '—') },
              { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            ]}
            emptyState={{
              icon: Inbox,
              title: 'ยังไม่มี RFQ',
              description: 'สร้าง RFQ ใบแรกในแท็บ “สร้าง RFQ” เพื่อขอใบเสนอราคาจากผู้ขาย',
            }}
          />
          <RfqDetailDialog rfqNo={selected} onClose={() => setSelected(null)} />
        </div>
      )}
    </StateView>
  );
}

function RfqDetailDialog({ rfqNo, onClose }: { rfqNo: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['rfq', rfqNo], queryFn: () => api(`/api/procurement/rfqs/${encodeURIComponent(rfqNo!)}`), enabled: !!rfqNo });

  const award = useMutation({
    mutationFn: (quoteNo: string) =>
      api<{ po_no: string }>(`/api/procurement/rfqs/${encodeURIComponent(rfqNo!)}/award`, {
        method: 'POST',
        body: JSON.stringify({ quote_no: quoteNo }),
      }),
    onSuccess: (r) => {
      notifySuccess(`เลือกผู้ชนะแล้ว · สร้าง ${r.po_no}`);
      qc.invalidateQueries({ queryKey: ['rfq', rfqNo] });
      qc.invalidateQueries({ queryKey: ['rfqs'] });
    },
    onError: (e) => notifyError((e as Error).message),
  });

  const data = q.data;
  const isOpen = data?.status === 'Open';

  return (
    <Dialog open={!!rfqNo} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {rfqNo} {data && <Badge variant={statusVariant(data.status)}>{data.status}</Badge>}
          </DialogTitle>
        </DialogHeader>
        <StateView q={q}>
          {data && (
            <div className="space-y-5">
              <div>
                <h3 className="mb-2 text-sm font-semibold text-muted-foreground">รายการที่ขอ</h3>
                <DataTable
                  rows={data.items}
                  columns={[
                    { key: 'item_id', label: 'รหัสสินค้า' },
                    { key: 'qty', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{num(r.qty)}</span> },
                  ]}
                  emptyState={{ icon: FileText, title: 'ไม่มีรายการ' }}
                  dense
                />
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold text-muted-foreground">ใบเสนอราคา</h3>
                <DataTable
                  rows={data.quotes}
                  columns={[
                    { key: 'quote_no', label: 'เลขที่' },
                    { key: 'vendor_name', label: 'ผู้ขาย', render: (r: any) => r.vendor_name ?? '—' },
                    { key: 'total_amount', label: 'ยอดรวม', align: 'right', render: (r: any) => <span className="tabular">{baht(r.total_amount)}</span> },
                    { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                    {
                      key: '_award',
                      label: '',
                      align: 'right',
                      render: (r: any) =>
                        isOpen ? (
                          <Button size="sm" variant="outline" disabled={award.isPending} onClick={() => award.mutate(r.quote_no)}>
                            <Award className="size-4" /> เลือก
                          </Button>
                        ) : null,
                    },
                  ]}
                  emptyState={{ icon: Quote, title: 'ยังไม่มีใบเสนอราคา' }}
                  dense
                />
              </div>
            </div>
          )}
        </StateView>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Create ─────────────────────────
interface Line { item_id: string; qty: number }

function RfqCreate() {
  const qc = useQueryClient();
  const [requiredDate, setRequiredDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<Line[]>([{ item_id: '', qty: 1 }]);
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const create = useMutation({
    mutationFn: () =>
      api<{ rfq_no: string; lines: number }>('/api/procurement/rfqs', {
        method: 'POST',
        body: JSON.stringify({
          required_date: requiredDate || undefined,
          remarks: remarks || undefined,
          items: lines.filter((l) => l.item_id).map((l) => ({ item_id: l.item_id, qty: Number(l.qty) })),
        }),
      }),
    onSuccess: (r) => {
      notifySuccess(`${r.rfq_no} · ${num(r.lines)} รายการ`);
      setRequiredDate(''); setRemarks(''); setLines([{ item_id: '', qty: 1 }]);
      qc.invalidateQueries({ queryKey: ['rfqs'] });
    },
    onError: (e) => notifyError((e as Error).message),
  });

  return (
    <Card className="max-w-2xl gap-4">
      <CardHeader>
        <CardTitle className="text-base">สร้าง RFQ ใหม่</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="rfq-req">ต้องการภายในวันที่</Label>
            <Input id="rfq-req" type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rfq-remarks">หมายเหตุ</Label>
            <Input id="rfq-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="ไม่บังคับ" />
          </div>
        </div>
        <div className="space-y-2">
          <Label>รายการสินค้า</Label>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[2fr_1fr_auto] gap-2">
              <Input placeholder="Item ID" value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })} />
              <Input type="number" min="0" value={l.qty} onChange={(e) => setLine(i, { qty: +e.target.value })} />
              <Button variant="destructive" size="icon" disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                <X className="size-4" />
              </Button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => setLines((ls) => [...ls, { item_id: '', qty: 1 }])}>
            <Plus className="size-4" /> รายการ
          </Button>
          <Button disabled={create.isPending || !lines.some((l) => l.item_id)} onClick={() => create.mutate()}>
            {create.isPending ? 'กำลังสร้าง…' : 'สร้าง RFQ'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
