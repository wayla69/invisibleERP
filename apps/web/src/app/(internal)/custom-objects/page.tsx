'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, Plus, Trash2, Save, Loader2, Database } from 'lucide-react';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Msg } from '@/components/tabs';

type CObject = { object_key: string; label: string; label_en?: string | null; icon?: string | null };
type FieldDef = { field_key: string; label: string; data_type: string; options?: string[] | null; required?: boolean };
type CRecord = { record_id: string; display_name: string | null; values: Record<string, any> };

const DATA_TYPES = ['text', 'number', 'date', 'boolean', 'select'] as const;

// One input rendered per field type.
function FieldInput({ f, value, onChange }: { f: FieldDef; value: any; onChange: (v: any) => void }) {
  const cls = 'h-9 rounded-md border bg-transparent px-3 text-sm';
  if (f.data_type === 'boolean') return <select className={cls} value={value ? '1' : '0'} onChange={(e) => onChange(e.target.value === '1')}><option value="0">ไม่</option><option value="1">ใช่</option></select>;
  if (f.data_type === 'select') return <select className={cls} value={value ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>;
  if (f.data_type === 'number') return <Input type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  if (f.data_type === 'date') return <Input type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  return <Input value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

export default function CustomObjectsPage() {
  const qc = useQueryClient();
  const [selKey, setSelKey] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [obj, setObj] = useState({ label: '', label_en: '', icon: '' });
  const [fld, setFld] = useState<{ label: string; data_type: string; options: string; required: boolean }>({ label: '', data_type: 'text', options: '', required: false });
  const [rec, setRec] = useState<Record<string, any>>({});
  const [editId, setEditId] = useState<string | null>(null);

  const objects = useQuery<{ objects: CObject[] }>({ queryKey: ['cobjects'], queryFn: () => api('/api/custom-objects') });
  const detail = useQuery<{ object: CObject; fields: FieldDef[] }>({ queryKey: ['cobject', selKey], queryFn: () => api(`/api/custom-objects/${selKey}`), enabled: !!selKey });
  const records = useQuery<{ fields: FieldDef[]; records: CRecord[] }>({ queryKey: ['crecords', selKey], queryFn: () => api(`/api/custom-objects/${selKey}/records`), enabled: !!selKey });
  const me = useMe();
  // the data-entry form respects the object's resolved layout (Phase 12 — A2), for the current user's role
  const layout = useQuery<{ sections: { title: string; columns: number; fields: FieldDef[] }[] }>({ queryKey: ['olayout', selKey, me.data?.role], queryFn: () => api(`/api/object-layouts/resolve?object_key=${selKey}&role=${encodeURIComponent(me.data?.role ?? '')}`), enabled: !!selKey });
  const fields = detail.data?.fields ?? [];
  const formSections = layout.data?.sections ?? (fields.length ? [{ title: '', columns: 1, fields }] : []);

  const note = (m: string) => setMsg(m);
  const resetRec = () => { setRec({}); setEditId(null); };

  const createObj = useMutation({
    mutationFn: () => api('/api/custom-objects', { method: 'POST', body: JSON.stringify({ label: obj.label, label_en: obj.label_en || undefined, icon: obj.icon || undefined }) }),
    onSuccess: (r: any) => { note('✅ สร้างออบเจ็กต์แล้ว'); setObj({ label: '', label_en: '', icon: '' }); qc.invalidateQueries({ queryKey: ['cobjects'] }); setSelKey(r.object_key); },
    onError: (e: any) => note(`❌ ${e.message}`),
  });
  const delObj = useMutation({
    mutationFn: (key: string) => api(`/api/custom-objects/${key}`, { method: 'DELETE' }),
    onSuccess: () => { note('🗑️ ลบออบเจ็กต์แล้ว'); setSelKey(null); qc.invalidateQueries({ queryKey: ['cobjects'] }); },
    onError: (e: any) => note(`❌ ${e.message}`),
  });
  const addField = useMutation({
    mutationFn: () => api('/api/custom-fields/defs', { method: 'POST', body: JSON.stringify({ entity: selKey, label: fld.label, data_type: fld.data_type, required: fld.required, options: fld.data_type === 'select' ? fld.options.split(',').map((s) => s.trim()).filter(Boolean) : undefined }) }),
    onSuccess: () => { note('✅ เพิ่มฟิลด์แล้ว'); setFld({ label: '', data_type: 'text', options: '', required: false }); qc.invalidateQueries({ queryKey: ['cobject', selKey] }); qc.invalidateQueries({ queryKey: ['crecords', selKey] }); qc.invalidateQueries({ queryKey: ['olayout', selKey] }); },
    onError: (e: any) => note(`❌ ${e.message}`),
  });
  const saveRec = useMutation({
    mutationFn: () => editId
      ? api(`/api/custom-objects/${selKey}/records/${editId}`, { method: 'PUT', body: JSON.stringify({ values: rec }) })
      : api(`/api/custom-objects/${selKey}/records`, { method: 'POST', body: JSON.stringify({ values: rec }) }),
    onSuccess: () => { note('✅ บันทึกเรคคอร์ดแล้ว'); resetRec(); qc.invalidateQueries({ queryKey: ['crecords', selKey] }); },
    onError: (e: any) => note(`❌ ${e.message}`),
  });
  const delRec = useMutation({
    mutationFn: (id: string) => api(`/api/custom-objects/${selKey}/records/${id}`, { method: 'DELETE' }),
    onSuccess: () => { note('🗑️ ลบเรคคอร์ดแล้ว'); qc.invalidateQueries({ queryKey: ['crecords', selKey] }); },
    onError: (e: any) => note(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title="ออบเจ็กต์กำหนดเอง (Custom objects)" description="สร้างประเภทข้อมูลของคุณเองโดยไม่ต้องเขียนโค้ด — กำหนดฟิลด์ บันทึกเรคคอร์ด (RLS แยกตามกิจการ ไม่ลงบัญชีแยกประเภท)" />

      {msg && <div className="mb-3"><Msg ok={msg.startsWith('✅') || msg.startsWith('🗑️')}>{msg}</Msg></div>}

      <div className="grid gap-6 lg:grid-cols-[minmax(260px,300px)_1fr]">
        {/* objects */}
        <Card className="h-fit">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Boxes className="size-4 text-primary" /> ออบเจ็กต์</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <StateView q={objects}>
              <div className="grid gap-1">
                {(objects.data?.objects ?? []).map((o) => (
                  <button key={o.object_key} onClick={() => { setSelKey(o.object_key); resetRec(); }} className={`rounded-md border px-3 py-2 text-left text-sm ${selKey === o.object_key ? 'border-primary bg-primary/5' : ''}`}>
                    {o.label} <span className="text-xs text-muted-foreground">/{o.object_key}</span>
                  </button>
                ))}
                {(objects.data?.objects ?? []).length === 0 && <p className="text-sm text-muted-foreground">ยังไม่มีออบเจ็กต์</p>}
              </div>
            </StateView>
            <div className="grid gap-2 border-t pt-3">
              <Label htmlFor="olabel">ออบเจ็กต์ใหม่</Label>
              <Input id="olabel" value={obj.label} onChange={(e) => setObj({ ...obj, label: e.target.value })} placeholder="เช่น เครื่องมือ (Equipment)" />
              <Input value={obj.label_en} onChange={(e) => setObj({ ...obj, label_en: e.target.value })} placeholder="ชื่ออังกฤษ (ไม่บังคับ)" />
              <Button size="sm" disabled={!obj.label.trim() || createObj.isPending} onClick={() => { setMsg(''); createObj.mutate(); }}><Plus className="size-4" /> สร้าง</Button>
            </div>
          </CardContent>
        </Card>

        {/* selected object */}
        {!selKey ? (
          <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">เลือกออบเจ็กต์ทางซ้าย หรือสร้างใหม่</CardContent></Card>
        ) : (
          <div className="grid gap-6">
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base"><Database className="size-4 text-primary" /> ฟิลด์ของ “{detail.data?.object.label ?? selKey}”</CardTitle>
                <Button size="sm" variant="ghost" disabled={delObj.isPending} onClick={() => delObj.mutate(selKey)}><Trash2 className="size-4 text-destructive" /> ลบออบเจ็กต์</Button>
              </CardHeader>
              <CardContent className="grid gap-3">
                <div className="flex flex-wrap gap-2">
                  {fields.map((f) => <Badge key={f.field_key} variant="secondary">{f.label} <span className="ml-1 opacity-70">· {f.data_type}{f.required ? ' *' : ''}</span></Badge>)}
                  {fields.length === 0 && <p className="text-sm text-muted-foreground">ยังไม่มีฟิลด์ — เพิ่มด้านล่าง</p>}
                </div>
                <div className="grid items-end gap-2 border-t pt-3 sm:grid-cols-[1fr_auto_1fr_auto_auto]">
                  <div className="grid gap-1"><Label>ชื่อฟิลด์</Label><Input value={fld.label} onChange={(e) => setFld({ ...fld, label: e.target.value })} placeholder="เช่น หมายเลขเครื่อง" /></div>
                  <div className="grid gap-1"><Label>ชนิด</Label><select className="h-9 rounded-md border bg-transparent px-3 text-sm" value={fld.data_type} onChange={(e) => setFld({ ...fld, data_type: e.target.value })}>{DATA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
                  <div className="grid gap-1"><Label>ตัวเลือก (select, คั่นด้วย ,)</Label><Input value={fld.options} disabled={fld.data_type !== 'select'} onChange={(e) => setFld({ ...fld, options: e.target.value })} placeholder="active, repair, retired" /></div>
                  <div className="grid gap-1"><Label>บังคับ</Label><select className="h-9 rounded-md border bg-transparent px-3 text-sm" value={fld.required ? '1' : '0'} onChange={(e) => setFld({ ...fld, required: e.target.value === '1' })}><option value="0">ไม่</option><option value="1">ใช่</option></select></div>
                  <Button size="sm" disabled={!fld.label.trim() || addField.isPending} onClick={() => { setMsg(''); addField.mutate(); }}><Plus className="size-4" /> เพิ่มฟิลด์</Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">เรคคอร์ด</CardTitle></CardHeader>
              <CardContent className="grid gap-4">
                <StateView q={records}>
                  {(records.data?.records ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">ยังไม่มีเรคคอร์ด</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead><tr className="border-b text-left text-muted-foreground">{fields.map((f) => <th key={f.field_key} className="px-2 py-1 font-medium">{f.label}</th>)}<th /></tr></thead>
                        <tbody>
                          {(records.data?.records ?? []).map((r) => (
                            <tr key={r.record_id} className="border-b">
                              {fields.map((f) => <td key={f.field_key} className="px-2 py-1">{String(r.values?.[f.field_key] ?? '')}</td>)}
                              <td className="px-2 py-1 text-right">
                                <Button size="sm" variant="ghost" onClick={() => { setEditId(r.record_id); setRec({ ...r.values }); }}>แก้ไข</Button>
                                <Button size="sm" variant="ghost" disabled={delRec.isPending} onClick={() => delRec.mutate(r.record_id)}><Trash2 className="size-4 text-destructive" /></Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {fields.length > 0 && (
                    <div className="grid gap-3 border-t pt-3">
                      <p className="text-sm font-medium">{editId ? `แก้ไขเรคคอร์ด #${editId}` : 'เพิ่มเรคคอร์ดใหม่'}</p>
                      {formSections.map((sec, i) => (
                        <div key={i} className="grid gap-2">
                          {sec.title && <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{sec.title}</p>}
                          <div className={`grid gap-3 ${sec.columns === 2 ? 'sm:grid-cols-2' : ''}`}>
                            {sec.fields.map((f) => (
                              <div key={f.field_key} className="grid gap-1">
                                <Label>{f.label}{f.required ? ' *' : ''}</Label>
                                <FieldInput f={f} value={rec[f.field_key]} onChange={(v) => setRec((x) => ({ ...x, [f.field_key]: v }))} />
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                      <div className="flex items-center gap-3">
                        <Button size="sm" disabled={saveRec.isPending} onClick={() => { setMsg(''); saveRec.mutate(); }}>{saveRec.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} {editId ? 'อัปเดต' : 'เพิ่ม'}</Button>
                        {editId && <Button size="sm" variant="outline" onClick={resetRec}>ยกเลิก</Button>}
                      </div>
                    </div>
                  )}
                </StateView>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
