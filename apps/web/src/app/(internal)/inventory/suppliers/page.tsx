'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchX, Truck } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { ModulePage } from '@/components/module-page';
import { SearchInput } from '@/components/search-input';
import { DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';

interface Supplier { Supplier_ID: string; Supplier_Name?: string; Contact_Person?: string; Phone?: string; Payment_Terms?: string }

export default function SuppliersPage() {
  const q = useQuery<{ suppliers: Supplier[] }>({ queryKey: ['suppliers'], queryFn: () => api('/api/inventory/suppliers') });
  const rows = q.data?.suppliers ?? [];
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) => [r.Supplier_ID, r.Supplier_Name, r.Contact_Person, r.Phone].some((v) => (v ?? '').toLowerCase().includes(term)));
  }, [rows, search]);

  return (
    <ModulePage
      title="ผู้ขาย (Suppliers)"
      description="รายชื่อผู้ขายและเงื่อนไขการชำระเงิน"
      query={q}
      toolbar={
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="ค้นหาชื่อ / รหัส / ผู้ติดต่อ…"
          ariaLabel="ค้นหาผู้ขาย"
          count={
            q.data
              ? `${num(filtered.length)}${search && filtered.length !== rows.length ? ` จาก ${num(rows.length)}` : ''} ราย`
              : undefined
          }
        />
      }
    >
      {q.data && (
        <DataTable
          rows={filtered}
          rowKey={(r) => r.Supplier_ID}
          emptyState={
            search
              ? {
                  icon: SearchX,
                  title: 'ไม่พบผู้ขายที่ตรงกับการค้นหา',
                  description: 'ลองปรับคำค้นหา หรือล้างตัวกรองเพื่อดูทั้งหมด',
                  action: (
                    <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                      ล้างตัวกรอง
                    </Button>
                  ),
                }
              : { icon: Truck, title: 'ยังไม่มีผู้ขาย', description: 'เพิ่มผู้ขายในข้อมูลหลักเพื่อเริ่มต้น' }
          }
          columns={[
            { key: 'Supplier_ID', label: 'รหัส' },
            { key: 'Supplier_Name', label: 'ชื่อ', render: (r) => r.Supplier_Name || '—' },
            { key: 'Contact_Person', label: 'ผู้ติดต่อ', render: (r) => r.Contact_Person || '—' },
            { key: 'Phone', label: 'โทร', render: (r) => r.Phone || '—' },
            { key: 'Payment_Terms', label: 'เครดิต', render: (r) => r.Payment_Terms || '—' },
          ]}
        />
      )}
    </ModulePage>
  );
}
