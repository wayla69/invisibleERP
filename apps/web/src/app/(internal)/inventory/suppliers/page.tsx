'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { ModulePage } from '@/components/module-page';
import { DataTable } from '@/components/data-table';
import { Input } from '@/components/ui/input';

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
      toolbarClassName="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      toolbar={
        <>
          <div className="relative w-full sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหาชื่อ / รหัส / ผู้ติดต่อ…"
              className="pl-9"
              aria-label="ค้นหาผู้ขาย"
              inputMode="search"
              enterKeyHint="search"
            />
          </div>
          {q.data && (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              ผู้ขายทั้งหมด <span className="tabular font-medium text-foreground">{num(filtered.length)}</span>
              {search && filtered.length !== rows.length ? ` จาก ${num(rows.length)}` : ''} ราย
            </p>
          )}
        </>
      }
    >
      {q.data && (
        <DataTable
          rows={filtered}
          rowKey={(r) => r.Supplier_ID}
          emptyText={search ? 'ไม่พบผู้ขายที่ตรงกับการค้นหา' : 'ยังไม่มีผู้ขาย'}
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
