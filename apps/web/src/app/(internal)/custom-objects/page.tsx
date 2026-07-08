'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, Plus, Trash2, Save, Loader2, Database } from 'lucide-react';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { DataTable } from '@/components/data-table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Msg } from '@/components/tabs';
import { useLang } from '@/lib/i18n';

type CObject = { object_key: string; label: string; label_en?: string | null; icon?: string | null };
type FieldDef = { field_key: string; label: string; data_type: string; options?: string[] | null; required?: boolean };
type CRecord = { record_id: string; display_name: string | null; values: Record<string, any> };

const DATA_TYPES = ['text', 'number', 'date', 'boolean', 'select'] as const;

// One input rendered per field type.
function FieldInput({ f, value, onChange }: { f: FieldDef; value: any; onChange: (v: any) => void }) {
  const { t } = useLang();
  const cls = 'h-9 rounded-md border bg-transparent px-3 text-sm';
  if (f.data_type === 'boolean') return <select className={cls} value={value ? '1' : '0'} onChange={(e) => onChange(e.target.value === '1')}><option value="0">{t('mx.co_no')}</option><option value="1">{t('mx.co_yes')}</option></select>;
  if (f.data_type === 'select') return <select className={cls} value={value ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>;
  if (f.data_type === 'number') return <Input type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  if (f.data_type === 'date') return <Input type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  return <Input value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

export default function CustomObjectsPage() {
  const { t } = useLang();
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
    onSuccess: (r: any) => { note('✅ ' + t('mx.co_obj_created')); setObj({ label: '', label_en: '', icon: '' }); qc.invalidateQueries({ queryKey: ['cobjects'] }); setSelKey(r.object_key); },
    onError: (e: any) => note(`❌ ${e.message}`),
  });
  const delObj = useMutation({
    mutationFn: (key: string) => api(`/api/custom-objects/${key}`, { method: 'DELETE' }),
    onSuccess: () => { note('🗑️ ' + t('mx.co_obj_deleted')); setSelKey(null); qc.invalidateQueries({ queryKey: ['cobjects'] }); },
    onError: (e: any) => note(`❌ ${e.message}`),
  });
  const addField = useMutation({
    mutationFn: () => api('/api/custom-fields/defs', { method: 'POST', body: JSON.stringify({ entity: selKey, label: fld.label, data_type: fld.data_type, required: fld.required, options: fld.data_type === 'select' ? fld.options.split(',').map((s) => s.trim()).filter(Boolean) : undefined }) }),
    onSuccess: () => { note('✅ ' + t('mx.co_field_added')); setFld({ label: '', data_type: 'text', options: '', required: false }); qc.invalidateQueries({ queryKey: ['cobject', selKey] }); qc.invalidateQueries({ queryKey: ['crecords', selKey] }); qc.invalidateQueries({ queryKey: ['olayout', selKey] }); },
    onError: (e: any) => note(`❌ ${e.message}`),
  });
  const saveRec = useMutation({
    mutationFn: () => editId
      ? api(`/api/custom-objects/${selKey}/records/${editId}`, { method: 'PUT', body: JSON.stringify({ values: rec }) })
      : api(`/api/custom-objects/${selKey}/records`, { method: 'POST', body: JSON.stringify({ values: rec }) }),
    onSuccess: () => { note('✅ ' + t('mx.co_record_saved')); resetRec(); qc.invalidateQueries({ queryKey: ['crecords', selKey] }); },
    onError: (e: any) => note(`❌ ${e.message}`),
  });
  const delRec = useMutation({
    mutationFn: (id: string) => api(`/api/custom-objects/${selKey}/records/${id}`, { method: 'DELETE' }),
    onSuccess: () => { note('🗑️ ' + t('mx.co_record_deleted')); qc.invalidateQueries({ queryKey: ['crecords', selKey] }); },
    onError: (e: any) => note(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title={t('mx.co_title')} description={t('mx.co_desc')} />

      {msg && <div className="mb-3"><Msg ok={msg.startsWith('✅') || msg.startsWith('🗑️')}>{msg}</Msg></div>}

      <div className="grid gap-6 lg:grid-cols-[minmax(260px,300px)_1fr]">
        {/* objects */}
        <Card className="h-fit">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Boxes className="size-4 text-primary" /> {t('mx.co_objects')}</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <StateView q={objects}>
              <div className="grid gap-1">
                {(objects.data?.objects ?? []).map((o) => (
                  <button key={o.object_key} onClick={() => { setSelKey(o.object_key); resetRec(); }} className={`rounded-md border px-3 py-2 text-left text-sm ${selKey === o.object_key ? 'border-primary bg-primary/5' : ''}`}>
                    {o.label} <span className="text-xs text-muted-foreground">/{o.object_key}</span>
                  </button>
                ))}
                {(objects.data?.objects ?? []).length === 0 && <p className="text-sm text-muted-foreground">{t('mx.co_no_objects')}</p>}
              </div>
            </StateView>
            <div className="grid gap-2 border-t pt-3">
              <Label htmlFor="olabel">{t('mx.co_new_object')}</Label>
              <Input id="olabel" value={obj.label} onChange={(e) => setObj({ ...obj, label: e.target.value })} placeholder={t('mx.co_new_object_ph')} />
              <Input value={obj.label_en} onChange={(e) => setObj({ ...obj, label_en: e.target.value })} placeholder={t('mx.co_label_en_ph')} />
              <Button size="sm" disabled={!obj.label.trim() || createObj.isPending} onClick={() => { setMsg(''); createObj.mutate(); }}><Plus className="size-4" /> {t('mx.co_create')}</Button>
            </div>
          </CardContent>
        </Card>

        {/* selected object */}
        {!selKey ? (
          <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">{t('mx.co_select_hint')}</CardContent></Card>
        ) : (
          <div className="grid gap-6">
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base"><Database className="size-4 text-primary" /> {t('mx.co_fields_of', { name: detail.data?.object.label ?? selKey })}</CardTitle>
                <Button size="sm" variant="ghost" disabled={delObj.isPending} onClick={() => delObj.mutate(selKey)}><Trash2 className="size-4 text-destructive" /> {t('mx.co_delete_object')}</Button>
              </CardHeader>
              <CardContent className="grid gap-3">
                <div className="flex flex-wrap gap-2">
                  {fields.map((f) => <Badge key={f.field_key} variant="secondary">{f.label} <span className="ml-1 opacity-70">· {f.data_type}{f.required ? ' *' : ''}</span></Badge>)}
                  {fields.length === 0 && <p className="text-sm text-muted-foreground">{t('mx.co_no_fields')}</p>}
                </div>
                <div className="grid items-end gap-2 border-t pt-3 sm:grid-cols-[1fr_auto_1fr_auto_auto]">
                  <div className="grid gap-1"><Label>{t('mx.co_field_name')}</Label><Input value={fld.label} onChange={(e) => setFld({ ...fld, label: e.target.value })} placeholder={t('mx.co_field_name_ph')} /></div>
                  <div className="grid gap-1"><Label>{t('mx.co_type')}</Label><select className="h-9 rounded-md border bg-transparent px-3 text-sm" value={fld.data_type} onChange={(e) => setFld({ ...fld, data_type: e.target.value })}>{DATA_TYPES.map((dt) => <option key={dt} value={dt}>{dt}</option>)}</select></div>
                  <div className="grid gap-1"><Label>{t('mx.co_options_label')}</Label><Input value={fld.options} disabled={fld.data_type !== 'select'} onChange={(e) => setFld({ ...fld, options: e.target.value })} placeholder="active, repair, retired" /></div>
                  <div className="grid gap-1"><Label>{t('mx.co_required')}</Label><select className="h-9 rounded-md border bg-transparent px-3 text-sm" value={fld.required ? '1' : '0'} onChange={(e) => setFld({ ...fld, required: e.target.value === '1' })}><option value="0">{t('mx.co_no')}</option><option value="1">{t('mx.co_yes')}</option></select></div>
                  <Button size="sm" disabled={!fld.label.trim() || addField.isPending} onClick={() => { setMsg(''); addField.mutate(); }}><Plus className="size-4" /> {t('mx.co_add_field')}</Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">{t('mx.co_records')}</CardTitle></CardHeader>
              <CardContent className="grid gap-4">
                <StateView q={records}>
                  {(records.data?.records ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('mx.co_no_records')}</p>
                  ) : (
                    <DataTable
                      dense
                      // Flatten each record's dynamic values onto the row so the built-in column sort
                      // (which reads row[key]) works; record_id/values spread LAST so a field key can't shadow them.
                      rows={(records.data?.records ?? []).map((r) => ({ ...r.values, record_id: r.record_id, values: r.values }))}
                      rowKey={(r) => r.record_id}
                      columns={[
                        // Dynamic column spec — one column per user-defined field (the object's own schema).
                        ...fields.map((f) => ({ key: f.field_key, label: f.label, sortable: true, render: (r: any) => String(r.values?.[f.field_key] ?? '') })),
                        { key: '_actions', label: '', align: 'right' as const, render: (r: any) => (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => { setEditId(r.record_id); setRec({ ...r.values }); }}>{t('mx.co_edit')}</Button>
                            <Button size="sm" variant="ghost" disabled={delRec.isPending} onClick={() => delRec.mutate(r.record_id)}><Trash2 className="size-4 text-destructive" /></Button>
                          </>
                        ) },
                      ]}
                    />
                  )}

                  {fields.length > 0 && (
                    <div className="grid gap-3 border-t pt-3">
                      <p className="text-sm font-medium">{editId ? t('mx.co_edit_record', { editId }) : t('mx.co_add_record')}</p>
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
                        <Button size="sm" disabled={saveRec.isPending} onClick={() => { setMsg(''); saveRec.mutate(); }}>{saveRec.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} {editId ? t('mx.co_update') : t('mx.co_add')}</Button>
                        {editId && <Button size="sm" variant="outline" onClick={resetRec}>{t('fin.cancel')}</Button>}
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
