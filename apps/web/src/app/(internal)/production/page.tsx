'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Play, ClipboardCheck, Network, Route, ListChecks, ClipboardList } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLang } from '@/lib/i18n';

const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function ProductionPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('mf.prod_title')} description={t('mf.prod_desc')} />
      <Tabs tabs={[
        { key: 'routings', label: t('mf.prod_tab_routings'), content: <Routings /> },
        { key: 'shopfloor', label: t('mf.prod_tab_shopfloor'), content: <ShopFloor /> },
        { key: 'qa', label: t('mf.prod_tab_qa'), content: <Quality /> },
        { key: 'mrp', label: t('mf.prod_tab_mrp'), content: <Mrp /> },
      ]} />
    </div>
  );
}

// ───────────── Routings ─────────────
type Op = { op_no: string; work_center: string; description: string; setup_min: string; run_min_per_unit: string; labor_rate: string };
const emptyOp = (): Op => ({ op_no: '', work_center: '', description: '', setup_min: '', run_min_per_unit: '', labor_rate: '' });
function Routings() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['routings'], queryFn: () => api('/api/routings') });
  const [code, setCode] = useState('');
  const [product, setProduct] = useState('');
  const [ops, setOps] = useState<Op[]>([emptyOp()]);
  const create = useMutation({
    mutationFn: () => api('/api/routings', { method: 'POST', body: JSON.stringify({
      routing_code: code, product_item_id: product || undefined,
      operations: ops.filter((o) => o.op_no).map((o) => ({ op_no: Number(o.op_no), work_center: o.work_center || undefined, description: o.description || undefined, setup_min: Number(o.setup_min) || 0, run_min_per_unit: Number(o.run_min_per_unit) || 0, labor_rate: Number(o.labor_rate) || 0 })),
    }) }),
    onSuccess: () => { notifySuccess('บันทึกเส้นทางการผลิต'); setCode(''); setProduct(''); setOps([emptyOp()]); qc.invalidateQueries({ queryKey: ['routings'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const setOp = (i: number, p: Partial<Op>) => setOps((a) => a.map((o, j) => (j === i ? { ...o, ...p } : o)));
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">สร้างเส้นทางการผลิต</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>รหัส Routing</Label><Input value={code} onChange={(e) => setCode(e.target.value)} className="w-40" /></div>
          <div className="grid gap-1.5"><Label>สินค้า</Label><Input value={product} onChange={(e) => setProduct(e.target.value)} className="w-40" /></div>
        </div>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-muted-foreground"><th className="pb-2 font-medium">ลำดับ</th><th className="pb-2 font-medium">หน่วยงาน</th><th className="pb-2 font-medium">งาน</th><th className="pb-2 font-medium">ตั้งเครื่อง (นาที)</th><th className="pb-2 font-medium">นาที/ชิ้น</th><th className="pb-2 font-medium">ค่าแรง/ชม.</th></tr></thead>
          <tbody>
            {ops.map((o, i) => (
              <tr key={i}>
                <td className="py-1 pr-2"><Input type="number" value={o.op_no} onChange={(e) => setOp(i, { op_no: e.target.value })} className="w-16" /></td>
                <td className="py-1 pr-2"><Input value={o.work_center} onChange={(e) => setOp(i, { work_center: e.target.value })} /></td>
                <td className="py-1 pr-2"><Input value={o.description} onChange={(e) => setOp(i, { description: e.target.value })} /></td>
                <td className="py-1 pr-2"><Input type="number" value={o.setup_min} onChange={(e) => setOp(i, { setup_min: e.target.value })} className="w-20" /></td>
                <td className="py-1 pr-2"><Input type="number" value={o.run_min_per_unit} onChange={(e) => setOp(i, { run_min_per_unit: e.target.value })} className="w-20" /></td>
                <td className="py-1 pr-2"><Input type="number" value={o.labor_rate} onChange={(e) => setOp(i, { labor_rate: e.target.value })} className="w-24" /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setOps((a) => [...a, emptyOp()])}><Plus className="size-4" /> เพิ่มขั้นตอน</Button>
          <Button onClick={() => create.mutate()} disabled={!code || create.isPending}>บันทึก</Button>
        </div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.routings} columns={[{ key: 'routing_code', label: 'รหัส' }, { key: 'product_item_id', label: 'สินค้า' }, { key: 'name', label: 'ชื่อ' }]} emptyState={{ icon: Route, title: 'ยังไม่มีเส้นทางการผลิต', description: 'กรอกรหัส Routing และขั้นตอนงานด้านบน แล้วกดบันทึกเพื่อสร้างรายการแรก' }} />}</StateView>
    </div>
  );
}

// ───────────── Shop-floor ─────────────
function ShopFloor() {
  const [woNo, setWoNo] = useState('');
  const [routing, setRouting] = useState('');
  const q = useQuery<any>({ queryKey: ['wo-ops', woNo], queryFn: () => api(`/api/manufacturing/work-orders/${woNo}/operations`), enabled: false });
  const gen = useMutation({
    mutationFn: () => api(`/api/manufacturing/work-orders/${woNo}/routing/${routing}`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => { notifySuccess('สร้างขั้นตอนงานจาก Routing'); q.refetch(); }, onError: (e: any) => notifyError(e.message),
  });
  const report = useMutation({
    mutationFn: (p: { opNo: number; completed: number; scrap: number }) => api(`/api/manufacturing/work-orders/${woNo}/operations/${p.opNo}/report`, { method: 'POST', body: JSON.stringify({ completed_qty: p.completed, scrap_qty: p.scrap }) }),
    onSuccess: () => { notifySuccess('บันทึกความคืบหน้า'); q.refetch(); }, onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>เลขใบสั่งผลิต</Label><Input value={woNo} onChange={(e) => setWoNo(e.target.value)} className="w-48" placeholder="WO-..." /></div>
          <Button variant="outline" onClick={() => q.refetch()} disabled={!woNo}>ดูขั้นตอน</Button>
          <div className="grid gap-1.5"><Label>สร้างจาก Routing</Label><Input value={routing} onChange={(e) => setRouting(e.target.value)} className="w-40" placeholder="RT-..." /></div>
          <Button onClick={() => gen.mutate()} disabled={!woNo || !routing}><Network className="size-4" /> สร้างขั้นตอน</Button>
        </div>
      </Card>
      {q.data && (
        <DataTable rows={q.data.operations} columns={[
          { key: 'op_no', label: 'ลำดับ' }, { key: 'work_center', label: 'หน่วยงาน' }, { key: 'description', label: 'งาน' },
          { key: 'planned_qty', label: 'แผน', align: 'right' }, { key: 'completed_qty', label: 'เสร็จ', align: 'right' }, { key: 'scrap_qty', label: 'เสีย', align: 'right' },
          { key: 'labor_cost', label: 'ค่าแรง', align: 'right', render: (r: any) => baht(r.labor_cost) }, { key: 'status', label: 'สถานะ' },
          { key: 'act', label: 'รายงาน', sortable: false, render: (r: any) => <ReportBtn onReport={(c, sc) => report.mutate({ opNo: r.op_no, completed: c, scrap: sc })} /> },
        ]} emptyState={{ icon: ListChecks, title: 'ยังไม่มีขั้นตอนงาน', description: 'ใส่เลข Routing แล้วกด สร้างขั้นตอน เพื่อสร้างขั้นตอนงานให้ใบสั่งผลิตนี้' }} />
      )}
    </div>
  );
}
function ReportBtn({ onReport }: { onReport: (completed: number, scrap: number) => void }) {
  const [c, setC] = useState(''); const [s, setS] = useState('');
  return (
    <div className="flex items-center gap-1">
      <Input type="number" value={c} onChange={(e) => setC(e.target.value)} placeholder="เสร็จ" className="h-8 w-16" />
      <Input type="number" value={s} onChange={(e) => setS(e.target.value)} placeholder="เสีย" className="h-8 w-16" />
      <Button size="sm" variant="outline" onClick={() => { onReport(Number(c) || 0, Number(s) || 0); setC(''); setS(''); }}>OK</Button>
    </div>
  );
}

// ───────────── Quality ─────────────
function Quality() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['qa'], queryFn: () => api('/api/quality') });
  const [f, setF] = useState({ ref_type: 'WO', ref_doc: '', item_id: '', qty_inspected: '', qty_passed: '', disposition: 'Accept', unit_cost: '' });
  const ins = useMutation({
    mutationFn: () => api('/api/quality/inspect', { method: 'POST', body: JSON.stringify({ ref_type: f.ref_type, ref_doc: f.ref_doc || undefined, item_id: f.item_id || undefined, qty_inspected: Number(f.qty_inspected) || 0, qty_passed: Number(f.qty_passed) || 0, disposition: f.disposition, unit_cost: Number(f.unit_cost) || 0 }) }),
    onSuccess: (r: any) => { notifySuccess(r.scrap_value > 0 ? `บันทึก — ตัดของเสีย ${baht(r.scrap_value)} (${r.entry_no})` : 'บันทึกผลตรวจ'); qc.invalidateQueries({ queryKey: ['qa'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">บันทึกผลตรวจคุณภาพ</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5"><Label>ประเภท</Label><select className={selectCls} value={f.ref_type} onChange={(e) => setF({ ...f, ref_type: e.target.value })}><option value="WO">ผลิต (WO)</option><option value="GR">รับเข้า (GR)</option></select></div>
          <div className="grid gap-1.5"><Label>เอกสารอ้างอิง</Label><Input value={f.ref_doc} onChange={(e) => setF({ ...f, ref_doc: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>สินค้า</Label><Input value={f.item_id} onChange={(e) => setF({ ...f, item_id: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>ตรวจ (จำนวน)</Label><Input type="number" value={f.qty_inspected} onChange={(e) => setF({ ...f, qty_inspected: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>ผ่าน</Label><Input type="number" value={f.qty_passed} onChange={(e) => setF({ ...f, qty_passed: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>ผลตัดสิน</Label><select className={selectCls} value={f.disposition} onChange={(e) => setF({ ...f, disposition: e.target.value })}><option value="Accept">รับ</option><option value="Rework">แก้ไข</option><option value="Quarantine">กักไว้</option><option value="Scrap">ทิ้ง (Scrap)</option></select></div>
          {f.disposition === 'Scrap' && <div className="grid gap-1.5"><Label>ต้นทุน/หน่วย</Label><Input type="number" value={f.unit_cost} onChange={(e) => setF({ ...f, unit_cost: e.target.value })} /></div>}
        </div>
        <div className="flex items-center gap-3"><Button onClick={() => ins.mutate()} disabled={!f.qty_inspected || ins.isPending}><ClipboardCheck className="size-4" /> บันทึก</Button></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.inspections} columns={[
        { key: 'insp_no', label: 'เลขที่' }, { key: 'ref_type', label: 'ประเภท' }, { key: 'ref_doc', label: 'อ้างอิง' }, { key: 'item_id', label: 'สินค้า' },
        { key: 'qty_inspected', label: 'ตรวจ', align: 'right' }, { key: 'qty_failed', label: 'ไม่ผ่าน', align: 'right' }, { key: 'disposition', label: 'ผล' },
        { key: 'scrap_value', label: 'มูลค่าตัดทิ้ง', align: 'right', render: (r: any) => baht(r.scrap_value) },
      ]} emptyState={{ icon: ClipboardList, title: 'ยังไม่มีผลตรวจคุณภาพ', description: 'กรอกแบบฟอร์มด้านบนเพื่อบันทึกผลตรวจคุณภาพรายการแรก' }} />}</StateView>
    </div>
  );
}

// ───────────── MRP ─────────────
type Dem = { item_id: string; qty: string };
function Mrp() {
  const [rows, setRows] = useState<Dem[]>([{ item_id: '', qty: '' }]);
  const [res, setRes] = useState<any>(null);
  const run = useMutation({
    mutationFn: () => api<any>('/api/mrp/run', { method: 'POST', body: JSON.stringify({ demand: rows.filter((r) => r.item_id && r.qty).map((r) => ({ item_id: r.item_id, qty: Number(r.qty) })) }) }),
    onSuccess: (r) => { setRes(r); notifySuccess(`วางแผน: ผลิต ${r.summary.make_orders} · สั่งซื้อ ${r.summary.buy_orders} รายการ`); }, onError: (e: any) => notifyError(e.message),
  });
  const setRow = (i: number, p: Partial<Dem>) => setRows((a) => a.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">ความต้องการ (Demand)</h3>
        {rows.map((r, i) => (
          <div key={i} className="flex gap-3">
            <Input placeholder="รหัสสินค้า / BOM" value={r.item_id} onChange={(e) => setRow(i, { item_id: e.target.value })} className="w-56" />
            <Input type="number" placeholder="จำนวน" value={r.qty} onChange={(e) => setRow(i, { qty: e.target.value })} className="w-32" />
          </div>
        ))}
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setRows((a) => [...a, { item_id: '', qty: '' }])}><Plus className="size-4" /> เพิ่ม</Button>
          <Button onClick={() => run.mutate()} disabled={run.isPending}><Play className="size-4" /> รัน MRP</Button>
        </div>
      </Card>
      {res && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="gap-2 p-5"><h4 className="font-semibold">ใบสั่งผลิต (Make)</h4><DataTable rows={res.planned_make} columns={[{ key: 'item_id', label: 'สินค้า' }, { key: 'qty', label: 'จำนวน', align: 'right' }]} emptyState={{ title: 'ไม่มีรายการที่ต้องผลิต' }} /></Card>
          <Card className="gap-2 p-5"><h4 className="font-semibold">ใบสั่งซื้อ (Buy)</h4><DataTable rows={res.planned_buy} columns={[{ key: 'item_id', label: 'วัตถุดิบ' }, { key: 'gross_qty', label: 'ต้องการ', align: 'right' }, { key: 'on_hand', label: 'มีอยู่', align: 'right' }, { key: 'qty', label: 'ต้องซื้อ', align: 'right' }]} emptyState={{ title: 'ไม่มีรายการที่ต้องสั่งซื้อ' }} /></Card>
        </div>
      )}
    </div>
  );
}
