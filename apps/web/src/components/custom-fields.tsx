'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Msg } from '@/components/tabs';

export interface CFField { id: number; field_key: string; label: string; label_en: string | null; data_type: string; options: string[] | null; required: boolean; help_text: string | null; value: any }

// Reusable panel: renders + saves a record's custom-field values for one entity. Drop it onto any record
// screen with <CustomFields entity="customer" recordId={id} />. Renders nothing if the tenant defined no fields.
export function CustomFields({ entity, recordId, title }: { entity: string; recordId: string; title?: string }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState('');
  const key = ['cf-values', entity, recordId];
  const q = useQuery<{ fields: CFField[] }>({ queryKey: key, queryFn: () => api(`/api/custom-fields/values?entity=${encodeURIComponent(entity)}&record_id=${encodeURIComponent(recordId)}`), enabled: !!recordId });
  const save = useMutation({
    mutationFn: () => api('/api/custom-fields/values', { method: 'PUT', body: JSON.stringify({ entity, record_id: recordId, values: collect(q.data?.fields ?? [], draft) }) }),
    onSuccess: () => { setMsg('✅ ' + t('mx.cfld_saved')); setDraft({}); qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });

  const fields = q.data?.fields ?? [];
  if (!q.isLoading && fields.length === 0) return null;
  const val = (f: CFField) => (f.field_key in draft ? draft[f.field_key] : f.value);
  const set = (k: string, v: any) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-3 text-sm font-semibold">{title ?? t('mx.cfld_title')}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.field_key}>
            <Label>{f.label}{f.required && <span className="text-destructive"> *</span>}</Label>
            {f.data_type === 'select' ? (
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={val(f) ?? ''} onChange={(e) => set(f.field_key, e.target.value)}>
                <option value="">—</option>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.data_type === 'boolean' ? (
              <div className="flex h-9 items-center"><input type="checkbox" checked={!!val(f)} onChange={(e) => set(f.field_key, e.target.checked)} /></div>
            ) : (
              <Input type={f.data_type === 'date' ? 'date' : f.data_type === 'number' ? 'number' : 'text'} value={val(f) ?? ''} onChange={(e) => set(f.field_key, e.target.value)} />
            )}
            {f.help_text && <p className="mt-0.5 text-xs text-muted-foreground">{f.help_text}</p>}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" disabled={Object.keys(draft).length === 0 || save.isPending} onClick={() => save.mutate()}>{t('mx.cfld_save')}</Button>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </div>
    </div>
  );
}

// merge the saved values with the draft edits → the full value map to PUT (so required fields are present)
function collect(fields: CFField[], draft: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of fields) {
    const v = f.field_key in draft ? draft[f.field_key] : f.value;
    if (v !== undefined && v !== null && v !== '') out[f.field_key] = v;
  }
  return out;
}
