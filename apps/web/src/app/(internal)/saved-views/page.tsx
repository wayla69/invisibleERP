'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bookmark, Plus, Trash2 } from 'lucide-react';
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

interface SavedView { id: number; module: string; name: string; config: Record<string, unknown>; shared: boolean; owner: string; mine: boolean }

// Common list screens a saved view can attach to. Saving from within a screen will populate this automatically;
// this page lets a user review and manage every view they own or that has been shared with them.
const MODULES = ['inventory', 'orders', 'vendors', 'customers', 'invoices', 'purchase-orders'];

export default function SavedViewsPage() {
  const qc = useQueryClient();
  const [module, setModule] = useState('inventory');
  const [name, setName] = useState(''); const [shared, setShared] = useState(false);
  const [msg, setMsg] = useState('');
  const q = useQuery<{ views: SavedView[] }>({ queryKey: ['saved-views', module], queryFn: () => api(`/api/saved-views?module=${encodeURIComponent(module)}`) });

  const create = useMutation({
    mutationFn: () => api('/api/saved-views', { method: 'POST', body: JSON.stringify({ module, name, config: {}, shared }) }),
    onSuccess: () => { setMsg(`✅ บันทึกมุมมอง ${name}`); setName(''); qc.invalidateQueries({ queryKey: ['saved-views', module] }); },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });
  const remove = useMutation({ mutationFn: (id: number) => api(`/api/saved-views/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-views', module] }), onError: (e: Error) => setMsg(`❌ ${e.message}`) });

  return (
    <div>
      <PageHeader title="มุมมองที่บันทึกไว้ (Saved views)" description="บันทึกตัวกรอง/การจัดเรียงของหน้ารายการต่าง ๆ ไว้ใช้ซ้ำ — ส่วนตัวหรือแชร์ให้ทั้งองค์กร" />
      <div className="space-y-6">
        <Card>
          <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Bookmark className="h-4 w-4" />บันทึกมุมมองใหม่</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div><Label>หน้าจอ (โมดูล)</Label>
                <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={module} onChange={(e) => setModule(e.target.value)}>
                  {MODULES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div><Label>ชื่อมุมมอง</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น สต๊อกต่ำ" /></div>
              <div className="flex items-end gap-2">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />แชร์ให้ทั้งองค์กร</label>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button disabled={!name || create.isPending} onClick={() => create.mutate()}><Plus className="mr-1 h-4 w-4" />บันทึก</Button>
              <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
            </div>
          </CardContent>
        </Card>
        <StateView q={q}>
          <DataTable
            rows={q.data?.views ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: 'name', label: 'ชื่อมุมมอง' },
              { key: 'module', label: 'หน้าจอ', render: (r) => <code className="text-xs">{r.module}</code> },
              { key: 'shared', label: 'การมองเห็น', render: (r) => <Badge variant={r.shared ? 'info' : 'muted'}>{r.shared ? 'แชร์' : 'ส่วนตัว'}</Badge> },
              { key: 'owner', label: 'เจ้าของ', render: (r) => r.mine ? 'ฉัน' : r.owner },
              { key: 'act', label: '', align: 'right', render: (r) => r.mine ? <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(r.id)}><Trash2 className="h-4 w-4" /></Button> : null },
            ]}
            emptyText="ยังไม่มีมุมมองที่บันทึกไว้"
          />
        </StateView>
      </div>
    </div>
  );
}
