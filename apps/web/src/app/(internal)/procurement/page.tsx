'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Paperclip, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { statusVariant } from '@/components/ui';
import { PoForm } from '@/components/procurement-forms';

const PO_LIST_KEY = ['proc-pos'];

// Procurement team surface — create/approve Purchase Orders against approved requisitions, then track
// status. Raising a requisition lives at /requisitions (anyone) and goods receipt at /receiving
// (warehouse) — kept on separate pages because each belongs to a different user group (SoD R03/R04).
export default function ProcurementPage() {
  const qc = useQueryClient();
  const pos = useQuery<any>({ queryKey: PO_LIST_KEY, queryFn: () => api('/api/inventory/purchase-orders?limit=50') });

  return (
    <div>
      <PageHeader title="ใบสั่งซื้อ (Purchase Orders)" description="สร้าง / อนุมัติใบสั่งซื้อ (PO) สำหรับทีมจัดซื้อ และติดตามสถานะ" />

      <Card className="mb-6 gap-4">
        <CardHeader>
          <CardTitle className="text-base">สร้างใบสั่งซื้อ (PO)</CardTitle>
        </CardHeader>
        <CardContent>
          <PoForm onDone={() => qc.invalidateQueries({ queryKey: PO_LIST_KEY })} />
        </CardContent>
      </Card>

      <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ใบสั่งซื้อ</h3>
      <StateView q={pos}>
        {pos.data && (
          <DataTable
            rows={pos.data.purchase_orders}
            emptyState={{
              icon: ClipboardList,
              title: 'ยังไม่มีใบสั่งซื้อ',
              description: 'สร้าง PO ในแบบฟอร์มด้านบนเพื่อเริ่มต้นการจัดซื้อ',
            }}
            columns={[
              { key: 'PO_No', label: 'PO' },
              { key: 'PO_Date', label: 'วันที่', render: (r: any) => thaiDate(r.PO_Date) },
              { key: 'Supplier_Name', label: 'ผู้ขาย' },
              { key: 'Total_Amount', label: 'ยอด', align: 'right', render: (r: any) => baht(r.Total_Amount) },
              { key: 'Status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
            ]}
          />
        )}
      </StateView>

      <PoAttachmentsCard />
    </div>
  );
}

// Invoice/receipt photos pinned to a PO (0228) — evidence backing the 3-way match. Upload here or from
// the LINE OA chat (`attach <PO no>` then send the photo); both land in the same register.
function PoAttachmentsCard() {
  const qc = useQueryClient();
  const [docNo, setDocNo] = useState('');
  const [loadedFor, setLoadedFor] = useState('');
  const [preview, setPreview] = useState<{ id: number; dataUrl: string } | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const listKey = ['po-attachments', loadedFor];
  const list = useQuery<any>({
    queryKey: listKey,
    queryFn: () => api(`/api/procurement/attachments?doc_type=PO&doc_no=${encodeURIComponent(loadedFor)}`),
    enabled: !!loadedFor,
  });
  const upload = useMutation({
    mutationFn: (p: { data_url: string; filename: string; kind: string }) =>
      api('/api/procurement/attachments', { method: 'POST', body: JSON.stringify({ doc_type: 'PO', doc_no: loadedFor, ...p }) }),
    onSuccess: () => { setError(''); qc.invalidateQueries({ queryKey: listKey }); },
    onError: (e) => setError((e as Error).message),
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`/api/procurement/attachments/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setPreview(null); qc.invalidateQueries({ queryKey: listKey }); },
    onError: (e) => setError((e as Error).message),
  });

  const onFile = (kind: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || !loadedFor) return;
    const reader = new FileReader();
    reader.onload = () => upload.mutate({ data_url: String(reader.result), filename: f.name, kind });
    reader.readAsDataURL(f);
    e.target.value = '';
  };
  const view = async (id: number) => {
    const r = await api<{ id: number; data_url: string }>(`/api/procurement/attachments/${id}`);
    setPreview({ id: r.id, dataUrl: r.data_url });
  };

  return (
    <Card className="mt-6 gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Paperclip className="size-4" /> ไฟล์แนบใบสั่งซื้อ (ใบแจ้งหนี้ / ใบเสร็จ)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input className="w-56" placeholder="เลขที่ PO เช่น PO-20260702-001" value={docNo} onChange={(e) => setDocNo(e.target.value)} />
          <Button size="sm" variant="outline" onClick={() => { setPreview(null); setLoadedFor(docNo.trim().toUpperCase()); }} disabled={!docNo.trim()}>ดูไฟล์แนบ</Button>
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={!loadedFor || upload.isPending}>แนบรูป/ไฟล์</Button>
          <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={onFile('invoice')} />
          <span className="text-xs text-muted-foreground">หรือแนบจากแชท LINE: พิมพ์ <code className="rounded bg-muted px-1">attach &lt;เลขที่ PO&gt;</code> แล้วส่งรูป</span>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {loadedFor && (
          <StateView q={list}>
            {list.data && (
              list.data.count === 0 ? <p className="text-sm text-muted-foreground">ยังไม่มีไฟล์แนบสำหรับ {loadedFor}</p> : (
                <ul className="space-y-1">
                  {list.data.attachments.map((a: any) => (
                    <li key={a.id} className="flex items-center gap-2 text-sm">
                      <Badge variant="outline">{a.kind === 'receipt' ? 'ใบเสร็จ' : a.kind === 'other' ? 'อื่น ๆ' : 'ใบแจ้งหนี้'}</Badge>
                      <button className="underline-offset-2 hover:underline" onClick={() => view(a.id)}>{a.filename ?? `ไฟล์ #${a.id}`}</button>
                      <span className="text-xs text-muted-foreground">โดย {a.created_by}{a.source === 'line' ? ' · จาก LINE' : ''}</span>
                      <Button size="icon" variant="ghost" className="size-6" onClick={() => del.mutate(a.id)} title="ลบ (เฉพาะผู้แนบ/ผู้ดูแล)"><Trash2 className="size-3.5" /></Button>
                    </li>
                  ))}
                </ul>
              )
            )}
          </StateView>
        )}
        {preview && (
          preview.dataUrl.startsWith('data:image/')
            ? <img src={preview.dataUrl} alt="attachment preview" className="max-h-96 rounded border" />
            : <a className="text-sm underline" href={preview.dataUrl} download={`attachment-${preview.id}.pdf`}>ดาวน์โหลด PDF</a>
        )}
      </CardContent>
    </Card>
  );
}
