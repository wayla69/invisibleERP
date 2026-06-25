'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Plus, ScanLine, Send, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { parseQrPayload } from '@/lib/qr';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

interface Line { item_id: string; item_description?: string; uom?: string; qty: number }

export default function GoodsIssuePage() {
  return (
    <div>
      <PageHeader title="เบิก / โอนสินค้า (Goods Issue / Transfer)" description="บันทึกการเบิกใช้และการโอนย้ายระหว่างคลัง (สแกน QR เพื่อเพิ่มสินค้าได้)" />
      <Tabs
        tabs={[
          { key: 'issue', label: 'เบิกใช้ (Issue)', content: <MoveForm kind="issue" /> },
          { key: 'transfer', label: 'โอนย้าย (Transfer)', content: <MoveForm kind="transfer" /> },
          { key: 'history', label: 'ประวัติ', content: <History /> },
        ]}
      />
    </div>
  );
}

function MoveForm({ kind }: { kind: 'issue' | 'transfer' }) {
  const qc = useQueryClient();
  const stock = useQuery<any>({ queryKey: ['stock', 'all'], queryFn: () => api('/api/inventory/stock?limit=500') });
  const items: any[] = stock.data?.items ?? [];
  const byId = useMemo(() => Object.fromEntries(items.map((i) => [i.Item_ID, i])), [items]);

  const [fromLoc, setFromLoc] = useState('WH-MAIN');
  const [toLoc, setToLoc] = useState('');
  const [refDoc, setRefDoc] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('');
  const [scan, setScan] = useState('');

  function applyScan(v: string) {
    setScan(v);
    const code = parseQrPayload(v).ITEM_ID;
    if (code) setItemId(code);
  }
  function add() {
    if (!itemId || !qty) return;
    const it = byId[itemId];
    setLines((ls) => [...ls.filter((l) => l.item_id !== itemId), { item_id: itemId, item_description: it?.Item_Description, uom: it?.UOM, qty: Number(qty) }]);
    setItemId(''); setQty(''); setScan('');
  }

  const submit = useMutation({
    mutationFn: () => api<any>(kind === 'issue' ? '/api/inventory/issue' : '/api/inventory/transfer', {
      method: 'POST',
      body: JSON.stringify(kind === 'issue'
        ? { from_location: fromLoc, ref_doc: refDoc || undefined, lines }
        : { from_location: fromLoc, to_location: toLoc, ref_doc: refDoc || undefined, lines }),
    }),
    onSuccess: (r) => { notifySuccess(`บันทึก ${r.doc_no} (${r.lines} รายการ)`); setLines([]); qc.invalidateQueries({ queryKey: ['movements'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const canSubmit = lines.length > 0 && !!fromLoc && (kind === 'issue' || (!!toLoc && toLoc !== fromLoc));

  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="gi-from">{kind === 'issue' ? 'คลังที่เบิก' : 'คลังต้นทาง'}</Label>
            <Input id="gi-from" value={fromLoc} onChange={(e) => setFromLoc(e.target.value)} />
          </div>
          {kind === 'transfer' && (
            <div className="grid gap-1.5">
              <Label htmlFor="gi-to">คลังปลายทาง</Label>
              <Input id="gi-to" value={toLoc} onChange={(e) => setToLoc(e.target.value)} placeholder="เช่น WH-2" />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="gi-ref">อ้างอิง (เลือก)</Label>
            <Input id="gi-ref" value={refDoc} onChange={(e) => setRefDoc(e.target.value)} placeholder="WO / SO / …" />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="gi-scan"><ScanLine className="mr-1 inline size-4" /> สแกน / วาง QR</Label>
          <Input id="gi-scan" placeholder="ITEM_ID:P001|…" value={scan} onChange={(e) => applyScan(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5 min-w-[220px] flex-1">
            <Label htmlFor="gi-item">สินค้า</Label>
            <select id="gi-item" className={selectCls} value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">— เลือก —</option>
              {items.map((i) => <option key={i.Item_ID} value={i.Item_ID}>{i.Item_ID} — {i.Item_Description}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="gi-qty">จำนวน</Label>
            <Input id="gi-qty" type="number" className="max-w-[140px]" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <Button disabled={!itemId || !qty} onClick={add}><Plus className="size-4" /> เพิ่ม</Button>
        </div>
      </Card>

      {lines.length > 0 && (
        <Card className="gap-3 p-5">
          <DataTable
            rows={lines}
            columns={[
              { key: 'item_id', label: 'รหัส' },
              { key: 'item_description', label: 'สินค้า' },
              { key: 'qty', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{num(r.qty)}</span> },
              { key: 'uom', label: 'หน่วย' },
              { key: 'act', label: '', render: (r: any) => <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((x) => x.item_id !== r.item_id))}><Trash2 className="size-4" /></Button> },
            ]}
          />
          <Button disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>
            <Send className="size-4" /> {submit.isPending ? 'กำลังบันทึก…' : kind === 'issue' ? `ยืนยันการเบิก (${lines.length})` : `ยืนยันการโอน (${lines.length})`}
          </Button>
        </Card>
      )}
    </div>
  );
}

function History() {
  const q = useQuery<any>({ queryKey: ['movements'], queryFn: () => api('/api/inventory/movements?limit=100') });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable
          rows={q.data.movements}
          columns={[
            { key: 'doc_no', label: 'เลขที่' },
            { key: 'move_date', label: 'วันที่', render: (r: any) => thaiDate(r.move_date) },
            { key: 'move_type', label: 'ประเภท', render: (r: any) => <Badge variant={statusVariant(r.move_type === 'Issue' ? 'cancelled' : 'open')}>{r.move_type}</Badge> },
            { key: 'item_id', label: 'สินค้า', render: (r: any) => `${r.item_id}${r.item_description ? ' — ' + r.item_description : ''}` },
            { key: 'qty', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{num(r.qty)}</span> },
            { key: 'from_location', label: 'จาก' },
            { key: 'to_location', label: 'ไป' },
          ]}
          emptyState={{
            icon: ArrowLeftRight,
            title: 'ยังไม่มีการเคลื่อนไหว',
            description: 'บันทึกการเบิกใช้หรือโอนย้ายที่แท็บ "เบิกใช้" หรือ "โอนย้าย" แล้วประวัติจะแสดงที่นี่',
          }}
        />
      )}
    </StateView>
  );
}
