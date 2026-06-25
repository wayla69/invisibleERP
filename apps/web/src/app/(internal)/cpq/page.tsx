'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Check, X, FileText, SlidersHorizontal } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { statusVariant } from '@/components/ui';

// GET /api/cpq/quotes → { quotes: [...], count }
interface Quote { id: number; quote_no: string; customer_name: string; status: string; issued_date: string | null; expires_date: string | null; subtotal: number; discount_total: number; total: number; created_by: string | null }
// GET /api/cpq/configs → { configs: [...], count }
interface Config { id: number; code: string; name: string; base_price: number; currency: string | null; description: string | null }

export default function CpqPage() {
  return (
    <div>
      <PageHeader title="ใบเสนอราคา (Quotes / CPQ)" description="กำหนดราคาสินค้าตามตัวเลือก ออกใบเสนอราคา และติดตามสถานะ" />
      <Tabs
        tabs={[
          { key: 'quotes', label: 'ใบเสนอราคา', content: <Quotes /> },
          { key: 'configs', label: 'รายการตั้งค่าราคา', content: <Configs /> },
        ]}
      />
    </div>
  );
}

function Quotes() {
  const qc = useQueryClient();
  const q = useQuery<{ quotes: Quote[]; count: number }>({ queryKey: ['cpq-quotes'], queryFn: () => api('/api/cpq/quotes') });

  const action = useMutation({
    mutationFn: (v: { id: number; verb: 'send' | 'accept' | 'reject' }) =>
      api(`/api/cpq/quotes/${v.id}/${v.verb}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cpq-quotes'] }),
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-4">
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.quotes}
            emptyState={{ icon: FileText, title: 'ยังไม่มีใบเสนอราคา', description: 'สร้างใบเสนอราคาจากรายการตั้งค่าราคา แล้วส่งให้ลูกค้าเพื่อเริ่มติดตามสถานะ' }}
            columns={[
              { key: 'quote_no', label: 'เลขที่' },
              { key: 'customer_name', label: 'ลูกค้า' },
              { key: 'issued_date', label: 'วันที่ออก', render: (r: Quote) => thaiDate(r.issued_date) },
              { key: 'expires_date', label: 'หมดอายุ', render: (r: Quote) => thaiDate(r.expires_date) },
              { key: 'subtotal', label: 'ยอดรวมย่อย', align: 'right', render: (r: Quote) => <span className="tabular">{baht(r.subtotal)}</span> },
              { key: 'total', label: 'ยอดรวม', align: 'right', render: (r: Quote) => <span className="tabular">{baht(r.total)}</span> },
              { key: 'status', label: 'สถานะ', render: (r: Quote) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              {
                key: 'actions',
                label: 'การดำเนินการ',
                sortable: false,
                render: (r: Quote) => (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {r.status === 'Draft' && (
                      <Button variant="outline" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: r.id, verb: 'send' })}>
                        <Send className="size-3.5" /> ส่ง
                      </Button>
                    )}
                    {r.status === 'Sent' && (
                      <Button variant="default" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: r.id, verb: 'accept' })}>
                        <Check className="size-3.5" /> ยอมรับ
                      </Button>
                    )}
                    {(r.status === 'Sent' || r.status === 'Draft') && (
                      <Button variant="destructive" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: r.id, verb: 'reject' })}>
                        <X className="size-3.5" /> ปฏิเสธ
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

function Configs() {
  const q = useQuery<{ configs: Config[]; count: number }>({ queryKey: ['cpq-configs'], queryFn: () => api('/api/cpq/configs') });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable
          rows={q.data.configs}
          emptyState={{ icon: SlidersHorizontal, title: 'ยังไม่มีรายการตั้งค่าราคา', description: 'เพิ่มรายการตั้งค่าราคาเพื่อกำหนดราคาฐานและตัวเลือกสำหรับใบเสนอราคา' }}
          columns={[
            { key: 'code', label: 'รหัส' },
            { key: 'name', label: 'ชื่อ' },
            { key: 'description', label: 'รายละเอียด', render: (r: Config) => r.description ?? '—' },
            { key: 'base_price', label: 'ราคาฐาน', align: 'right', render: (r: Config) => <span className="tabular">{baht(r.base_price)}</span> },
          ]}
        />
      )}
    </StateView>
  );
}
