'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PackageCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { statusVariant } from '@/components/ui';
import { GrForm } from '@/components/procurement-forms';

const PO_LIST_KEY = ['receiving-pos'];

// Warehouse / receiving surface (perm: wh_receive) — confirm goods receipt (GR) against an approved PO.
// Deliberately separate from the buyer's PO page so the person who orders cannot also confirm receipt
// (SoD R04 — preserves the 3-way match). The PO list below is reference-only, to look up the PO number.
export default function ReceivingPage() {
  const qc = useQueryClient();
  const pos = useQuery<any>({ queryKey: PO_LIST_KEY, queryFn: () => api('/api/inventory/purchase-orders?limit=50') });

  return (
    <div>
      <PageHeader title="รับสินค้า (Goods Receipt)" description="ตรวจรับสินค้าเข้าคลังตามใบสั่งซื้อ (PO) — สำหรับทีมคลังสินค้า" />

      <Card className="mb-6 gap-4">
        <CardHeader>
          <CardTitle className="text-base">บันทึกการรับสินค้า (GR)</CardTitle>
        </CardHeader>
        <CardContent>
          <GrForm onDone={() => qc.invalidateQueries({ queryKey: PO_LIST_KEY })} />
        </CardContent>
      </Card>

      <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ใบสั่งซื้อที่รอรับของ</h3>
      <StateView q={pos}>
        {pos.data && (
          <DataTable
            rows={pos.data.purchase_orders}
            emptyState={{
              icon: PackageCheck,
              title: 'ยังไม่มีใบสั่งซื้อ',
              description: 'เมื่อทีมจัดซื้อออกใบสั่งซื้อแล้ว รายการจะแสดงที่นี่เพื่อให้คุณตรวจรับ',
            }}
            columns={[
              { key: 'PO_No', label: 'PO' },
              { key: 'PO_Date', label: 'วันที่', render: (r: any) => thaiDate(r.PO_Date) },
              { key: 'Supplier_Name', label: 'ผู้ขาย' },
              { key: 'Total_Amount', label: 'ยอด', align: 'right', render: (r: any) => baht(r.Total_Amount) },
              { key: 'Status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
