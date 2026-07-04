'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bookmark, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface SavedView { id: number; module: string; name: string; config: Record<string, unknown>; shared: boolean; owner: string; mine: boolean }

// Common list screens a saved view can attach to. Saving from within a screen will populate this automatically;
// this page lets a user review and manage every view they own or that has been shared with them.
const MODULES = ['inventory', 'orders', 'vendors', 'customers', 'invoices', 'purchase-orders'];

export default function SavedViewsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [module, setModule] = useState('inventory');
  const [name, setName] = useState(''); const [shared, setShared] = useState(false);
  const q = useQuery<{ views: SavedView[] }>({ queryKey: ['saved-views', module], queryFn: () => api(`/api/saved-views?module=${encodeURIComponent(module)}`) });

  const create = useMutation({
    mutationFn: () => api('/api/saved-views', { method: 'POST', body: JSON.stringify({ module, name, config: {}, shared }) }),
    onSuccess: () => { notifySuccess(t('st.sv.saved', { name })); setName(''); qc.invalidateQueries({ queryKey: ['saved-views', module] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const remove = useMutation({ mutationFn: (id: number) => api(`/api/saved-views/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-views', module] }), onError: (e: Error) => notifyError(e.message) });

  return (
    <div>
      <PageHeader title={t('st.sv.title')} description={t('st.sv.desc')} />
      <div className="space-y-6">
        <Card>
          <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Bookmark className="h-4 w-4" />{t('st.sv.save_new')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div><Label>{t('st.sv.module')}</Label>
                <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={module} onChange={(e) => setModule(e.target.value)}>
                  {MODULES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div><Label>{t('st.sv.name')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('st.sv.name_ph')} /></div>
              <div className="flex items-end gap-2">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />{t('st.sv.share_org')}</label>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button disabled={!name || create.isPending} onClick={() => create.mutate()}><Plus className="mr-1 h-4 w-4" />{t('fin.save')}</Button>
            </div>
          </CardContent>
        </Card>
        <StateView q={q}>
          <DataTable
            rows={q.data?.views ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: 'name', label: t('st.sv.name') },
              { key: 'module', label: t('st.sv.col_module'), render: (r) => <code className="text-xs">{r.module}</code> },
              { key: 'shared', label: t('st.sv.col_visibility'), render: (r) => <Badge variant={r.shared ? 'info' : 'muted'}>{r.shared ? t('st.sv.shared') : t('st.sv.private')}</Badge> },
              { key: 'owner', label: t('st.sv.col_owner'), render: (r) => r.mine ? t('st.sv.me') : r.owner },
              { key: 'act', label: '', align: 'right', render: (r) => r.mine ? <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(r.id)}><Trash2 className="h-4 w-4" /></Button> : null },
            ]}
            emptyState={{
              icon: Bookmark,
              title: t('st.sv.empty_title', { module }),
              description: t('st.sv.empty_desc'),
            }}
          />
        </StateView>
      </div>
    </div>
  );
}
