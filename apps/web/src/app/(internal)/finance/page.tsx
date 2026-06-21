'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Kpi, DataTable, Badge, StateView } from '@/components/ui';
import { baht, thaiDate } from '@/lib/format';

export default function FinancePage() {
  const kpi = useQuery<any>({ queryKey: ['fin-kpi'], queryFn: () => api('/api/finance/kpi') });
  const ar = useQuery<any>({ queryKey: ['fin-ar'], queryFn: () => api('/api/finance/ar?limit=50') });
  const ap = useQuery<any>({ queryKey: ['fin-ap'], queryFn: () => api('/api/finance/ap?status=Unpaid&limit=50') });

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>💵 การเงิน (Finance)</h1>
      <StateView q={kpi}>
        {kpi.data && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <Kpi label="รายได้ MTD" value={baht(kpi.data.mtd_revenue)} accent="var(--navy)" />
            <Kpi label="รายได้ YTD" value={baht(kpi.data.ytd_revenue)} />
            <Kpi label="ลูกหนี้คงค้าง (AR)" value={baht(kpi.data.ar_outstanding)} accent="var(--ruby)" />
            <Kpi label="เจ้าหนี้คงค้าง (AP)" value={baht(kpi.data.ap_outstanding)} accent="var(--ruby)" />
          </div>
        )}
      </StateView>

      <h3>ลูกหนี้ (AR)</h3>
      <StateView q={ar}>
        {ar.data && (
          <DataTable
            rows={ar.data.invoices}
            columns={[
              { key: 'Invoice_No', label: 'เลขที่' },
              { key: 'Customer_Name', label: 'ลูกค้า' },
              { key: 'Due_Date', label: 'ครบกำหนด', render: (r: any) => thaiDate(r.Due_Date) },
              { key: 'Amount', label: 'ยอด', render: (r: any) => baht(r.Amount) },
              { key: 'Outstanding_Amount', label: 'คงค้าง', render: (r: any) => baht(r.Outstanding_Amount) },
              { key: 'Status', label: 'สถานะ', render: (r: any) => <Badge value={r.Status} /> },
            ]}
          />
        )}
      </StateView>

      <h3 style={{ marginTop: 20 }}>เจ้าหนี้ (AP)</h3>
      <StateView q={ap}>
        {ap.data && (
          <DataTable
            rows={ap.data.transactions}
            columns={[
              { key: 'Transaction_ID', label: 'เลขที่' },
              { key: 'Creditor_Name', label: 'เจ้าหนี้' },
              { key: 'Due_Date', label: 'ครบกำหนด', render: (r: any) => thaiDate(r.Due_Date) },
              { key: 'Amount', label: 'ยอด', render: (r: any) => baht(r.Amount) },
              { key: 'Outstanding_Amount', label: 'คงค้าง', render: (r: any) => baht(r.Outstanding_Amount) },
              { key: 'Status', label: 'สถานะ', render: (r: any) => <Badge value={r.Status} /> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
