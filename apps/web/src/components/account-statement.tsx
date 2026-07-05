'use client';

// Shared running-balance statement panel for the AR (customer) and AP (vendor) cards. The parent owns the
// fetch (customer keys by tenant_id, vendor by name) and the date-range state; this renders the summary
// (opening / charges / payments / closing) + the dated line table with a running balance, and CSV export.
import { useMutation } from '@tanstack/react-query';
import { Download, Printer, Mail } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';

import { baht, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { StateView } from '@/components/state-view';
import { StatCard } from '@/components/stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const TYPE_KEY: Record<string, string> = { invoice: 'mx.acstmt_type_invoice', receipt: 'mx.acstmt_type_receipt', bill: 'mx.acstmt_type_bill', payment: 'mx.acstmt_type_payment' };

export interface StatementData {
  party?: string;
  reporting_currency?: string;
  opening_balance: number;
  total_charges: number;
  total_payments: number;
  closing_balance: number;
  lines: Array<{ date: string; type: string; ref: string; doc_currency?: string; charge: number; payment: number; balance: number }>;
}

export function AccountStatement({
  title,
  side,
  query,
  from,
  to,
  setFrom,
  setTo,
  filename,
  empty,
  pdfPath,
  partyParam,
}: {
  title: string;
  /** 'ar' → charges are ใบแจ้งหนี้ (debit), payments are รับชำระ; 'ap' → charges are bills, payments are จ่าย. */
  side: 'ar' | 'ap';
  query: { data?: StatementData; isLoading: boolean; error: unknown };
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
  filename: string;
  /** Shown when no party is selected yet (query disabled). */
  empty?: boolean;
  /** Statement endpoint base (e.g. `/api/finance/ar/statement`) — enables the Print/Email actions. */
  pdfPath?: string;
  /** Party query param for the statement endpoint (e.g. `tenant_id=5` or `vendor=ACME`). */
  partyParam?: string;
}) {
  const { t } = useLang();
  const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
  const qs = `${partyParam ?? ''}&from=${from}&to=${to}`;
  const emailStmt = useMutation({
    mutationFn: (to_email: string) => api<{ to: string }>(`${pdfPath}/send-email?${qs}`, { method: 'POST', body: JSON.stringify({ to_email }) }),
    onSuccess: (r) => notifySuccess(t('doc.email_sent', { to: r.to })),
    onError: (e: any) => notifyError(e.message),
  });
  const promptEmail = () => { const e = window.prompt(t('doc.email_prompt')); if (e) emailStmt.mutate(e); };
  const d = query.data;
  const typeLabel = (ty: string) => (TYPE_KEY[ty] ? t(TYPE_KEY[ty]) : ty);
  const chargeLabel = side === 'ar' ? t('mx.acstmt_charge_ar') : t('mx.acstmt_charge_ap');
  const payLabel = side === 'ar' ? t('mx.acstmt_pay_ar') : t('mx.acstmt_pay_ap');

  const exportCsv = () => {
    if (!d) return;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['date', 'type', 'ref', 'currency', 'charge', 'payment', 'balance'];
    const rows = [
      header.join(','),
      ...d.lines.map((l) => [l.date, typeLabel(l.type), l.ref, l.doc_currency ?? '', l.charge, l.payment, l.balance].map(esc).join(',')),
    ];
    const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (empty) {
    return (
      <Card className="grid min-h-[300px] place-items-center p-8 text-center text-sm text-muted-foreground">
        {t('mx.acstmt_empty', { party: side === 'ar' ? t('mx.acstmt_party_ar') : t('mx.acstmt_party_ap') })}
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">{t('mx.acstmt_subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="st-from">{t('mx.acstmt_from')}</Label>
            <Input id="st-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="st-to">{t('mx.acstmt_to')}</Label>
            <Input id="st-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px]" />
          </div>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!d}>
            <Download className="size-4" /> CSV
          </Button>
          {pdfPath && (
            <>
              <Button variant="outline" size="sm" asChild disabled={!d} title={t('doc.print_pdf')}>
                <a href={`${BASE}${pdfPath}/pdf?${qs}`} target="_blank" rel="noopener noreferrer"><Printer className="size-4" /> PDF</a>
              </Button>
              <Button variant="outline" size="sm" onClick={promptEmail} disabled={!d || emailStmt.isPending} title={t('doc.email')}>
                <Mail className="size-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      <StateView q={query}>
        {d && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('mx.acstmt_opening')} value={baht(d.opening_balance)} />
              <StatCard label={chargeLabel} value={baht(d.total_charges)} tone="primary" />
              <StatCard label={payLabel} value={baht(d.total_payments)} tone="success" />
              <StatCard label={t('mx.acstmt_closing_card')} value={baht(d.closing_balance)} tone={d.closing_balance > 0.005 ? 'danger' : 'default'} />
            </div>
            <Card className="gap-2 p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-muted-foreground">{t('mx.acstmt_movements')}</h3>
                {d.reporting_currency && d.reporting_currency !== 'THB' && <Badge variant="secondary">{d.reporting_currency}</Badge>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="pb-2 font-medium">{t('mx.acstmt_col_date')}</th>
                      <th className="pb-2 font-medium">{t('mx.acstmt_col_type')}</th>
                      <th className="pb-2 font-medium">{t('mx.acstmt_col_doc')}</th>
                      <th className="pb-2 text-right font-medium">{chargeLabel}</th>
                      <th className="pb-2 text-right font-medium">{payLabel}</th>
                      <th className="pb-2 text-right font-medium">{t('mx.acstmt_col_balance')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t text-muted-foreground">
                      <td className="py-1.5" colSpan={5}>{t('mx.acstmt_opening_row')}</td>
                      <td className="py-1.5 text-right tabular">{baht(d.opening_balance)}</td>
                    </tr>
                    {d.lines.map((l, i) => (
                      <tr key={`${l.ref}-${i}`} className="border-t">
                        <td className="py-1.5 tabular">{thaiDate(l.date)}</td>
                        <td className="py-1.5">
                          <Badge variant={l.payment > 0 ? 'success' : 'secondary'}>{typeLabel(l.type)}</Badge>
                        </td>
                        <td className="py-1.5 tabular">{l.ref}</td>
                        <td className="py-1.5 text-right tabular">{l.charge ? baht(l.charge) : '—'}</td>
                        <td className="py-1.5 text-right tabular">{l.payment ? baht(l.payment) : '—'}</td>
                        <td className="py-1.5 text-right tabular font-medium">{baht(l.balance)}</td>
                      </tr>
                    ))}
                    {d.lines.length === 0 && (
                      <tr className="border-t">
                        <td colSpan={6} className="py-4 text-center text-muted-foreground">{t('mx.acstmt_no_lines')}</td>
                      </tr>
                    )}
                    <tr className="border-t-2 font-semibold">
                      <td className="py-1.5" colSpan={3}>{t('mx.acstmt_closing_row')}</td>
                      <td className="py-1.5 text-right tabular">{baht(d.total_charges)}</td>
                      <td className="py-1.5 text-right tabular">{baht(d.total_payments)}</td>
                      <td className="py-1.5 text-right tabular">{baht(d.closing_balance)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}
      </StateView>
    </div>
  );
}
