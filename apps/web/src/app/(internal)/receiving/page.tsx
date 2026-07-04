'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PackageCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { baht, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { statusVariant } from '@/components/ui';
import { GrForm } from '@/components/procurement-forms';

const PO_LIST_KEY = ['receiving-pos'];

// A PO can still take stock until every line is fully received — i.e. once it clears approval
// (Approved) and while it is only part-received (Received). Pending/Draft/Closed/Cancelled cannot.
function isReceivable(status: string): boolean {
  return status === 'Approved' || status === 'Received' || status === 'รับบางส่วน';
}

// One-tap "รับครบ" — receive ALL outstanding qty on an approved PO in a single click (mirrors the LINE
// chat `receive <PO>` command). Uses POST /pos/:poNo/receive-all, which builds the GR lines from each
// PO line's remaining (order − received) and runs the ordinary GR path (EXP-03 gate + auto-close bind).
function ReceiveAllButton({ poNo }: { poNo: string }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: () => api(`/api/procurement/pos/${encodeURIComponent(poNo)}/receive-all`, { method: 'POST' }),
    onSuccess: (r: any) => {
      notifySuccess(r?.po_status === 'Closed' ? t('iv.recv_toast_closed', { po: poNo, gr: r.gr_no }) : t('iv.recv_toast_received', { gr: r?.gr_no ?? '' }));
      qc.invalidateQueries({ queryKey: PO_LIST_KEY });
    },
    onError: (e: any) => notifyError(e?.message ?? t('iv.recv_toast_failed')),
  });
  return (
    <Button size="sm" variant="secondary" disabled={mut.isPending} onClick={() => mut.mutate()}>
      {mut.isPending ? t('iv.recv_receiving') : t('iv.recv_receive_all')}
    </Button>
  );
}

// Warehouse / receiving surface (perm: wh_receive) — confirm goods receipt (GR) against an approved PO.
// Deliberately separate from the buyer's PO page so the person who orders cannot also confirm receipt
// (SoD R04 — preserves the 3-way match). The PO list below lets you look up the PO number, or receive
// the whole order in one tap with "รับครบ".
export default function ReceivingPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const pos = useQuery<any>({ queryKey: PO_LIST_KEY, queryFn: () => api('/api/inventory/purchase-orders?limit=50') });

  return (
    <div>
      <PageHeader title={t('iv.recv_title')} description={t('iv.recv_desc')} />

      <Card className="mb-6 gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('iv.recv_card_title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <GrForm onDone={() => qc.invalidateQueries({ queryKey: PO_LIST_KEY })} />
        </CardContent>
      </Card>

      <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('iv.recv_pending_pos')}</h3>
      <StateView q={pos}>
        {pos.data && (
          <DataTable
            rows={pos.data.purchase_orders}
            emptyState={{
              icon: PackageCheck,
              title: t('iv.recv_empty_title'),
              description: t('iv.recv_empty_desc'),
            }}
            columns={[
              { key: 'PO_No', label: 'PO' },
              { key: 'PO_Date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.PO_Date) },
              { key: 'Supplier_Name', label: t('inv.col_supplier') },
              { key: 'Total_Amount', label: t('fin.col_amount'), align: 'right', render: (r: any) => baht(r.Total_Amount) },
              { key: 'Status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
              { key: 'receive', label: '', align: 'right', render: (r: any) => (isReceivable(String(r.Status)) ? <ReceiveAllButton poNo={r.PO_No} /> : null) },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
