'use client';

import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export default function ImagesPage() {
  const qc = useQueryClient();
  const list = useQuery<any>({ queryKey: ['images'], queryFn: () => api('/api/images') });
  const [itemId, setItemId] = useState('');
  const [preview, setPreview] = useState('');
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: (dataUrl: string) => api(`/api/images/${encodeURIComponent(itemId)}`, { method: 'POST', body: JSON.stringify({ data_url: dataUrl }) }),
    onSuccess: () => { setMsg(`✅ บันทึกรูป ${itemId}`); qc.invalidateQueries({ queryKey: ['images'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/images/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['images'] }),
  });

  function onFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => { setPreview(String(reader.result)); };
    reader.readAsDataURL(file);
  }

  async function showImage(id: string) {
    setMsg('');
    try { const r = await api<any>(`/api/images/${encodeURIComponent(id)}`); setItemId(id); setPreview(r.data_url); }
    catch (e: any) { setMsg(`❌ ${e.message}`); }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="จัดการรูปภาพสินค้า (Image Manager)" description="อัปโหลดรูปสินค้า (เก็บเป็น data URL ในฐานข้อมูล)" />
      <Card className="gap-3 p-5">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5"><span className="text-sm">รหัสสินค้า</span><Input className="max-w-[200px]" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="เช่น A" /></div>
          <Button variant="outline" onClick={() => fileRef.current?.click()}><Upload className="size-4" /> เลือกรูป</Button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
          <Button disabled={!itemId || !preview || upload.isPending} onClick={() => upload.mutate(preview)}>{upload.isPending ? 'กำลังบันทึก…' : 'บันทึกรูป'}</Button>
        </div>
        {preview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="preview" className="max-h-48 w-fit rounded-md border" />
        )}
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={list}>
        {list.data && (
          <DataTable
            rows={list.data.items}
            columns={[
              { key: 'item_id', label: 'รหัสสินค้า' },
              { key: 'view', label: '', render: (r: any) => <Button size="sm" variant="outline" onClick={() => showImage(r.item_id)}>ดูรูป</Button> },
              { key: 'del', label: '', render: (r: any) => <Button size="sm" variant="destructive" onClick={() => remove.mutate(r.item_id)}>ลบ</Button> },
            ]}
            emptyText="ยังไม่มีรูปสินค้า"
          />
        )}
      </StateView>
    </div>
  );
}
