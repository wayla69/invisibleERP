'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Paperclip, Trash2, Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { statusVariant } from '@/components/ui';
import { PoForm } from '@/components/procurement-forms';
import { BudgetChip, budgetRetryFields } from '@/components/budget-chip';
import { DocSelect } from '@/components/doc-select';
import { notifySuccess, notifyError } from '@/lib/notify';

const PO_LIST_KEY = ['proc-pos'];
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

// Procurement team surface — create/approve Purchase Orders against approved requisitions, then track
// status. Raising a requisition lives at /requisitions (anyone) and goods receipt at /receiving
// (warehouse) — kept on separate pages because each belongs to a different user group (SoD R03/R04).
export default function ProcurementPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const pos = useQuery<any>({ queryKey: PO_LIST_KEY, queryFn: () => api('/api/inventory/purchase-orders?limit=50') });
  // Approve/reject a Pending PO inline (server enforces the workflow engine's maker-checker/SoD). FIN-3
  // (BUD-02): the budget gate's warn/block rejections become the confirm / exec-override interaction.
  const decide = useMutation({
    mutationFn: ({ poNo, approve, extra }: { poNo: string; approve: boolean; extra?: Record<string, unknown> }) =>
      api(`/api/procurement/pos/${encodeURIComponent(poNo)}/approve`, { method: 'PATCH', body: JSON.stringify({ approve, ...(extra ?? {}) }) }),
    onSuccess: (_r, v) => {
      notifySuccess(v.approve ? t('proc.po_approved_ok') : t('proc.po_rejected_ok'));
      qc.invalidateQueries({ queryKey: PO_LIST_KEY });
      qc.invalidateQueries({ queryKey: ['budget-availability'] });
    },
    onError: (e: any, v) => {
      const retry = budgetRetryFields(e, { confirm: t('pb.bctl_confirm_msg'), overridePrompt: t('pb.bctl_override_prompt') });
      if (retry) decide.mutate({ ...v, extra: { ...(v.extra ?? {}), ...retry } });
      else notifyError(e.message);
    },
  });

  return (
    <div>
      <PageHeader title={t('proc.page_title')} description={t('proc.page_subtitle')} />

      <Card className="mb-6 gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('proc.create_po_card')}</CardTitle>
        </CardHeader>
        <CardContent>
          <PoForm onDone={() => qc.invalidateQueries({ queryKey: PO_LIST_KEY })} />
        </CardContent>
      </Card>

      <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('proc.po_list')}</h3>
      <StateView q={pos}>
        {pos.data && (
          <DataTable
            rows={pos.data.purchase_orders}
            emptyState={{
              icon: ClipboardList,
              title: t('inv.po_empty_title'),
              description: t('proc.po_empty_desc'),
            }}
            columns={[
              { key: 'PO_No', label: 'PO' },
              { key: 'PO_Date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.PO_Date) },
              { key: 'Supplier_Name', label: t('inv.col_supplier') },
              { key: 'Total_Amount', label: t('fin.col_amount'), align: 'right', render: (r: any) => baht(r.Total_Amount) },
              { key: 'Status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
              {
                key: 'decide', label: t('proc.col_approve'), sortable: false,
                render: (r: any) => r.Status === 'Pending' ? (
                  <div className="flex items-center justify-end gap-1.5">
                    {/* FIN-3 (BUD-02) — budget availability at the point of approval (hidden while off) */}
                    <BudgetChip docType="PO" docNo={r.PO_No} />
                    <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ poNo: r.PO_No, approve: true })}>{t('fin.approve')}</Button>
                    <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => { const reason = window.prompt(t('proc.po_reject_reason')); if (reason != null) decide.mutate({ poNo: r.PO_No, approve: false, extra: { reason } }); }}>{t('appr.reject')}</Button>
                  </div>
                ) : null,
              },
              {
                key: 'pdf',
                label: t('proc.col_print'),
                sortable: false,
                render: (r: any) => (
                  <Button variant="ghost" size="sm" asChild title={t('proc.print_po')}>
                    <a href={`${BASE}/api/procurement/pos/${encodeURIComponent(r.PO_No)}/pdf`} target="_blank" rel="noopener noreferrer">
                      <Printer className="size-4" />
                    </a>
                  </Button>
                ),
              },
            ]}
          />
        )}
      </StateView>

      <PoAttachmentsCard />
    </div>
  );
}

// Invoice/receipt photos pinned to a PO (0228) — evidence backing the 3-way match. Upload here or from
// the LINE OA chat (`attach <PO no>` then send the photo); both land in the same register.
function PoAttachmentsCard() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [docNo, setDocNo] = useState('');
  const [loadedFor, setLoadedFor] = useState('');
  // Same PO list the table above renders (react-query dedupes the key) — pick the PO, don't type it.
  const posQ = useQuery<any>({ queryKey: PO_LIST_KEY, queryFn: () => api('/api/inventory/purchase-orders?limit=50') });
  const poOptions = (posQ.data?.purchase_orders ?? []).map((p: any) => ({ value: p.PO_No, label: p.Supplier_Name || undefined }));
  const [preview, setPreview] = useState<{ id: number; dataUrl: string } | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const listKey = ['po-attachments', loadedFor];
  const list = useQuery<any>({
    queryKey: listKey,
    queryFn: () => api(`/api/procurement/attachments?doc_type=PO&doc_no=${encodeURIComponent(loadedFor)}`),
    enabled: !!loadedFor,
  });
  const upload = useMutation({
    mutationFn: (p: { data_url: string; filename: string; kind: string }) =>
      api('/api/procurement/attachments', { method: 'POST', body: JSON.stringify({ doc_type: 'PO', doc_no: loadedFor, ...p }) }),
    onSuccess: () => { setError(''); qc.invalidateQueries({ queryKey: listKey }); },
    onError: (e) => setError((e as Error).message),
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`/api/procurement/attachments/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setPreview(null); qc.invalidateQueries({ queryKey: listKey }); },
    onError: (e) => setError((e as Error).message),
  });

  const onFile = (kind: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || !loadedFor) return;
    const reader = new FileReader();
    reader.onload = () => upload.mutate({ data_url: String(reader.result), filename: f.name, kind });
    reader.readAsDataURL(f);
    e.target.value = '';
  };
  const view = async (id: number) => {
    const r = await api<{ id: number; data_url: string }>(`/api/procurement/attachments/${id}`);
    setPreview({ id: r.id, dataUrl: r.data_url });
  };

  return (
    <Card className="mt-6 gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Paperclip className="size-4" /> {t('proc.attach_title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <DocSelect className="w-56" value={docNo} onValueChange={(v) => { setDocNo(v); if (v) { setPreview(null); setLoadedFor(v.trim().toUpperCase()); } }} options={poOptions} placeholder={t('common.doc_select_ph')} emptyText={t('common.doc_none')} allowManual manualPlaceholder={t('proc.attach_po_ph')} />
          <Button size="sm" variant="outline" onClick={() => { setPreview(null); setLoadedFor(docNo.trim().toUpperCase()); }} disabled={!docNo.trim()}>{t('proc.attach_view')}</Button>
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={!loadedFor || upload.isPending}>{t('proc.attach_upload')}</Button>
          <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={onFile('invoice')} />
          <span className="text-xs text-muted-foreground">{t('proc.attach_line_1')} <code className="rounded bg-muted px-1">attach &lt;PO&gt;</code> {t('proc.attach_line_2')}</span>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {loadedFor && (
          <StateView q={list}>
            {list.data && (
              list.data.count === 0 ? <p className="text-sm text-muted-foreground">{t('proc.attach_none', { no: loadedFor })}</p> : (
                <ul className="space-y-1">
                  {list.data.attachments.map((a: any) => (
                    <li key={a.id} className="flex items-center gap-2 text-sm">
                      <Badge variant="outline">{a.kind === 'receipt' ? t('proc.kind_receipt') : a.kind === 'other' ? t('proc.kind_other') : t('proc.kind_invoice')}</Badge>
                      <button className="underline-offset-2 hover:underline" onClick={() => view(a.id)}>{a.filename ?? t('proc.file_n', { id: a.id })}</button>
                      <span className="text-xs text-muted-foreground">{t('proc.by', { by: a.created_by })}{a.source === 'line' ? t('proc.from_line') : ''}</span>
                      <Button size="icon" variant="ghost" className="size-6" onClick={() => del.mutate(a.id)} title={t('proc.delete_title')}><Trash2 className="size-3.5" /></Button>
                    </li>
                  ))}
                </ul>
              )
            )}
          </StateView>
        )}
        {preview && (
          preview.dataUrl.startsWith('data:image/')
            ? <img src={preview.dataUrl} alt="attachment preview" className="max-h-96 rounded border" />
            : <a className="text-sm underline" href={preview.dataUrl} download={`attachment-${preview.id}.pdf`}>{t('proc.download_pdf')}</a>
        )}
      </CardContent>
    </Card>
  );
}
