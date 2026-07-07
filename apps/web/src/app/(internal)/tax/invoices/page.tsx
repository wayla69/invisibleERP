'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Receipt, Coins, Ban, Plus, ExternalLink, FileCode, Mail, SearchX } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

type Invoice = {
  doc_no: string;
  type: 'full' | 'abbreviated' | 'credit_note' | 'debit_note';
  status: string;
  issue_date: string;
  source_type: string;
  source_ref: string;
  buyer: { name: string } | null;
  subtotal: number;
  vat_amount: number;
  grand_total: number;
  original_doc_no?: string | null;
  reason?: string | null;
};

export default function TaxInvoicesPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const typeLabel = (type: string) => (type === 'abbreviated' ? t('tax.type_abbrev') : type === 'credit_note' ? t('tax.type_credit') : type === 'debit_note' ? t('tax.type_debit') : t('tax.type_full'));
  const [filter, setFilter] = useState<'' | 'full' | 'abbreviated' | 'credit_note' | 'debit_note'>('');
  const q = useQuery<{ invoices: Invoice[]; count: number }>({
    queryKey: ['tax-invoices', filter],
    queryFn: () => api(`/api/tax-invoices${filter ? `?type=${filter}` : ''}`),
  });

  const invoices = q.data?.invoices ?? [];
  const totalVat = invoices.reduce((a, r) => a + (r.vat_amount || 0), 0);
  const totalGrand = invoices.reduce((a, r) => a + (r.grand_total || 0), 0);

  // ── ออกใบกำกับภาษีเต็มรูป (ม.86/4) ──
  const [src, setSrc] = useState<'POS' | 'AR'>('POS');
  const [srcRef, setSrcRef] = useState('');
  const [buyerName, setBuyerName] = useState('');
  const [buyerTaxId, setBuyerTaxId] = useState('');
  const [buyerAddr, setBuyerAddr] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [paidBy, setPaidBy] = useState<'' | 'transfer' | 'cash' | 'cheque' | 'other'>('');
  const [paidByOther, setPaidByOther] = useState('');
  const [paidBank, setPaidBank] = useState('');
  const [paidChequeNo, setPaidChequeNo] = useState('');
  const [paidBranch, setPaidBranch] = useState('');

  const issue = useMutation({
    mutationFn: () =>
      api<{ doc_no: string }>('/api/tax-invoices/full', {
        method: 'POST',
        body: JSON.stringify({
          source_type: src,
          source_ref: srcRef,
          buyer: { name: buyerName, tax_id: buyerTaxId || undefined, address: buyerAddr },
          due_date: dueDate || undefined,
          payment: paidBy ? { paid_by: paidBy, paid_by_other: paidBy === 'other' ? paidByOther || undefined : undefined, bank: paidBank || undefined, cheque_no: paidChequeNo || undefined, branch: paidBranch || undefined } : undefined,
        }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('tax.inv_issued', { doc: r.doc_no }));
      setSrcRef(''); setBuyerName(''); setBuyerTaxId(''); setBuyerAddr('');
      setDueDate(''); setPaidBy(''); setPaidByOther(''); setPaidBank(''); setPaidChequeNo(''); setPaidBranch('');
      qc.invalidateQueries({ queryKey: ['tax-invoices'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const canIssue = !!srcRef && !!buyerName && !!buyerAddr && !issue.isPending;

  // ── ส่ง e-Tax Invoice by Email (ETDA, ไม่ต้องมีใบรับรอง CA) ──
  const [emailDoc, setEmailDoc] = useState<string | null>(null);
  const [emailTo, setEmailTo] = useState('');
  const sendEmail = useMutation({
    mutationFn: () =>
      api<{ cc: string }>(`/api/tax-invoices/${emailDoc}/send-etax-email`, {
        method: 'POST',
        body: JSON.stringify({ to_email: emailTo }),
      }),
    onSuccess: (r) => notifySuccess(t('tax.inv_email_sent', { cc: r.cc })),
    onError: (e: any) => notifyError(e.message),
  });
  const openEmail = (docNo: string) => { setEmailDoc(docNo); setEmailTo(''); };

  // ── ออกใบลดหนี้ (ม.86/10) / ใบเพิ่มหนี้ (ม.86/9) ──
  const [noteKind, setNoteKind] = useState<'credit_note' | 'debit_note'>('credit_note');
  const [noteOrig, setNoteOrig] = useState('');
  const [noteReason, setNoteReason] = useState('');
  const [noteDesc, setNoteDesc] = useState('');
  const [noteAmt, setNoteAmt] = useState('');
  const issueNote = useMutation({
    mutationFn: () =>
      api<{ doc_no: string; status: string }>(`/api/tax-invoices/${noteKind === 'credit_note' ? 'credit-note' : 'debit-note'}`, {
        method: 'POST',
        body: JSON.stringify({ original_doc_no: noteOrig, reason: noteReason, lines: [{ description: noteDesc || noteReason, amount: Number(noteAmt) }] }),
      }),
    onSuccess: (r) => { notifySuccess(t('tax.note_issued', { doc: r.doc_no })); setNoteOrig(''); setNoteReason(''); setNoteDesc(''); setNoteAmt(''); qc.invalidateQueries({ queryKey: ['tax-invoices'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const canIssueNote = !!noteOrig && !!noteReason && Number(noteAmt) > 0 && !issueNote.isPending;
  // maker-checker approval of a PendingApproval credit/debit note (a DIFFERENT user)
  const approveNote = useMutation({
    mutationFn: (docNo: string) => api(`/api/tax-invoices/${docNo}/approve-note`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('tax.note_approved')); qc.invalidateQueries({ queryKey: ['tax-invoices'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div>
      <PageHeader
        title={t('tax.inv_title')}
        description={t('tax.inv_subtitle')}
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button variant={filter === '' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('')}>
          {t('tax.all')}
        </Button>
        <Button variant={filter === 'full' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('full')}>
          {t('tax.full')}
        </Button>
        <Button variant={filter === 'abbreviated' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('abbreviated')}>
          {t('tax.abbrev')}
        </Button>
        <Button variant={filter === 'credit_note' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('credit_note')}>
          {t('tax.type_credit')}
        </Button>
        <Button variant={filter === 'debit_note' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('debit_note')}>
          {t('tax.type_debit')}
        </Button>
      </div>

      <Card className="mb-6 max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plus className="size-4" /> {t('tax.inv_issue_full')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="src">{t('tax.inv_source')}</Label>
              <div className="flex gap-2">
                <Button type="button" variant={src === 'POS' ? 'default' : 'outline'} size="sm" onClick={() => setSrc('POS')}>
                  {t('tax.src_pos')}
                </Button>
                <Button type="button" variant={src === 'AR' ? 'default' : 'outline'} size="sm" onClick={() => setSrc('AR')}>
                  {t('tax.src_ar')}
                </Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="src-ref">{t('tax.inv_source_ref', { field: src === 'POS' ? 'sale_no' : 'invoice_no' })}</Label>
              <Input id="src-ref" value={srcRef} onChange={(e) => setSrcRef(e.target.value)} placeholder={src === 'POS' ? t('tax.src_ref_ph_pos') : t('tax.src_ref_ph_ar')} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="buyer-name">{t('tax.inv_buyer_name')}</Label>
            <Input id="buyer-name" value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder={t('tax.inv_buyer_name_ph')} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="buyer-taxid">{t('tax.taxid_13')}</Label>
              <Input id="buyer-taxid" value={buyerTaxId} onChange={(e) => setBuyerTaxId(e.target.value)} placeholder={t('tax.optional')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="buyer-addr">{t('tax.inv_buyer_addr')}</Label>
              <Input id="buyer-addr" value={buyerAddr} onChange={(e) => setBuyerAddr(e.target.value)} placeholder={t('tax.inv_buyer_addr_ph')} />
            </div>
          </div>
          <div className="grid gap-2 sm:max-w-xs">
            <Label htmlFor="due-date">{t('tax.inv_due_date')}</Label>
            <Input id="due-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>{t('tax.inv_paid_by')}</Label>
            <div className="flex flex-wrap gap-2">
              {(['', 'transfer', 'cash', 'cheque', 'other'] as const).map((k) => (
                <Button key={k || 'none'} type="button" variant={paidBy === k ? 'default' : 'outline'} size="sm" onClick={() => setPaidBy(k)}>
                  {k === '' ? t('tax.paid_by_none') : t(`tax.paid_by_${k}`)}
                </Button>
              ))}
            </div>
          </div>
          {paidBy === 'other' && (
            <Input value={paidByOther} onChange={(e) => setPaidByOther(e.target.value)} placeholder={t('tax.paid_by_other_ph')} />
          )}
          {(paidBy === 'transfer' || paidBy === 'cheque') && (
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label htmlFor="paid-bank">{t('tax.paid_bank')}</Label>
                <Input id="paid-bank" value={paidBank} onChange={(e) => setPaidBank(e.target.value)} />
              </div>
              {paidBy === 'cheque' && (
                <div className="grid gap-2">
                  <Label htmlFor="paid-cheque-no">{t('tax.paid_cheque_no')}</Label>
                  <Input id="paid-cheque-no" value={paidChequeNo} onChange={(e) => setPaidChequeNo(e.target.value)} />
                </div>
              )}
              <div className="grid gap-2">
                <Label htmlFor="paid-branch">{t('tax.paid_branch')}</Label>
                <Input id="paid-branch" value={paidBranch} onChange={(e) => setPaidBranch(e.target.value)} />
              </div>
            </div>
          )}
          <Button disabled={!canIssue} onClick={() => issue.mutate()}>
            <Receipt className="size-4" /> {issue.isPending ? t('tax.issuing') : t('tax.inv_issue_btn')}
          </Button>
        </CardContent>
      </Card>

      <Card className="mb-6 max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="size-4" /> {t('tax.note_card')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Button type="button" variant={noteKind === 'credit_note' ? 'default' : 'outline'} size="sm" onClick={() => setNoteKind('credit_note')}>{t('tax.type_credit')}</Button>
            <Button type="button" variant={noteKind === 'debit_note' ? 'default' : 'outline'} size="sm" onClick={() => setNoteKind('debit_note')}>{t('tax.type_debit')}</Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="note-orig">{t('tax.note_original')}</Label>
              <Input id="note-orig" value={noteOrig} onChange={(e) => setNoteOrig(e.target.value)} placeholder={t('tax.note_original_ph')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="note-amt">{t('tax.note_amount')}</Label>
              <Input id="note-amt" type="number" value={noteAmt} onChange={(e) => setNoteAmt(e.target.value)} placeholder="0.00" />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="note-reason">{t('tax.note_reason')}</Label>
            <Input id="note-reason" value={noteReason} onChange={(e) => setNoteReason(e.target.value)} placeholder={t('tax.note_reason_ph')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="note-desc">{t('tax.note_desc')}</Label>
            <Input id="note-desc" value={noteDesc} onChange={(e) => setNoteDesc(e.target.value)} placeholder={t('tax.optional')} />
          </div>
          <Button disabled={!canIssueNote} onClick={() => issueNote.mutate()}>
            <Plus className="size-4" /> {issueNote.isPending ? t('tax.issuing') : t('tax.note_issue_btn')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('tax.note_maker_checker')}</p>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('tax.inv_count')} value={num(q.data.count)} icon={FileText} tone="primary" />
              <StatCard label={t('tax.inv_total_vat')} value={baht(totalVat)} icon={Coins} tone="info" />
              <StatCard label={t('tax.inv_grand_total')} value={baht(totalGrand)} icon={Receipt} />
              <StatCard
                label={t('tax.inv_abbrev_count')}
                value={num(invoices.filter((r) => r.type === 'abbreviated').length)}
                icon={FileText}
                tone="default"
              />
            </div>
            <DataTable
              rows={invoices}
              columns={[
                { key: 'doc_no', label: t('tax.col_doc_no') },
                { key: 'issue_date', label: t('dash.col_date'), render: (r: Invoice) => thaiDate(r.issue_date) },
                { key: 'type', label: t('tax.col_type'), render: (r: Invoice) => typeLabel(r.type) },
                { key: 'buyer', label: t('tax.col_buyer'), render: (r: Invoice) => r.buyer?.name ?? t('tax.cash') },
                { key: 'source_ref', label: t('tax.col_ref'), render: (r: Invoice) => `${r.source_type} · ${r.source_ref}` },
                { key: 'subtotal', label: t('tax.col_value'), align: 'right', render: (r: Invoice) => <span className="tabular">{baht(r.subtotal)}</span> },
                { key: 'vat_amount', label: t('tax.col_vat'), align: 'right', render: (r: Invoice) => <span className="tabular">{baht(r.vat_amount)}</span> },
                { key: 'grand_total', label: t('tax.col_total'), align: 'right', render: (r: Invoice) => <span className="tabular">{baht(r.grand_total)}</span> },
                { key: 'status', label: t('fin.col_status'), render: (r: Invoice) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                {
                  key: 'pdf',
                  label: t('tax.col_pdf'),
                  sortable: false,
                  render: (r: Invoice) => (
                    <Button variant="ghost" size="sm" asChild>
                      <a href={`${BASE}/api/tax-invoices/${r.doc_no}/pdf`} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="size-4" />
                      </a>
                    </Button>
                  ),
                },
                {
                  key: 'xml',
                  label: t('tax.col_etax_xml'),
                  sortable: false,
                  render: (r: Invoice) => (
                    <Button variant="ghost" size="sm" asChild title={t('tax.dl_etax_xml')}>
                      <a href={`${BASE}/api/tax-invoices/${r.doc_no}/etax-xml`} target="_blank" rel="noopener noreferrer">
                        <FileCode className="size-4" />
                      </a>
                    </Button>
                  ),
                },
                {
                  key: 'email',
                  label: t('tax.send_email'),
                  sortable: false,
                  render: (r: Invoice) => (
                    <Button variant="ghost" size="sm" title={t('tax.send_etax_email_title')} onClick={() => openEmail(r.doc_no)}>
                      <Mail className="size-4" />
                    </Button>
                  ),
                },
                {
                  key: 'approve',
                  label: t('tax.note_approve'),
                  sortable: false,
                  render: (r: Invoice) => (
                    r.status === 'PendingApproval'
                      ? <Button variant="outline" size="sm" disabled={approveNote.isPending} onClick={() => approveNote.mutate(r.doc_no)}>{t('tax.note_approve')}</Button>
                      : <span className="text-muted-foreground">—</span>
                  ),
                },
              ]}
              emptyState={
                filter
                  ? {
                      icon: SearchX,
                      title: t('tax.inv_empty_filter_title'),
                      description: t('tax.inv_empty_filter_desc'),
                      action: (
                        <Button variant="outline" size="sm" onClick={() => setFilter('')}>
                          {t('inv.clear_filter')}
                        </Button>
                      ),
                    }
                  : {
                      icon: FileText,
                      title: t('tax.inv_empty_title'),
                      description: t('tax.inv_empty_desc'),
                    }
              }
            />
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Ban className="size-3.5" /> {t('tax.inv_void_note')}
            </p>
          </div>
        )}
      </StateView>

      <Dialog open={!!emailDoc} onOpenChange={(o) => !o && setEmailDoc(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('tax.email_dialog_title', { doc: emailDoc ?? '' })}</DialogTitle>
            <DialogDescription>
              {t('tax.email_dialog_desc')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="email-to">{t('tax.buyer_email')}</Label>
            <Input id="email-to" type="email" placeholder={t('tax.buyer_email_ph')} value={emailTo} onChange={(e) => setEmailTo(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEmailDoc(null)}>{t('tax.close')}</Button>
            <Button onClick={() => sendEmail.mutate()} disabled={!emailTo.includes('@') || sendEmail.isPending}>
              <Mail className="size-4" /> {t('tax.send_email')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
