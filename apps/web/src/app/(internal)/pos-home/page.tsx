'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Banknote, ClipboardList, CreditCard, Receipt, ReceiptText, ShoppingCart, Store, Users, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SimpleBarChart } from '@/components/charts';
import { statusVariant } from '@/components/ui';

// Business-day "today" (Asia/Bangkok) as YYYY-MM-DD, matching how sales are dated server-side.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());

interface Summary {
  total_orders: number;
  total_sales: number;
  total_tax: number;
  total_discount: number;
  avg_order_value: number;
  top_items: { Item_Description: string; total_qty: number; total_revenue: number }[];
  by_payment: { Payment_Method: string; order_count: number; amount: number }[];
}
interface Sessions {
  sessions: { Cashier: string; Sale_Date: string; session_total: number; order_count: number }[];
}
interface Orders {
  orders: { Sale_No: string; Sale_Date: string; Total: number; Status: string; Payment_Method: string; Cashier: string }[];
}

const QUICK = [
  { label: 'เปิด POS ขายสินค้า', href: '/pos', icon: ShoppingCart },
  { label: 'ควบคุม POS (พักบิล/อนุมัติ)', href: '/pos-control', icon: ClipboardList },
  { label: 'เครื่องรับบัตร & สรุปยอด', href: '/payments/terminals', icon: CreditCard },
  { label: 'สาขา & ยอดขายรวม', href: '/branches', icon: Store },
];

export default function PosHomePage() {
  const q = useQuery<Summary>({ queryKey: ['pos-summary', today], queryFn: () => api(`/api/pos/summary?start_date=${today}&end_date=${today}`) });
  const sess = useQuery<Sessions>({ queryKey: ['pos-sessions'], queryFn: () => api('/api/pos/sessions') });
  const recent = useQuery<Orders>({ queryKey: ['pos-recent'], queryFn: () => api('/api/pos/orders?limit=8') });

  const d = q.data;
  const payments = (d?.by_payment ?? []).map((p) => ({ name: p.Payment_Method || '—', amount: p.amount }));

  return (
    <div>
      <PageHeader title="ภาพรวมหน้าร้าน (POS)" description={`ยอดขายและกะวันนี้ · ${thaiDate(today)}`} />

      {/* Quick actions */}
      <div className="mb-6 flex flex-wrap gap-2">
        {QUICK.map((a) => (
          <Button key={a.href} asChild variant="outline" size="sm" className="gap-2">
            <Link href={a.href}>
              <a.icon className="size-4" />
              {a.label}
            </Link>
          </Button>
        ))}
      </div>

      <StateView q={q}>
        {d && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="ยอดขายวันนี้" value={baht(d.total_sales)} icon={Banknote} tone="primary" hint={`${num(d.total_orders)} บิล`} />
              <StatCard label="บิลเฉลี่ย/รายการ" value={baht(d.avg_order_value)} icon={Receipt} tone="default" hint="มูลค่าต่อบิล" />
              <StatCard label="ภาษีมูลค่าเพิ่ม (VAT)" value={baht(d.total_tax)} icon={Receipt} tone="default" hint="ภาษีขายวันนี้" />
              <StatCard label="ส่วนลดวันนี้" value={baht(d.total_discount)} icon={Banknote} tone={d.total_discount > 0 ? 'warning' : 'success'} hint="โปรโมชั่น/ส่วนลด" />
            </div>

            <div className="grid gap-4 lg:grid-cols-5">
              <Card className="lg:col-span-3">
                <CardHeader>
                  <CardTitle className="text-base">สินค้าขายดีวันนี้</CardTitle>
                </CardHeader>
                <CardContent>
                  {d.top_items.length ? (
                    <SimpleBarChart
                      data={d.top_items.slice(0, 6).map((t) => ({ name: t.Item_Description, revenue: t.total_revenue }))}
                      xKey="name"
                      yKey="revenue"
                      color="var(--chart-2)"
                      fmt={(v) => baht(v)}
                    />
                  ) : (
                    <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">ยังไม่มียอดขายวันนี้</div>
                  )}
                </CardContent>
              </Card>
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base">ยอดขายตามวิธีชำระเงิน</CardTitle>
                </CardHeader>
                <CardContent>
                  {payments.length ? (
                    <SimpleBarChart data={payments} xKey="name" yKey="amount" color="var(--chart-1)" fmt={(v) => baht(v)} />
                  ) : (
                    <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">ยังไม่มีรายการชำระเงิน</div>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-3 text-sm font-semibold text-muted-foreground">กะที่เปิดอยู่ (Open tills)</h3>
                <DataTable
                  rows={sess.data?.sessions ?? []}
                  emptyState={{
                    icon: Wallet,
                    title: 'ยังไม่มีกะที่เปิดอยู่',
                    description: 'เปิดกะขายที่หน้า POS เพื่อเริ่มรับออเดอร์',
                  }}
                  columns={[
                    { key: 'Cashier', label: 'พนักงาน', render: (r) => (
                      <span className="inline-flex items-center gap-1.5"><Users className="size-3.5 text-muted-foreground" />{r.Cashier}</span>
                    ) },
                    { key: 'order_count', label: 'บิล', align: 'right', render: (r) => num(r.order_count) },
                    { key: 'session_total', label: 'ยอดรวม', align: 'right', render: (r) => baht(r.session_total) },
                  ]}
                />
              </div>
              <div>
                <h3 className="mb-3 text-sm font-semibold text-muted-foreground">บิลล่าสุด</h3>
                <DataTable
                  rows={recent.data?.orders ?? []}
                  emptyState={{
                    icon: ReceiptText,
                    title: 'ยังไม่มีบิลวันนี้',
                    description: 'บิลจะแสดงที่นี่เมื่อมีการขายผ่าน POS',
                  }}
                  columns={[
                    { key: 'Sale_No', label: 'เลขที่' },
                    { key: 'Total', label: 'ยอด', align: 'right', render: (r) => baht(r.Total) },
                    { key: 'Payment_Method', label: 'ชำระ' },
                    { key: 'Status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
                  ]}
                />
              </div>
            </div>
          </div>
        )}
      </StateView>
    </div>
  );
}
