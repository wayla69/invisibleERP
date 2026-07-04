'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck2, Layers, PackageSearch, SearchX } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { statusVariant } from '@/components/ui';

const cols = [
  { key: 'lot_no', label: 'ล็อต' },
  { key: 'item_id', label: 'สินค้า' },
  { key: 'location_id', label: 'คลัง' },
  { key: 'balance', label: 'คงเหลือ', align: 'right' as const, render: (r: any) => num(r.balance) },
  { key: 'expiry_date', label: 'หมดอายุ', render: (r: any) => thaiDate(r.expiry_date) },
  { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
];

export default function LotsPage() {
  return (
    <div>
      <PageHeader title="ล็อต / อายุสินค้า (Lots & Expiry)" description="ทะเบียนล็อต การหมดอายุ และคำแนะนำหยิบแบบ FEFO" />
      <Tabs tabs={[{ key: 'ledger', label: 'ทะเบียนล็อต', content: <Ledger /> }, { key: 'expiry', label: 'ใกล้หมดอายุ', content: <Expiry /> }, { key: 'fefo', label: 'FEFO', content: <Fefo /> }]} />
    </div>
  );
}

function Ledger() {
  const [item, setItem] = useState('');
  const q = useQuery<any>({ queryKey: ['lots', item], queryFn: () => api(`/api/lots${item ? `?item_id=${encodeURIComponent(item)}` : ''}`) });
  return (
    <div className="space-y-3">
      <Input className="max-w-xs" placeholder="กรองด้วยรหัสสินค้า" value={item} onChange={(e) => setItem(e.target.value)} />
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.lots}
            columns={cols}
            emptyState={
              item
                ? {
                    icon: SearchX,
                    title: 'ไม่พบล็อตที่ตรงกับตัวกรอง',
                    description: 'ลองตรวจสอบรหัสสินค้า หรือล้างตัวกรองเพื่อดูทั้งหมด',
                    action: (
                      <Button variant="outline" size="sm" onClick={() => setItem('')}>
                        ล้างตัวกรอง
                      </Button>
                    ),
                  }
                : { icon: Layers, title: 'ยังไม่มีล็อตในระบบ', description: 'ล็อตจะถูกสร้างเมื่อมีการรับสินค้าเข้าคลังพร้อมเลขล็อต' }
            }
          />
        )}
      </StateView>
    </div>
  );
}

function Expiry() {
  const q = useQuery<any>({ queryKey: ['lots-expiry'], queryFn: () => api('/api/lots/expiry') });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="หมดอายุแล้ว" value={num(q.data.summary.expired)} tone="warning" />
            <StatCard label="ภายใน 7 วัน" value={num(q.data.summary.d0_7)} tone="warning" />
            <StatCard label="8–30 วัน" value={num(q.data.summary.d8_30)} />
            <StatCard label="31+ วัน" value={num(q.data.summary.d31_plus)} tone="success" />
          </div>
          <DataTable
            rows={[...q.data.buckets.expired, ...q.data.buckets.d0_7, ...q.data.buckets.d8_30]}
            columns={[...cols, { key: 'days_to_expiry', label: 'เหลือ (วัน)', align: 'right' as const, render: (r: any) => num(r.days_to_expiry) }]}
            emptyState={{ icon: CalendarCheck2, title: 'ไม่มีล็อตใกล้หมดอายุ', description: 'ไม่มีล็อตที่หมดอายุแล้วหรือจะหมดอายุภายใน 30 วัน' }}
          />
        </div>
      )}
    </StateView>
  );
}

function Fefo() {
  const [item, setItem] = useState('');
  const q = useQuery<any>({ queryKey: ['lots-fefo', item], queryFn: () => api(`/api/lots/fefo/${encodeURIComponent(item)}`), enabled: !!item });
  return (
    <div className="space-y-3">
      <Input className="max-w-xs" placeholder="ระบุรหัสสินค้า" value={item} onChange={(e) => setItem(e.target.value)} />
      {item && (
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={q.data.lots}
              columns={cols}
              emptyState={{ icon: PackageSearch, title: 'ไม่มีล็อตคงเหลือสำหรับสินค้านี้', description: 'ตรวจสอบรหัสสินค้า หรือเลือกสินค้าที่มีสต๊อกในคลัง' }}
            />
          )}
        </StateView>
      )}
    </div>
  );
}
