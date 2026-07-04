'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Warehouse, Save, X } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';

type Wh = { location_id: string; location_name?: string; zone?: string; active?: boolean; inventory_account?: string; adjustment_account?: string };

// คลังสินค้า — warehouse account defaults (docs/33 PR5, GL-21). The lowest tier of item-posting determination:
// an item's inventory/adjustment account falls through item → its category → THIS warehouse → the control account.
export default function WarehouseAccountsPage() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['setup-warehouses'], queryFn: () => api('/api/item-setup/warehouses') });
  const [editing, setEditing] = useState<string | null>(null);
  const [inv, setInv] = useState('');
  const [adj, setAdj] = useState('');

  const start = (w: Wh) => { setEditing(w.location_id); setInv(w.inventory_account ?? ''); setAdj(w.adjustment_account ?? ''); };
  const cancel = () => { setEditing(null); setInv(''); setAdj(''); };
  const save = useMutation({
    mutationFn: () => api(`/api/item-setup/warehouses/${encodeURIComponent(editing!)}`, { method: 'PATCH', body: JSON.stringify({ inventory_account: inv.trim() || null, adjustment_account: adj.trim() || null }) }),
    onSuccess: (r: any) => { notifySuccess(`บันทึกบัญชีคลัง ${r.location_id}`); cancel(); qc.invalidateQueries({ queryKey: ['setup-warehouses'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div>
      <PageHeader title="บัญชีปริยายตามคลังสินค้า (Warehouse Posting Accounts)" description="กำหนดบัญชีสินค้าคงคลัง / บัญชีปรับปรุงต่อคลัง — ใช้เมื่อสินค้าและหมวดไม่ได้ระบุบัญชีไว้ (ลำดับ: สินค้า → หมวด → คลัง → บัญชีคุมมาตรฐาน 1200 / 5810)" />
      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <StatCard label="จำนวนคลัง" value={q.data.count ?? 0} icon={Warehouse} tone="primary" className="max-w-xs" />
            <DataTable
              rows={q.data.warehouses ?? []}
              rowKey={(r: Wh) => r.location_id}
              columns={[
                { key: 'location_id', label: 'รหัสคลัง' },
                { key: 'location_name', label: 'ชื่อคลัง', render: (r: Wh) => r.location_name ?? '—' },
                { key: 'zone', label: 'โซน', render: (r: Wh) => r.zone ?? '—' },
                {
                  key: 'inventory_account', label: 'บัญชีสินค้าคงคลัง', sortable: false,
                  render: (r: Wh) => editing === r.location_id
                    ? <Input value={inv} onChange={(e) => setInv(e.target.value)} placeholder="1200" className="h-8 w-28" />
                    : (r.inventory_account ?? '—'),
                },
                {
                  key: 'adjustment_account', label: 'บัญชีปรับปรุง', sortable: false,
                  render: (r: Wh) => editing === r.location_id
                    ? <Input value={adj} onChange={(e) => setAdj(e.target.value)} placeholder="5810" className="h-8 w-28" />
                    : (r.adjustment_account ?? '—'),
                },
                { key: 'active', label: 'สถานะ', render: (r: Wh) => <Badge variant={r.active === false ? 'destructive' : 'success'}>{r.active === false ? 'ปิด' : 'ใช้งาน'}</Badge> },
                {
                  key: 'actions', label: '', sortable: false,
                  render: (r: Wh) => editing === r.location_id
                    ? <div className="flex gap-1">
                        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}><Save className="size-4" /></Button>
                        <Button size="sm" variant="outline" onClick={cancel}><X className="size-4" /></Button>
                      </div>
                    : <Button size="sm" variant="outline" onClick={() => start(r)}>แก้ไข</Button>,
                },
              ]}
              emptyState={{ icon: Warehouse, title: 'ยังไม่มีคลังสินค้า', description: 'เพิ่มคลังสินค้าได้ที่หน้านำเข้าข้อมูลหลัก (Master data)' }}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}
