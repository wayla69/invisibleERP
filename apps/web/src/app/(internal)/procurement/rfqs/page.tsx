'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Plus, X, Award, FileSearch, Inbox, FileText, Quote, Printer, Mail } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { statusVariant } from '@/components/ui';

export default function RfqsPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('iv.rfq_title')}
        description={t('iv.rfq_desc')}
      />
      <Tabs
        tabs={[
          { key: 'list', label: t('iv.rfq_tab_list'), content: <RfqList /> },
          { key: 'create', label: t('iv.rfq_tab_create'), content: <RfqCreate /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── List + detail ─────────────────────────
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

function RfqList() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['rfqs'], queryFn: () => api('/api/procurement/rfqs') });
  const [selected, setSelected] = useState<string | null>(null);
  // Email the RFQ PDF to a supplier (prompts for the recipient address).
  const email = useMutation({
    mutationFn: (v: { no: string; to_email: string }) => api<{ to: string }>(`/api/procurement/rfqs/${encodeURIComponent(v.no)}/send-email`, { method: 'POST', body: JSON.stringify({ to_email: v.to_email }) }),
    onSuccess: (r) => notifySuccess(t('doc.email_sent', { to: r.to })),
    onError: (e: any) => notifyError(e.message),
  });
  const promptEmail = (no: string) => { const to = window.prompt(t('doc.email_prompt')); if (to) email.mutate({ no, to_email: to }); };

  const rfqs: any[] = q.data?.rfqs ?? [];
  const open = rfqs.filter((r) => r.status === 'Open').length;
  const awarded = rfqs.filter((r) => r.status === 'Awarded').length;

  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <StatCard label={t('iv.rfq_stat_total')} value={num(rfqs.length)} icon={ClipboardList} tone="primary" />
            <StatCard label={t('iv.rfq_stat_open')} value={num(open)} icon={FileSearch} tone="info" />
            <StatCard label={t('iv.rfq_stat_awarded')} value={num(awarded)} icon={Award} tone="success" />
          </div>
          <DataTable
            rows={rfqs}
            onRowClick={(r: any) => setSelected(r.rfq_no)}
            columns={[
              { key: 'rfq_no', label: t('iv.rfq_col_no') },
              { key: 'rfq_date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.rfq_date) },
              { key: 'required_date', label: t('iv.rfq_col_required'), render: (r: any) => (r.required_date ? thaiDate(r.required_date) : '—') },
              { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              {
                key: 'doc', label: t('doc.print_col'), sortable: false,
                render: (r: any) => (
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <Button variant="ghost" size="sm" asChild title={t('doc.print_pdf')}>
                      <a href={`${BASE}/api/procurement/rfqs/${encodeURIComponent(r.rfq_no)}/pdf`} target="_blank" rel="noopener noreferrer"><Printer className="size-4" /></a>
                    </Button>
                    <Button variant="ghost" size="sm" disabled={email.isPending} title={t('doc.email')} onClick={() => promptEmail(r.rfq_no)}><Mail className="size-4" /></Button>
                  </div>
                ),
              },
            ]}
            emptyState={{
              icon: Inbox,
              title: t('iv.rfq_empty_title'),
              description: t('iv.rfq_empty_desc'),
            }}
          />
          <RfqDetailDialog rfqNo={selected} onClose={() => setSelected(null)} />
        </div>
      )}
    </StateView>
  );
}

function RfqDetailDialog({ rfqNo, onClose }: { rfqNo: string | null; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['rfq', rfqNo], queryFn: () => api(`/api/procurement/rfqs/${encodeURIComponent(rfqNo!)}`), enabled: !!rfqNo });

  const award = useMutation({
    mutationFn: (quoteNo: string) =>
      api<{ po_no: string }>(`/api/procurement/rfqs/${encodeURIComponent(rfqNo!)}/award`, {
        method: 'POST',
        body: JSON.stringify({ quote_no: quoteNo }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('iv.rfq_awarded_toast', { po: r.po_no }));
      qc.invalidateQueries({ queryKey: ['rfq', rfqNo] });
      qc.invalidateQueries({ queryKey: ['rfqs'] });
    },
    onError: (e) => notifyError((e as Error).message),
  });

  const data = q.data;
  const isOpen = data?.status === 'Open';

  return (
    <Dialog open={!!rfqNo} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {rfqNo} {data && <Badge variant={statusVariant(data.status)}>{data.status}</Badge>}
          </DialogTitle>
        </DialogHeader>
        <StateView q={q}>
          {data && (
            <div className="space-y-5">
              <div>
                <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{t('iv.rfq_items_requested')}</h3>
                <DataTable
                  rows={data.items}
                  columns={[
                    { key: 'item_id', label: t('iv.rfq_col_item') },
                    { key: 'qty', label: t('inv.col_qty'), align: 'right', render: (r: any) => <span className="tabular">{num(r.qty)}</span> },
                  ]}
                  emptyState={{ icon: FileText, title: t('iv.rfq_no_items') }}
                  dense
                />
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{t('iv.rfq_quotes')}</h3>
                <DataTable
                  rows={data.quotes}
                  columns={[
                    { key: 'quote_no', label: t('dash.col_no') },
                    { key: 'vendor_name', label: t('inv.col_supplier'), render: (r: any) => r.vendor_name ?? '—' },
                    { key: 'total_amount', label: t('iv.rfq_col_total'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.total_amount)}</span> },
                    { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                    {
                      key: '_award',
                      label: '',
                      align: 'right',
                      render: (r: any) =>
                        isOpen ? (
                          <Button size="sm" variant="outline" disabled={award.isPending} onClick={() => award.mutate(r.quote_no)}>
                            <Award className="size-4" /> {t('iv.rfq_select')}
                          </Button>
                        ) : null,
                    },
                  ]}
                  emptyState={{ icon: Quote, title: t('iv.rfq_no_quotes') }}
                  dense
                />
              </div>
            </div>
          )}
        </StateView>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Create ─────────────────────────
interface Line { item_id: string; qty: number }

function RfqCreate() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [requiredDate, setRequiredDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<Line[]>([{ item_id: '', qty: 1 }]);
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const create = useMutation({
    mutationFn: () =>
      api<{ rfq_no: string; lines: number }>('/api/procurement/rfqs', {
        method: 'POST',
        body: JSON.stringify({
          required_date: requiredDate || undefined,
          remarks: remarks || undefined,
          items: lines.filter((l) => l.item_id).map((l) => ({ item_id: l.item_id, qty: Number(l.qty) })),
        }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('iv.rfq_created_toast', { no: r.rfq_no, n: num(r.lines) }));
      setRequiredDate(''); setRemarks(''); setLines([{ item_id: '', qty: 1 }]);
      qc.invalidateQueries({ queryKey: ['rfqs'] });
    },
    onError: (e) => notifyError((e as Error).message),
  });

  return (
    <Card className="max-w-2xl gap-4">
      <CardHeader>
        <CardTitle className="text-base">{t('iv.rfq_create_title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="rfq-req">{t('iv.rfq_required_date')}</Label>
            <Input id="rfq-req" type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rfq-remarks">{t('proc.remarks')}</Label>
            <Input id="rfq-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={t('iv.rfq_optional')} />
          </div>
        </div>
        <div className="space-y-2">
          <Label>{t('proc.items')}</Label>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[2fr_1fr_auto] gap-2">
              <Input placeholder={t('iv.col_item_id_ph')} value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })} />
              <Input type="number" min="0" value={l.qty} onChange={(e) => setLine(i, { qty: +e.target.value })} />
              <Button variant="destructive" size="icon" disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                <X className="size-4" />
              </Button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => setLines((ls) => [...ls, { item_id: '', qty: 1 }])}>
            <Plus className="size-4" /> {t('iv.rfq_add_line')}
          </Button>
          <Button disabled={create.isPending || !lines.some((l) => l.item_id)} onClick={() => create.mutate()}>
            {create.isPending ? t('iv.rfq_creating') : t('iv.rfq_tab_create')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
