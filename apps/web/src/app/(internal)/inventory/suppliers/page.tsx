'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { DataTable, StateView } from '@/components/ui';

export default function SuppliersPage() {
  const q = useQuery<any>({ queryKey: ['suppliers'], queryFn: () => api('/api/inventory/suppliers') });
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>🏢 ผู้ขาย (Suppliers)</h1>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.suppliers}
            columns={[
              { key: 'Supplier_ID', label: 'รหัส' },
              { key: 'Supplier_Name', label: 'ชื่อ' },
              { key: 'Contact_Person', label: 'ผู้ติดต่อ' },
              { key: 'Phone', label: 'โทร' },
              { key: 'Payment_Terms', label: 'เครดิต' },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
