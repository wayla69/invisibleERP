'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Banknote, Receipt, ShoppingCart, TrendingUp, TriangleAlert, Bell } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { Card, CardContent } from '@/components/ui/card';

export default function PortalDashboard() {
  const q = useQuery<any>({ queryKey: ['portal-dashboard'], queryFn: () => api('/api/portal/dashboard') });
  const d = q.data;
  return (
    <div>
      <PageHeader title={`สวัสดี 👋 ${d?.tenant ?? ''}`} description="ภาพรวมธุรกิจของคุณ" />
      <StateView q={q}>
        {d && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatCard label="ยอดขายวันนี้" value={baht(d.today_sales)} icon={Banknote} tone="primary" />
              <StatCard label="บิลวันนี้" value={num(d.today_orders)} icon={Receipt} />
              <StatCard label="ยอดขายเดือนนี้" value={baht(d.mtd_sales)} icon={TrendingUp} />
              <StatCard label="คำสั่งซื้อค้าง" value={num(d.open_orders)} icon={ShoppingCart} />
              <StatCard label="สินค้าใกล้หมด" value={num(d.low_stock_items)} icon={TriangleAlert} tone={d.low_stock_items > 0 ? 'danger' : 'success'} />
            </div>
            {d.auto_reorder && (
              <Card className="gap-0 border-warning/40 bg-warning/10 p-5">
                <CardContent className="flex items-start gap-3 px-0 text-sm">
                  <Bell className="mt-0.5 size-5 shrink-0 text-warning-foreground dark:text-warning" />
                  <p className="text-foreground">
                    ระบบสร้างใบสั่งซื้ออัตโนมัติ <strong>{d.auto_reorder.pending_no}</strong> ({d.auto_reorder.lines} รายการที่สต๊อกต่ำ) —
                    ไปที่{' '}
                    <Link href="/portal/inventory" className="font-medium text-primary hover:underline">
                      สต๊อก &amp; สั่งซื้อ
                    </Link>{' '}
                    เพื่อตรวจสอบและส่งอนุมัติ
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </StateView>
    </div>
  );
}
