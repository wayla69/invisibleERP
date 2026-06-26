'use client';

import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PrForm } from '@/components/procurement-forms';

// Company-wide requisition surface (perm: pr_raise) — anyone in the company can raise a purchase
// requisition. A PR is only a request: it is routed to Procurement for approval and conversion to a PO.
// Buying (PO) and receiving (GR) live on their own pages owned by Procurement / Warehouse (SoD R03/R04).
export default function RequisitionsPage() {
  return (
    <div>
      <PageHeader title="คำขอซื้อ (Purchase Requisition)" description="แจ้งความต้องการซื้อสินค้า/บริการ — ทุกคนในองค์กรสร้างได้ ทีมจัดซื้อจะพิจารณาอนุมัติและออกใบสั่งซื้อ (PO) ต่อไป" />

      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="text-base">สร้างคำขอซื้อ (PR)</CardTitle>
        </CardHeader>
        <CardContent>
          <PrForm />
          <p className="mt-4 text-xs text-muted-foreground">
            คำขอซื้อจะถูกส่งเข้าสู่ขั้นตอนอนุมัติของทีมจัดซื้อโดยอัตโนมัติ — ติดตามสถานะการอนุมัติได้ที่หน้า “รายการรออนุมัติ / อนุมัติงาน”
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
