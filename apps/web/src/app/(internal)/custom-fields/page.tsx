'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CustomFields } from '@/components/custom-fields';

interface Def { id: number; entity: string; field_key: string; label: string; data_type: string; options: string[] | null; required: boolean; sort: number; active: boolean }

// entities a tenant can extend with custom fields (the common master/transaction records)
const ENTITIES = ['customer', 'item', 'sales_order', 'purchase_order', 'journal', 'vendor', 'employee', 'project'];

export default function CustomFieldsPage() {
  const qc = useQueryClient();
  const [entity, setEntity] = useState('customer');
  const [label, setLabel] = useState(''); const [type, setType] = useState('text'); const [options, setOptions] = useState(''); const [required, setRequired] = useState(false);
  const [recordId, setRecordId] = useState('');
  const [msg, setMsg] = useState('');
  const q = useQuery<{ fields: Def[] }>({ queryKey: ['cf-defs', entity], queryFn: () => api(`/api/custom-fields/defs?entity=${entity}`) });

  const create = useMutation({
    mutationFn: () => api('/api/custom-fields/defs', { method: 'POST', body: JSON.stringify({ entity, label, data_type: type, required, options: type === 'select' ? options.split(',').map((s) => s.trim()).filter(Boolean) : undefined }) }),
    onSuccess: () => { setMsg(`✅ เพิ่มฟิลด์ ${label}`); setLabel(''); setOptions(''); setRequired(false); qc.invalidateQueries({ queryKey: ['cf-defs', entity] }); },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/custom-fields/defs/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cf-defs', entity] }),
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title="ฟิลด์กำหนดเอง (Custom fields)" description="เพิ่มฟิลด์ของคุณเองให้กับข้อมูลหลัก/เอกสารใด ๆ โดยไม่ต้องเขียนโค้ด — มีการตรวจสอบชนิดข้อมูลและแยกตามกิจการ" />

      <div className="mb-6 flex items-end gap-3">
        <div>
          <Label>ประเภทข้อมูล (entity)</Label>
          <select className="h-9 w-56 rounded-md border bg-background px-2 text-sm" value={entity} onChange={(e) => setEntity(e.target.value)}>
            {ENTITIES.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm flex items-center gap-2"><SlidersHorizontal className="h-4 w-4" />เพิ่มฟิลด์ใหม่</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><Label>ชื่อฟิลด์</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="เช่น พนักงานขาย" /></div>
              <div>
                <Label>ชนิด</Label>
                <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="text">ข้อความ (text)</option><option value="number">ตัวเลข (number)</option><option value="date">วันที่ (date)</option><option value="boolean">ใช่/ไม่ใช่ (boolean)</option><option value="select">ตัวเลือก (select)</option>
                </select>
              </div>
            </div>
            {type === 'select' && <div><Label>ตัวเลือก (คั่นด้วย ,)</Label><Input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="A, B, C" /></div>}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> จำเป็นต้องกรอก (required)</label>
            <div className="flex items-center gap-3">
              <Button disabled={!label || (type === 'select' && !options.trim()) || create.isPending} onClick={() => create.mutate()}>เพิ่มฟิลด์</Button>
              <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">ทดลองกรอกค่า (ตามเรคคอร์ด)</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div><Label>รหัสเรคคอร์ด (record id)</Label><Input value={recordId} onChange={(e) => setRecordId(e.target.value.trim())} placeholder={`${entity.toUpperCase()}-1`} /></div>
            {recordId
              ? <CustomFields entity={entity} recordId={recordId} title={`ค่า ${entity} · ${recordId}`} />
              : <p className="text-sm text-muted-foreground">ใส่รหัสเรคคอร์ดเพื่อกรอกค่าฟิลด์กำหนดเองของเรคคอร์ดนั้น (หน้าจริงของแต่ละโมดูลจะฝังแผงนี้ไว้ให้อัตโนมัติ)</p>}
          </CardContent>
        </Card>
      </div>

      <StateView q={q}>
        <DataTable
          rows={q.data?.fields ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'label', label: 'ชื่อฟิลด์' },
            { key: 'field_key', label: 'คีย์', render: (r) => <code className="text-xs">{r.field_key}</code> },
            { key: 'data_type', label: 'ชนิด', render: (r) => <Badge variant="muted">{r.data_type}</Badge> },
            { key: 'options', label: 'ตัวเลือก', render: (r) => r.options?.join(', ') ?? '—' },
            { key: 'required', label: 'จำเป็น', render: (r) => r.required ? <Badge variant="warning">required</Badge> : '—' },
            { key: 'act', label: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" onClick={() => remove.mutate(r.id)}><Trash2 className="h-4 w-4" /></Button> },
          ]}
          emptyText="ยังไม่มีฟิลด์กำหนดเองสำหรับประเภทนี้"
        />
      </StateView>
    </div>
  );
}
