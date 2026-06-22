'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ScanLine, PackageCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { statusVariant } from '@/components/ui';
import { Msg } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';
const TYPES = ['GR', 'Issue', 'Transfer', 'Count'];

export default function MobileScanPage() {
  const qc = useQueryClient();
  const [sessionNo, setSessionNo] = useState('');
  const [type, setType] = useState('Count');
  const [loc, setLoc] = useState('WH-MAIN');
  const [scan, setScan] = useState('');
  const [qty, setQty] = useState('1');
  const [msg, setMsg] = useState('');

  const session = useQuery<any>({ queryKey: ['scan-session', sessionNo], queryFn: () => api(`/api/scan/sessions/${sessionNo}`), enabled: !!sessionNo });
  const recent = useQuery<any>({ queryKey: ['scan-sessions'], queryFn: () => api('/api/scan/sessions?limit=20'), enabled: !sessionNo });

  const open = useMutation({
    mutationFn: () => api<any>('/api/scan/sessions', { method: 'POST', body: JSON.stringify({ session_type: type, location_id: loc }) }),
    onSuccess: (r) => { setSessionNo(r.session_no); setMsg(`✅ เปิดเซสชัน ${r.session_no}`); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const addLine = useMutation({
    mutationFn: () => api(`/api/scan/sessions/${sessionNo}/lines`, { method: 'POST', body: JSON.stringify({ qr_data: scan, qty: Number(qty) }) }),
    onSuccess: () => { setScan(''); setQty('1'); qc.invalidateQueries({ queryKey: ['scan-session', sessionNo] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const close = useMutation({
    mutationFn: () => api<any>(`/api/scan/sessions/${sessionNo}/close`, { method: 'POST' }),
    onSuccess: (r) => { setMsg(`✅ ปิดเซสชัน — บันทึก ${r.committed} รายการ`); setSessionNo(''); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div className="space-y-4">
      <PageHeader title="สแกนผ่านมือถือ (Mobile Scan)" description="เปิดเซสชัน → สแกนสินค้า → ปิดเพื่อบันทึกการเคลื่อนไหว" />
      {!sessionNo ? (
        <div className="space-y-4">
          <Card className="max-w-md gap-3 p-5">
            <h3 className="text-base font-semibold">เปิดเซสชันใหม่</h3>
            <div className="grid gap-1.5"><Label>ประเภท</Label><select className={selectCls} value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
            <div className="grid gap-1.5"><Label>คลัง</Label><Input value={loc} onChange={(e) => setLoc(e.target.value)} /></div>
            <Button disabled={open.isPending} onClick={() => open.mutate()}><ScanLine className="size-4" /> เปิดเซสชัน</Button>
            <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
          </Card>
          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">เซสชันล่าสุด</h3>
            <StateView q={recent}>
              {recent.data && (
                <DataTable
                  rows={recent.data.sessions}
                  columns={[
                    { key: 'session_no', label: 'เลขที่' },
                    { key: 'session_type', label: 'ประเภท' },
                    { key: 'location_id', label: 'คลัง' },
                    { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                    { key: 'act', label: '', render: (r: any) => r.status === 'Open' ? <Button size="sm" variant="outline" onClick={() => setSessionNo(r.session_no)}>เปิดต่อ</Button> : null },
                  ]}
                  emptyText="ยังไม่มีเซสชัน"
                />
              )}
            </StateView>
          </div>
        </div>
      ) : (
        <Card className="gap-3 p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold">{sessionNo} · {session.data?.session_type}</h3>
            <Button variant="default" disabled={close.isPending} onClick={() => close.mutate()}><PackageCheck className="size-4" /> ปิด & บันทึก</Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5 flex-1 min-w-[220px]"><Label>สแกน / วาง QR</Label><Input value={scan} onChange={(e) => setScan(e.target.value)} placeholder="ITEM_ID:A|…" /></div>
            <div className="grid gap-1.5"><Label>จำนวน</Label><Input type="number" className="max-w-[120px]" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
            <Button disabled={!scan || addLine.isPending} onClick={() => addLine.mutate()}>เพิ่ม</Button>
          </div>
          <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
          <DataTable
            rows={session.data?.lines ?? []}
            columns={[
              { key: 'item_id', label: 'สินค้า' },
              { key: 'qty', label: 'จำนวน', align: 'right', render: (r: any) => num(r.qty) },
              { key: 'action', label: 'การทำงาน' },
            ]}
            emptyText="ยังไม่มีรายการสแกน"
          />
        </Card>
      )}
    </div>
  );
}
