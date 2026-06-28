'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, ClipboardList, FileText, Plus, ScanLine, Trash2 } from 'lucide-react';
// Note: post.mutate() removed from this page (wh_adjust duty). Posting variance is on /stock-adjustment.
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

interface CountLine { item_id: string; item_description?: string; uom?: string; system_qty: number; physical_qty: number }

export default function StocktakePage() {
  return (
    <div>
      <PageHeader title="ตรวจนับสต๊อก (Stocktake)" description="นับจริงเทียบกับระบบ → บันทึกผลต่าง (สแกน QR เพื่อเพิ่มสินค้าได้)" />
      <Tabs tabs={[{ key: 'new', label: 'นับใหม่', content: <NewCount /> }, { key: 'history', label: 'ประวัติ', content: <History /> }]} />
    </div>
  );
}

function NewCount() {
  const qc = useQueryClient();
  const stock = useQuery<any>({ queryKey: ['stock', 'all'], queryFn: () => api('/api/inventory/stock?limit=500') });
  const items: any[] = stock.data?.items ?? [];
  const byId = useMemo(() => Object.fromEntries(items.map((i) => [i.Item_ID, i])), [items]);

  const [lines, setLines] = useState<CountLine[]>([]);
  const [itemId, setItemId] = useState('');
  const [phys, setPhys] = useState('');
  const [scan, setScan] = useState('');
  const [savedNo, setSavedNo] = useState('');

  function applyScan(v: string) {
    setScan(v);
    const code = parseQrPayload(v).ITEM_ID;
    if (code && (byId[code] || true)) setItemId(code);
  }
  function add() {
    if (!itemId || phys === '') return;
    const it = byId[itemId];
    setLines((ls) => [
      ...ls.filter((l) => l.item_id !== itemId),
      { item_id: itemId, item_description: it?.Item_Description, uom: it?.UOM, system_qty: Number(it?.AV_QTY ?? 0), physical_qty: Number(phys) },
    ]);
    setItemId(''); setPhys(''); setScan('');
  }

  const save = useMutation({
    mutationFn: () => api<any>('/api/stocktake', { method: 'POST', body: JSON.stringify({ lines }) }),
    // SoD R11: count is saved here (wh_count); posting the variance to the GL is a separate
    // wh_adjust action on /stock-adjustment — the counter cannot also approve their own count.
    onSuccess: (r) => { setSavedNo(r.st_no); notifySuccess(`บันทึกใบนับ ${r.st_no} (${r.variance_lines} รายการมีผลต่าง) — ส่ง Inventory Controller อนุมัติที่ /stock-adjustment`); setLines([]); qc.invalidateQueries({ queryKey: ['stocktakes'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <div className="grid gap-1.5">
          <Label htmlFor="st-scan"><ScanLine className="mr-1 inline size-4" /> สแกน / วาง QR</Label>
          <Input id="st-scan" placeholder="ITEM_ID:P001|…" value={scan} onChange={(e) => applyScan(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5 min-w-[220px] flex-1">
            <Label htmlFor="st-item">สินค้า</Label>
            <select id="st-item" className={selectCls} value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">— เลือก —</option>
              {items.map((i) => <option key={i.Item_ID} value={i.Item_ID}>{i.Item_ID} — {i.Item_Description}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="st-phys">นับได้จริง</Label>
            <Input id="st-phys" type="number" className="max-w-[140px]" value={phys} onChange={(e) => setPhys(e.target.value)} />
          </div>
          <Button disabled={!itemId || phys === ''} onClick={add}><Plus className="size-4" /> เพิ่ม</Button>
        </div>
        {savedNo && <p className="text-sm text-muted-foreground"><ClipboardCheck className="mr-1 inline size-4 text-success" />บันทึกใบนับ {savedNo} แล้ว — Inventory Controller ลงบัญชีผลต่างได้ที่ <a href="/stock-adjustment" className="text-primary underline">/stock-adjustment</a></p>}
      </Card>

      {lines.length > 0 && (
        <Card className="gap-3 p-5">
          <DataTable
            rows={lines.map((l) => ({ ...l, difference: l.physical_qty - l.system_qty }))}
            columns={[
              { key: 'item_id', label: 'รหัส' },
              { key: 'item_description', label: 'สินค้า' },
              { key: 'system_qty', label: 'ระบบ', align: 'right', render: (r: any) => <span className="tabular">{num(r.system_qty)}</span> },
              { key: 'physical_qty', label: 'นับจริง', align: 'right', render: (r: any) => <span className="tabular">{num(r.physical_qty)}</span> },
              { key: 'difference', label: 'ผลต่าง', align: 'right', render: (r: any) => <span className={`tabular ${r.difference === 0 ? '' : r.difference > 0 ? 'text-success' : 'text-destructive'}`}>{r.difference > 0 ? '+' : ''}{num(r.difference)}</span> },
              { key: 'act', label: '', render: (r: any) => <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((x) => x.item_id !== r.item_id))}><Trash2 className="size-4" /></Button> },
            ]}
          />
          <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'กำลังบันทึก…' : `บันทึกใบนับ (${lines.length} รายการ)`}</Button>
        </Card>
      )}
      {stock.isError && <StateView q={stock}><div /></StateView>}
    </div>
  );
}

function History() {
  const q = useQuery<any>({ queryKey: ['stocktakes'], queryFn: () => api('/api/stocktake') });
  const [sel, setSel] = useState<string | null>(null);
  const detail = useQuery<any>({ queryKey: ['stocktake', sel], queryFn: () => api(`/api/stocktake/${sel}`), enabled: !!sel });
  return (
    <div className="space-y-4">
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.stocktakes}
            columns={[
              { key: 'st_no', label: 'เลขที่' },
              { key: 'st_date', label: 'วันที่', render: (r: any) => thaiDate(r.st_date) },
              { key: 'counted_by', label: 'ผู้นับ' },
              { key: 'lines', label: 'รายการ', align: 'right', render: (r: any) => <span className="tabular">{num(r.lines)}</span> },
              { key: 'variance_lines', label: 'ผลต่าง', align: 'right', render: (r: any) => <span className="tabular">{num(r.variance_lines)}</span> },
              { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              { key: 'view', label: '', render: (r: any) => <Button variant="ghost" size="sm" onClick={() => setSel(r.st_no)}>ดู</Button> },
            ]}
            emptyState={{
              icon: ClipboardList,
              title: 'ยังไม่มีใบนับสต๊อก',
              description: 'เริ่มที่แท็บ “นับใหม่” เพื่อสร้างใบตรวจนับสต๊อกใบแรก',
            }}
          />
        )}
      </StateView>
      {sel && (
        <Card className="gap-3 p-5">
          <div className="flex items-center justify-between"><h3 className="text-base font-semibold">รายการใน {sel}</h3><Button variant="ghost" size="sm" onClick={() => setSel(null)}>ปิด</Button></div>
          <StateView q={detail}>
            {detail.data && (
              <DataTable
                rows={detail.data.lines}
                columns={[
                  { key: 'item_id', label: 'รหัส' },
                  { key: 'item_description', label: 'สินค้า' },
                  { key: 'system_qty', label: 'ระบบ', align: 'right', render: (r: any) => num(r.system_qty) },
                  { key: 'physical_qty', label: 'นับจริง', align: 'right', render: (r: any) => num(r.physical_qty) },
                  { key: 'difference', label: 'ผลต่าง', align: 'right', render: (r: any) => num(r.difference) },
                ]}
                emptyState={{ icon: FileText, title: 'ไม่มีรายการในใบนับนี้' }}
              />
            )}
          </StateView>
        </Card>
      )}
    </div>
  );
}
