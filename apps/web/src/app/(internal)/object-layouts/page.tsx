'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LayoutTemplate, Plus, Trash2, Save, Star, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Msg } from '@/components/tabs';

type CObject = { object_key: string; label: string };
type FieldDef = { field_key: string; label: string; data_type: string; required?: boolean };
type Layout = { id: number; name: string; role: string | null; is_default: boolean; config: any };
type Section = { title: string; columns: 1 | 2 };
type Resolved = { sections: { title: string; columns: number; fields: FieldDef[] }[]; hidden: FieldDef[] };

const HIDDEN = -1;

export default function ObjectLayoutsPage() {
  const qc = useQueryClient();
  const [selKey, setSelKey] = useState('');
  const [editId, setEditId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [sections, setSections] = useState<Section[]>([{ title: 'ข้อมูล', columns: 1 }]);
  const [assign, setAssign] = useState<Record<string, number>>({}); // field_key → section index | HIDDEN
  const [preview, setPreview] = useState<Resolved | null>(null);
  const [msg, setMsg] = useState('');

  const objects = useQuery<{ objects: CObject[] }>({ queryKey: ['cobjects'], queryFn: () => api('/api/custom-objects') });
  const detail = useQuery<{ fields: FieldDef[] }>({ queryKey: ['cobject', selKey], queryFn: () => api(`/api/custom-objects/${selKey}`), enabled: !!selKey });
  const layouts = useQuery<{ layouts: Layout[] }>({ queryKey: ['olayouts', selKey], queryFn: () => api(`/api/object-layouts?object_key=${selKey}`), enabled: !!selKey });
  const fields = detail.data?.fields ?? [];

  const resetEditor = (flds: FieldDef[] = fields) => {
    setEditId(null); setName(''); setRole('');
    setSections([{ title: 'ข้อมูล', columns: 1 }]);
    setAssign(Object.fromEntries(flds.map((f) => [f.field_key, 0])));
    setMsg('');
  };
  // when the object changes, seed a fresh editor once its fields load
  useEffect(() => { if (selKey && detail.data) resetEditor(detail.data.fields); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [selKey, detail.data]);

  const loadLayout = (l: Layout) => {
    setEditId(l.id); setName(l.name); setRole(l.role ?? '');
    const secs: Section[] = (l.config?.sections ?? []).map((s: any) => ({ title: s.title ?? '', columns: s.columns === 2 ? 2 : 1 }));
    const a: Record<string, number> = {};
    (l.config?.sections ?? []).forEach((s: any, i: number) => (s.fields ?? []).forEach((k: string) => { a[k] = i; }));
    (l.config?.hidden ?? []).forEach((k: string) => { a[k] = HIDDEN; });
    fields.forEach((f) => { if (a[f.field_key] === undefined) a[f.field_key] = 0; }); // unplaced → first section
    setSections(secs.length ? secs : [{ title: 'ข้อมูล', columns: 1 }]);
    setAssign(a); setMsg('');
  };

  const buildConfig = () => ({
    sections: sections.map((s, i) => ({ title: s.title, columns: s.columns, fields: fields.filter((f) => assign[f.field_key] === i).map((f) => f.field_key) })),
    hidden: fields.filter((f) => assign[f.field_key] === HIDDEN).map((f) => f.field_key),
  });

  const runPreview = async () => {
    try { setPreview(await api<Resolved>('/api/object-layouts/preview', { method: 'POST', body: JSON.stringify({ object_key: selKey, role: role || undefined, config: buildConfig() }) })); }
    catch (e: any) { setMsg(`❌ ${e.message}`); }
  };
  useEffect(() => { if (selKey && fields.length) runPreview(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [assign, sections, selKey]);

  const save = useMutation({
    mutationFn: () => editId
      ? api(`/api/object-layouts/${editId}`, { method: 'PUT', body: JSON.stringify({ name, config: buildConfig() }) })
      : api('/api/object-layouts', { method: 'POST', body: JSON.stringify({ object_key: selKey, name, role: role || undefined, config: buildConfig() }) }),
    onSuccess: (r: any) => { setMsg('✅ บันทึกเลย์เอาต์แล้ว'); if (!editId && r?.id) setEditId(Number(r.id)); qc.invalidateQueries({ queryKey: ['olayouts', selKey] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const setDefault = useMutation({ mutationFn: (id: number) => api(`/api/object-layouts/${id}/default`, { method: 'POST' }), onSuccess: () => { setMsg('✅ ตั้งเป็นค่าเริ่มต้นแล้ว'); qc.invalidateQueries({ queryKey: ['olayouts', selKey] }); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });
  const remove = useMutation({ mutationFn: (id: number) => api(`/api/object-layouts/${id}`, { method: 'DELETE' }), onSuccess: () => { setMsg('🗑️ ลบแล้ว'); resetEditor(); qc.invalidateQueries({ queryKey: ['olayouts', selKey] }); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });

  return (
    <div>
      <PageHeader title="เลย์เอาต์ฟอร์ม (Form layouts)" description="จัดวางฟอร์มของออบเจ็กต์กำหนดเอง — แบ่งส่วน เรียงฟิลด์ ตั้งคอลัมน์ ซ่อนฟิลด์ ได้ตามบทบาท (ไม่กระทบข้อมูล/บัญชี)" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Label htmlFor="obj" className="text-sm">ออบเจ็กต์</Label>
        <select id="obj" className="h-9 rounded-md border bg-transparent px-3 text-sm" value={selKey} onChange={(e) => setSelKey(e.target.value)}>
          <option value="">— เลือก —</option>
          {(objects.data?.objects ?? []).map((o) => <option key={o.object_key} value={o.object_key}>{o.label} (/{o.object_key})</option>)}
        </select>
        {selKey && <Button size="sm" variant="outline" onClick={() => resetEditor()}><Plus className="size-4" /> เลย์เอาต์ใหม่</Button>}
        {msg && <Msg ok={msg.startsWith('✅') || msg.startsWith('🗑️')}>{msg}</Msg>}
      </div>

      {!selKey ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">เลือกออบเจ็กต์เพื่อออกแบบฟอร์ม</CardContent></Card>
      ) : fields.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">ออบเจ็กต์นี้ยังไม่มีฟิลด์ — เพิ่มฟิลด์ที่หน้า “ออบเจ็กต์กำหนดเอง” ก่อน</CardContent></Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_minmax(300px,380px)]">
          <div className="grid gap-6">
            {(layouts.data?.layouts ?? []).length > 0 && (
              <Card>
                <CardHeader><CardTitle className="text-base">เลย์เอาต์ที่บันทึกไว้</CardTitle></CardHeader>
                <CardContent className="grid gap-2">
                  {(layouts.data?.layouts ?? []).map((l) => (
                    <div key={l.id} className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${editId === l.id ? 'border-primary bg-primary/5' : ''}`}>
                      <button className="flex-1 text-left" onClick={() => loadLayout(l)}>{l.name} {l.role && <span className="text-xs text-muted-foreground">· {l.role}</span>} {l.is_default && <Badge variant="success" className="ml-2"><Star className="size-3" /> เริ่มต้น</Badge>}</button>
                      <div className="flex gap-2">
                        {!l.is_default && <Button size="sm" variant="ghost" onClick={() => setDefault.mutate(l.id)}><Star className="size-4" /></Button>}
                        <Button size="sm" variant="ghost" onClick={() => remove.mutate(l.id)}><Trash2 className="size-4 text-destructive" /></Button>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader><CardTitle className="text-base">{editId ? 'แก้ไขเลย์เอาต์' : 'เลย์เอาต์ใหม่'}</CardTitle></CardHeader>
              <CardContent className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1"><Label>ชื่อเลย์เอาต์</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น ฟอร์มหลัก" /></div>
                  <div className="grid gap-1"><Label>บทบาท (ไม่บังคับ — ว่าง = ทุกบทบาท)</Label><Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="เช่น Warehouse" /></div>
                </div>

                <div className="grid gap-2">
                  <div className="flex items-center justify-between">
                    <Label>ส่วน (Sections)</Label>
                    <Button size="sm" variant="outline" onClick={() => setSections((s) => [...s, { title: `ส่วนที่ ${s.length + 1}`, columns: 1 }])}><Plus className="size-4" /> เพิ่มส่วน</Button>
                  </div>
                  {sections.map((s, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input value={s.title} onChange={(e) => setSections((arr) => arr.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} placeholder={`ส่วนที่ ${i + 1}`} />
                      <select className="h-9 rounded-md border bg-transparent px-2 text-sm" value={s.columns} onChange={(e) => setSections((arr) => arr.map((x, j) => j === i ? { ...x, columns: Number(e.target.value) === 2 ? 2 : 1 } : x))}>
                        <option value={1}>1 คอลัมน์</option><option value={2}>2 คอลัมน์</option>
                      </select>
                      {sections.length > 1 && <Button size="sm" variant="ghost" onClick={() => { setSections((arr) => arr.filter((_, j) => j !== i)); setAssign((a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v === i ? 0 : v > i ? v - 1 : v]))); }}><Trash2 className="size-4 text-destructive" /></Button>}
                    </div>
                  ))}
                </div>

                <div className="grid gap-2">
                  <Label>การจัดวางฟิลด์</Label>
                  {fields.map((f) => (
                    <div key={f.field_key} className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm">
                      <span>{f.label}{f.required ? ' *' : ''} <span className="text-xs text-muted-foreground">· {f.data_type}</span></span>
                      <select className="h-8 rounded-md border bg-transparent px-2 text-sm" value={assign[f.field_key] ?? 0} onChange={(e) => setAssign((a) => ({ ...a, [f.field_key]: Number(e.target.value) }))}>
                        {sections.map((s, i) => <option key={i} value={i}>{s.title || `ส่วนที่ ${i + 1}`}</option>)}
                        <option value={HIDDEN}>— ซ่อน —</option>
                      </select>
                    </div>
                  ))}
                </div>

                <div className="flex items-center gap-3">
                  <Button onClick={() => { setMsg(''); save.mutate(); }} disabled={save.isPending || !name.trim()}><Save className="size-4" /> บันทึก</Button>
                  <Button variant="outline" onClick={runPreview}><RefreshCw className="size-4" /> รีเฟรชตัวอย่าง</Button>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* preview */}
          <Card className="lg:sticky lg:top-4 h-fit">
            <CardHeader><CardTitle className="text-base">ตัวอย่างฟอร์ม</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              {(preview?.sections ?? []).map((sec, i) => (
                <div key={i} className="grid gap-2">
                  {sec.title && <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{sec.title}</p>}
                  <div className={`grid gap-2 ${sec.columns === 2 ? 'grid-cols-2' : ''}`}>
                    {sec.fields.map((f) => (
                      <div key={f.field_key} className="grid gap-1">
                        <Label className="text-xs">{f.label}{f.required ? ' *' : ''}</Label>
                        <div className="h-8 rounded-md border bg-muted/40" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {(preview?.hidden ?? []).length > 0 && <p className="text-xs text-muted-foreground">ซ่อน: {(preview?.hidden ?? []).map((f) => f.label).join(', ')}</p>}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
