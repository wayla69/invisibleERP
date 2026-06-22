'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';

export default function SuppliersPage() {
  const q = useQuery<any>({ queryKey: ['suppliers'], queryFn: () => api('/api/inventory/suppliers') });
  return (
    <div>
      <PageHeader title="ผู้ขาย (Suppliers)" description="รายชื่อผู้ขายและเงื่อนไขการชำระเงิน" />
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
