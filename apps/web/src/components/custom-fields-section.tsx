// Flexfields on the master screens (master-data audit Phase 9). Renders a tenant's user-defined custom
// fields (the existing custom-fields engine — Oracle DFF equivalent) inline on a customer/vendor record and
// saves their values. Only renders when the tenant has defined fields for the entity. No 'use client':
// imported only by already-'use client' pages, inherits their boundary.
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifyError, notifySuccess } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/form-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface CustomFieldDef { field_key: string; label: string; data_type: string; options?: string[]; required?: boolean; value: unknown }

export function CustomFieldsSection({ entity, recordId }: { entity: string; recordId: string }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ fields: CustomFieldDef[] }>({ queryKey: ['custom-fields', entity, recordId], queryFn: () => api(`/api/custom-fields/values?entity=${entity}&record_id=${encodeURIComponent(recordId)}`) });
  const [form, setForm] = useState<Record<string, string>>({});
  useEffect(() => {
    if (q.data) { const f: Record<string, string> = {}; for (const d of q.data.fields) f[d.field_key] = d.value == null ? '' : String(d.value); setForm(f); }
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<any>('/api/custom-fields/values', { method: 'PUT', body: JSON.stringify({ entity, record_id: recordId, values: form }) }),
    onSuccess: () => { notifySuccess(t('mx.cf_saved')); qc.invalidateQueries({ queryKey: ['custom-fields', entity, recordId] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const fields = q.data?.fields ?? [];
  if (!fields.length) return null;
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <div className="grid gap-2">
      <h4 className="flex items-center gap-1.5 text-sm font-medium"><SlidersHorizontal className="size-4" /> {t('mx.cf_title')}</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((d) => (
          <FormField key={d.field_key} label={d.label} required={d.required}>
            {d.data_type === 'select' && d.options?.length ? (
              <Select value={form[d.field_key] ?? ''} onValueChange={(v) => set(d.field_key, v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{d.options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
              </Select>
            ) : (
              <Input type={d.data_type === 'number' ? 'number' : d.data_type === 'date' ? 'date' : 'text'} value={form[d.field_key] ?? ''} onChange={(e) => set(d.field_key, e.target.value)} />
            )}
          </FormField>
        ))}
      </div>
      <div><Button size="sm" variant="outline" disabled={save.isPending} onClick={() => save.mutate()}>{t('mx.cf_save')}</Button></div>
    </div>
  );
}
