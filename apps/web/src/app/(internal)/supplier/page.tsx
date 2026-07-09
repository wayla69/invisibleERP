'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Check, FileText, PackageCheck, ClipboardList } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';
import { DocSelect } from '@/components/doc-select';

// ── API contract (apps/api/src/modules/supplier) — vendor self-service ─────────
interface Po { po_no: string; po_date: string | null; status: string; total_amount: number; expected_date: string | null; acknowledged_at: string | null }
interface PoItem { item_id: string; description: string | null; order_qty: number; unit_price: number; amount: number; received_qty: number }
interface PoDetail { po_no: string; status: string; total_amount: number; acknowledged_at: string | null; items: PoItem[] }
interface Invoice { txn_no: string; invoice_no: string; ref_doc: string | null; amount: number; vat_amount: number; status: string; created_at: string | null }

export default function SupplierPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('iv.sup_title')}
        description={t('iv.sup_desc')}
      />
      <Tabs
        tabs={[
          { key: 'po', label: t('iv.sup_tab_po'), content: <PoTab /> },
          { key: 'inv', label: t('iv.sup_tab_inv'), content: <InvoiceTab /> },
        ]}
      />
    </div>
  );
}

function PoTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ vendor: string; purchase_orders: Po[]; count: number }>({
    queryKey: ['sup-pos'],
    queryFn: () => api('/api/supplier/purchase-orders'),
  });
  const [selected, setSelected] = useState<string | null>(null);

  const rows = q.data?.purchase_orders ?? [];
  const unack = rows.filter((r) => !r.acknowledged_at).length;
  const totalOpen = rows.reduce((s, r) => s + (r.total_amount || 0), 0);

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t('iv.sup_stat_total_po')} value={num(rows.length)} icon={ClipboardList} tone="primary" hint={q.data.vendor ? t('iv.sup_vendor_hint', { vendor: q.data.vendor }) : undefined} />
            <StatCard label={t('iv.sup_stat_unack')} value={num(unack)} tone="warning" />
            <StatCard label={t('iv.sup_stat_total_value')} value={baht(totalOpen)} tone="info" />
          </div>
        )}
      </StateView>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            rowKey={(r) => r.po_no}
            onRowClick={(r) => setSelected((id) => (id === r.po_no ? null : r.po_no))}
            emptyState={{ icon: ClipboardList, title: t('iv.sup_empty_po_title'), description: t('iv.sup_empty_po_desc') }}
            columns={[
              { key: 'po_no', label: t('iv.sup_col_po_no'), render: (r) => <span className="font-medium">{r.po_no}</span> },
              { key: 'po_date', label: t('dash.col_date'), render: (r) => thaiDate(r.po_date) },
              { key: 'expected_date', label: t('iv.sup_col_expected'), render: (r) => thaiDate(r.expected_date) },
              { key: 'total_amount', label: t('iv.sup_col_value'), align: 'right', render: (r) => <span className="tabular">{baht(r.total_amount)}</span> },
              { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              { key: 'acknowledged_at', label: t('iv.sup_col_ack'), render: (r) => (r.acknowledged_at ? <Badge variant="success">{t('iv.sup_ack_yes')}</Badge> : <Badge variant="secondary">{t('iv.sup_ack_no')}</Badge>) },
            ]}
          />
        )}
      </StateView>

      {selected && <PoDetailCard poNo={selected} onAck={() => qc.invalidateQueries({ queryKey: ['sup-pos'] })} />}
    </div>
  );
}

function PoDetailCard({ poNo, onAck }: { poNo: string; onAck: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<PoDetail>({ queryKey: ['sup-po', poNo], queryFn: () => api(`/api/supplier/purchase-orders/${poNo}`) });

  const ack = useMutation({
    mutationFn: () => api(`/api/supplier/purchase-orders/${poNo}/acknowledge`, { method: 'POST' }),
    onSuccess: (r: any) => {
      notifySuccess(r.already ? t('iv.sup_ack_already') : t('iv.sup_ack_done', { poNo }));
      qc.invalidateQueries({ queryKey: ['sup-po', poNo] });
      onAck();
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="gap-4 border-primary/30">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2"><PackageCheck className="size-4" /> {t('iv.sup_detail', { poNo })}</span>
          {q.data && !q.data.acknowledged_at && (
            <Button size="sm" disabled={ack.isPending} onClick={() => ack.mutate()}>
              <Check className="size-4" /> {ack.isPending ? t('iv.sup_acking') : t('iv.sup_ack_btn')}
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={q.data.items}
              rowKey={(_r, i) => i}
              emptyText={t('iv.sup_no_items')}
              columns={[
                { key: 'item_id', label: t('iv.sup_col_item_code'), render: (r) => <span className="font-medium">{r.item_id}</span> },
                { key: 'description', label: t('iv.sup_col_desc'), render: (r) => r.description ?? '—' },
                { key: 'order_qty', label: t('iv.sup_col_ordered'), align: 'right', render: (r) => <span className="tabular">{num(r.order_qty)}</span> },
                { key: 'received_qty', label: t('iv.sup_col_received'), align: 'right', render: (r) => <span className="tabular">{num(r.received_qty)}</span> },
                { key: 'unit_price', label: t('iv.sup_col_unit_price'), align: 'right', render: (r) => <span className="tabular">{baht(r.unit_price)}</span> },
                { key: 'amount', label: t('iv.sup_col_amount'), align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
              ]}
            />
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

function InvoiceTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ invoices: Invoice[]; count: number }>({ queryKey: ['sup-inv'], queryFn: () => api('/api/supplier/invoices') });
  // The vendor's own POs (same list as the PO tab) — the PO ref is picked, not typed.
  const posQ = useQuery<{ purchase_orders: Po[] }>({ queryKey: ['sup-pos'], queryFn: () => api('/api/supplier/purchase-orders') });
  const poOptions = (posQ.data?.purchase_orders ?? []).map((p) => ({ value: p.po_no, label: p.status || undefined }));

  const [poNo, setPoNo] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [amount, setAmount] = useState('');
  const [vatAmount, setVatAmount] = useState('');

  const submit = useMutation({
    mutationFn: () =>
      api('/api/supplier/invoices', {
        method: 'POST',
        body: JSON.stringify({
          po_no: poNo || undefined,
          invoice_no: invoiceNo,
          invoice_date: invoiceDate || undefined,
          amount: Number(amount) || 0,
          vat_amount: vatAmount ? Number(vatAmount) : undefined,
        }),
      }),
    onSuccess: (r: any) => {
      notifySuccess(t('iv.sup_inv_sent', { invoiceNo: r.invoice_no }), t('iv.sup_inv_sent_desc', { txnNo: r.txn_no, status: r.status }));
      setInvoiceNo(''); setAmount(''); setVatAmount(''); setPoNo('');
      qc.invalidateQueries({ queryKey: ['sup-inv'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const rows = q.data?.invoices ?? [];
  const unpaid = rows.filter((r) => r.status === 'Unpaid').reduce((s, r) => s + (r.amount || 0), 0);

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t('iv.sup_stat_total_inv')} value={num(rows.length)} icon={FileText} tone="primary" />
            <StatCard label={t('iv.sup_stat_unpaid')} value={baht(unpaid)} tone="warning" />
            <StatCard label={t('iv.sup_stat_paid')} value={num(rows.filter((r) => r.status !== 'Unpaid').length)} tone="success" />
          </div>
        )}
      </StateView>

      <Card className="max-w-4xl gap-4">
        <CardHeader><CardTitle className="text-base">{t('iv.sup_submit_inv')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="iv-po">{t('iv.sup_po_ref')}</Label>
              <DocSelect id="iv-po" value={poNo} onValueChange={setPoNo} options={poOptions} placeholder={t('common.doc_select_ph')} emptyText={t('common.doc_none')} allowManual manualPlaceholder={t('iv.sup_po_ph')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="iv-no">{t('iv.sup_inv_no')}</Label>
              <Input id="iv-no" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="INV-xxxx" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="iv-date">{t('iv.sup_inv_date')}</Label>
              <Input id="iv-date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="iv-amt">{t('iv.sup_amt_label')}</Label>
              <Input id="iv-amt" type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="iv-vat">VAT (฿)</Label>
              <Input id="iv-vat" type="number" min="0" value={vatAmount} onChange={(e) => setVatAmount(e.target.value)} placeholder="0" />
            </div>
          </div>
          <Button disabled={submit.isPending || !invoiceNo.trim() || !amount} onClick={() => submit.mutate()}>
            <Plus className="size-4" /> {submit.isPending ? t('iv.sup_submitting') : t('iv.sup_submit_inv')}
          </Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            rowKey={(r) => r.txn_no}
            emptyState={{ icon: FileText, title: t('iv.sup_empty_inv_title'), description: t('iv.sup_empty_inv_desc') }}
            columns={[
              { key: 'invoice_no', label: t('iv.sup_inv_no'), render: (r) => <span className="font-medium">{r.invoice_no}</span> },
              { key: 'ref_doc', label: t('iv.sup_col_ref'), render: (r) => r.ref_doc ?? '—' },
              { key: 'created_at', label: t('iv.sup_col_sent_at'), render: (r) => thaiDate(r.created_at) },
              { key: 'amount', label: t('iv.sup_col_value'), align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
              { key: 'vat_amount', label: 'VAT', align: 'right', render: (r) => <span className="tabular">{baht(r.vat_amount)}</span> },
              { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
