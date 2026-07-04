'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CustomFields } from '@/components/custom-fields';
import { useLang } from '@/lib/i18n';

interface Def { id: number; entity: string; field_key: string; label: string; data_type: string; options: string[] | null; required: boolean; sort: number; active: boolean }

// entities a tenant can extend with custom fields (the common master/transaction records)
const ENTITIES = ['customer', 'item', 'sales_order', 'purchase_order', 'journal', 'vendor', 'employee', 'project'];

export default function CustomFieldsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [entity, setEntity] = useState('customer');
  const [label, setLabel] = useState(''); const [type, setType] = useState('text'); const [options, setOptions] = useState(''); const [required, setRequired] = useState(false);
  const [recordId, setRecordId] = useState('');
  const q = useQuery<{ fields: Def[] }>({ queryKey: ['cf-defs', entity], queryFn: () => api(`/api/custom-fields/defs?entity=${entity}`) });

  const create = useMutation({
    mutationFn: () => api('/api/custom-fields/defs', { method: 'POST', body: JSON.stringify({ entity, label, data_type: type, required, options: type === 'select' ? options.split(',').map((s) => s.trim()).filter(Boolean) : undefined }) }),
    onSuccess: () => { notifySuccess(t('mx.cf_field_added', { label })); setLabel(''); setOptions(''); setRequired(false); qc.invalidateQueries({ queryKey: ['cf-defs', entity] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/custom-fields/defs/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cf-defs', entity] }),
    onError: (e: Error) => notifyError(e.message),
  });

  return (
    <div>
      <PageHeader title={t('mx.cf_title')} description={t('mx.cf_desc')} />

      <div className="mb-6 flex items-end gap-3">
        <div>
          <Label>{t('mx.cf_entity_label')}</Label>
          <select className="h-9 w-56 rounded-md border bg-background px-2 text-sm" value={entity} onChange={(e) => setEntity(e.target.value)}>
            {ENTITIES.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm flex items-center gap-2"><SlidersHorizontal className="h-4 w-4" />{t('mx.cf_add_field_new')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><Label>{t('mx.cf_field_name')}</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('mx.cf_field_name_ph')} /></div>
              <div>
                <Label>{t('mx.cf_type')}</Label>
                <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="text">{t('mx.cf_type_text')}</option><option value="number">{t('mx.cf_type_number')}</option><option value="date">{t('mx.cf_type_date')}</option><option value="boolean">{t('mx.cf_type_boolean')}</option><option value="select">{t('mx.cf_type_select')}</option>
                </select>
              </div>
            </div>
            {type === 'select' && <div><Label>{t('mx.cf_options_label')}</Label><Input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="A, B, C" /></div>}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> {t('mx.cf_required_check')}</label>
            <div className="flex items-center gap-3">
              <Button disabled={!label || (type === 'select' && !options.trim()) || create.isPending} onClick={() => create.mutate()}>{t('mx.cf_add_field')}</Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">{t('mx.cf_try_values')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div><Label>{t('mx.cf_record_id')}</Label><Input value={recordId} onChange={(e) => setRecordId(e.target.value.trim())} placeholder={`${entity.toUpperCase()}-1`} /></div>
            {recordId
              ? <CustomFields entity={entity} recordId={recordId} title={t('mx.cf_values_title', { entity, recordId })} />
              : <p className="text-sm text-muted-foreground">{t('mx.cf_record_id_hint')}</p>}
          </CardContent>
        </Card>
      </div>

      <StateView q={q}>
        <DataTable
          rows={q.data?.fields ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'label', label: t('mx.cf_field_name') },
            { key: 'field_key', label: t('mx.cf_col_key'), render: (r) => <code className="text-xs">{r.field_key}</code> },
            { key: 'data_type', label: t('mx.cf_type'), render: (r) => <Badge variant="muted">{r.data_type}</Badge> },
            { key: 'options', label: t('mx.cf_col_options'), render: (r) => r.options?.join(', ') ?? '—' },
            { key: 'required', label: t('mx.cf_col_required'), render: (r) => r.required ? <Badge variant="warning">required</Badge> : '—' },
            { key: 'act', label: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(r.id)}><Trash2 className="h-4 w-4" /></Button> },
          ]}
          emptyState={{
            icon: SlidersHorizontal,
            title: t('mx.cf_empty_title'),
            description: t('mx.cf_empty_desc'),
          }}
        />
      </StateView>
    </div>
  );
}
