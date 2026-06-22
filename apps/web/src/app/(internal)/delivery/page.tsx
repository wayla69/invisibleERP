'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { statusVariant } from '@/components/ui';

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function DeliveryPage() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['deliveries'], queryFn: () => api('/api/delivery') });
  const [f, setF] = useState({ order_no: '', driver: '', vehicle: '' });
  const [sel, setSel] = useState<string | null>(null);
  const detail = useQuery<any>({ queryKey: ['delivery', sel], queryFn: () => api(`/api/delivery/${sel}`), enabled: !!sel });
  const [msg, setMsg] = useState('');
  const create = useMutation({
    mutationFn: () => api('/api/delivery', { method: 'POST', body: JSON.stringify({ order_no: f.order_no || undefined, driver: f.driver || undefined, vehicle: f.vehicle || undefined }) }),
    onSuccess: (r: any) => { setMsg(`✅ สร้างใบส่ง ${r.do_no} (${r.lines} รายการ)`); setF({ order_no: '', driver: '', vehicle: '' }); qc.invalidateQueries({ queryKey: ['deliveries'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const setStatus = useMutation({
    mutationFn: (v: { no: string; status: string }) => api(`/api/delivery/${v.no}/status`, { method: 'PATCH', body: JSON.stringify({ status: v.status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deliveries'] }),
  });

  return (
    <div className="space-y-4">
      <PageHeader title="ใบส่งสินค้า (Delivery Orders)" description="สร้างใบส่งจากออเดอร์ ติดตามสถานะ และยืนยันการส่ง" />
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">สร้างใบส่งจากออเดอร์</h3>
        <div className="grid gap-2 sm:grid-cols-3">
          <Input placeholder="เลขที่ออเดอร์ (SO-…)" value={f.order_no} onChange={(e) => setF({ ...f, order_no: e.target.value })} />
          <Input placeholder="คนขับ" value={f.driver} onChange={(e) => setF({ ...f, driver: e.target.value })} />
          <Input placeholder="ทะเบียนรถ" value={f.vehicle} onChange={(e) => setF({ ...f, vehicle: e.target.value })} />
        </div>
        <Button className="w-fit" disabled={!f.order_no || create.isPending} onClick={() => create.mutate()}>สร้างใบส่ง</Button>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.deliveries}
            columns={[
              { key: 'do_no', label: 'เลขที่' },
              { key: 'do_date', label: 'วันที่', render: (r: any) => thaiDate(r.do_date) },
              { key: 'driver', label: 'คนขับ' },
              { key: 'vehicle', label: 'ทะเบียน' },
              { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              {
                key: 'act', label: 'อัปเดตสถานะ', render: (r: any) => (
                  <select className={selectCls} value={r.status} onChange={(e) => setStatus.mutate({ no: r.do_no, status: e.target.value })}>
                    {['Pending', 'In Transit', 'Delivered', 'Cancelled'].map((st) => <option key={st} value={st}>{st}</option>)}
                  </select>
                ),
              },
              { key: 'view', label: '', render: (r: any) => <Button variant="ghost" size="sm" onClick={() => setSel(r.do_no)}>ดูรายการ</Button> },
            ]}
            emptyText="ยังไม่มีใบส่งสินค้า"
          />
        )}
      </StateView>
      {sel && (
        <Card className="gap-3 p-5">
          <div className="flex items-center justify-between"><h3 className="text-base font-semibold">รายการใน {sel}</h3><Button variant="ghost" size="sm" onClick={() => setSel(null)}>ปิด</Button></div>
          <StateView q={detail}>
            {detail.data && (
              <DataTable
                rows={detail.data.items}
                columns={[
                  { key: 'item_id', label: 'สินค้า' },
                  { key: 'item_description', label: 'รายละเอียด' },
                  { key: 'qty', label: 'จำนวน', align: 'right' },
                  { key: 'uom', label: 'หน่วย' },
                ]}
                emptyText="ไม่มีรายการ"
              />
            )}
          </StateView>
        </Card>
      )}
    </div>
  );
}
