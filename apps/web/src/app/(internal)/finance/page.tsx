'use client';

import { useQuery } from '@tanstack/react-query';
import { Banknote, ReceiptText, TrendingUp, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { statusVariant } from '@/components/ui';

export default function FinancePage() {
  const kpi = useQuery<any>({ queryKey: ['fin-kpi'], queryFn: () => api('/api/finance/kpi') });
  const ar = useQuery<any>({ queryKey: ['fin-ar'], queryFn: () => api('/api/finance/ar?limit=50') });
  const ap = useQuery<any>({ queryKey: ['fin-ap'], queryFn: () => api('/api/finance/ap?status=Unpaid&limit=50') });

  return (
    <div>
      <PageHeader title="การเงิน" description="รายได้ ลูกหนี้ และเจ้าหนี้" />
      <div className="space-y-6">
        <StateView q={kpi}>
          {kpi.data && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="รายได้ MTD" value={baht(kpi.data.mtd_revenue)} icon={Banknote} tone="primary" />
              <StatCard label="รายได้ YTD" value={baht(kpi.data.ytd_revenue)} icon={TrendingUp} tone="default" />
              <StatCard label="ลูกหนี้คงค้าง (AR)" value={baht(kpi.data.ar_outstanding)} icon={ReceiptText} tone={kpi.data.ar_outstanding > 0 ? 'warning' : 'success'} />
              <StatCard label="เจ้าหนี้คงค้าง (AP)" value={baht(kpi.data.ap_outstanding)} icon={Wallet} tone={kpi.data.ap_outstanding > 0 ? 'danger' : 'success'} />
            </div>
          )}
        </StateView>

        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ลูกหนี้ (AR)</h3>
          <StateView q={ar}>
            {ar.data && (
              <DataTable
                rows={ar.data.invoices}
                columns={[
                  { key: 'Invoice_No', label: 'เลขที่' },
                  { key: 'Customer_Name', label: 'ลูกค้า' },
                  { key: 'Due_Date', label: 'ครบกำหนด', render: (r: any) => thaiDate(r.Due_Date) },
                  { key: 'Amount', label: 'ยอด', align: 'right', render: (r: any) => <span className="tabular">{baht(r.Amount)}</span> },
                  { key: 'Outstanding_Amount', label: 'คงค้าง', align: 'right', render: (r: any) => <span className="tabular">{baht(r.Outstanding_Amount)}</span> },
                  { key: 'Status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
                ]}
              />
            )}
          </StateView>
        </div>

        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">เจ้าหนี้ (AP)</h3>
          <StateView q={ap}>
            {ap.data && (
              <DataTable
                rows={ap.data.transactions}
                columns={[
                  { key: 'Transaction_ID', label: 'เลขที่' },
                  { key: 'Creditor_Name', label: 'เจ้าหนี้' },
                  { key: 'Due_Date', label: 'ครบกำหนด', render: (r: any) => thaiDate(r.Due_Date) },
                  { key: 'Amount', label: 'ยอด', align: 'right', render: (r: any) => <span className="tabular">{baht(r.Amount)}</span> },
                  { key: 'Outstanding_Amount', label: 'คงค้าง', align: 'right', render: (r: any) => <span className="tabular">{baht(r.Outstanding_Amount)}</span> },
                  { key: 'Status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
                ]}
              />
            )}
          </StateView>
        </div>
      </div>
    </div>
  );
}
