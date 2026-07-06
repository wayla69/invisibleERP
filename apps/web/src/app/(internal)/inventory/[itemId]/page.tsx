'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Banknote, Hash, ShoppingBag, Truck } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function StockDetailPage() {
  const { t } = useLang();
  const { itemId } = useParams<{ itemId: string }>();
  const q = useQuery<any>({ queryKey: ['stock', itemId], queryFn: () => api(`/api/inventory/stock/${encodeURIComponent(itemId)}`) });
  const d = q.data;
  return (
    <div>
      <PageHeader
        title={decodeURIComponent(itemId)}
        description={t('inv.detail_subtitle')}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/inventory">
              <ArrowLeft className="size-4" /> {t('inv.back')}
            </Link>
          </Button>
        }
      />
      <StateView q={q}>
        {d && (
          <div className="space-y-6">
            <Card>
              <CardContent>
                <p className="font-semibold">{d.item.Item_Description}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('inv.detail_meta', { uom: d.item.UOM, qty: num(d.item.AV_QTY), date: thaiDate(d.snapshot_date) })}
                </p>
              </CardContent>
            </Card>

            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label={t('inv.sales_30d')} value={baht(d.sales_30d.total_revenue)} icon={Banknote} tone="primary" />
              <StatCard label={t('inv.qty_30d')} value={num(d.sales_30d.total_qty)} icon={ShoppingBag} />
              <StatCard label={t('inv.sale_count')} value={num(d.sales_30d.sale_count)} icon={Hash} />
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('inv.recent_sales')}</h3>
              <DataTable
                rows={d.recent_sales}
                emptyState={{
                  icon: ShoppingBag,
                  title: t('inv.no_sales_title'),
                  description: t('inv.no_sales_desc'),
                }}
                columns={[
                  { key: 'Sale_No', label: t('dash.col_no') },
                  { key: 'Sale_Date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.Sale_Date) },
                  { key: 'Customer_Name', label: t('fin.col_customer') },
                  { key: 'Qty', label: t('inv.col_qty'), align: 'right', render: (r: any) => num(r.Qty) },
                  { key: 'Amount', label: t('fin.col_amount'), align: 'right', render: (r: any) => baht(r.Amount) },
                ]}
              />
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('inv.recent_pos')}</h3>
              <DataTable
                rows={d.recent_pos}
                emptyState={{
                  icon: Truck,
                  title: t('inv.no_pos_title'),
                  description: t('inv.no_pos_desc'),
                }}
                columns={[
                  { key: 'PO_No', label: t('iv.col_po_no') },
                  { key: 'PO_Date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.PO_Date) },
                  { key: 'Supplier_Name', label: t('inv.col_supplier') },
                  { key: 'Order_Qty', label: t('inv.col_ordered'), align: 'right', render: (r: any) => num(r.Order_Qty) },
                  { key: 'Received_Qty', label: t('inv.col_received'), align: 'right', render: (r: any) => num(r.Received_Qty) },
                ]}
              />
            </div>
          </div>
        )}
      </StateView>
    </div>
  );
}
