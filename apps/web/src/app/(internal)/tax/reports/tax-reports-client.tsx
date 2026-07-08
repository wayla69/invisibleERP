'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { TrendingUp, TrendingDown, Scale, Calendar, Download, ReceiptText, FileText } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { baht, num, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

// ── shared month/year control ──
function PeriodPicker({
  month, year, setMonth, setYear, exportHref,
}: {
  month: number; year: number;
  setMonth: (m: number) => void; setYear: (y: number) => void;
  exportHref?: string;
}) {
  const { t } = useLang();
  return (
    <div className="mb-5 flex flex-wrap items-end gap-3">
      <div className="grid gap-1.5">
        <Label>{t('tax.month')}</Label>
        <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
          <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {MONTHS.map((m) => (
              <SelectItem key={m} value={String(m)}>{t('tax.month_' + m)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label>{t('tax.year')}</Label>
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[2024, 2025, 2026, 2027].map((y) => (
              <SelectItem key={y} value={String(y)}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {exportHref && (
        <Button variant="outline" asChild>
          <a href={`${BASE}${exportHref}`} target="_blank" rel="noopener noreferrer">
            <Download className="size-4" /> {t('tax.download_pdf')}
          </a>
        </Button>
      )}
    </div>
  );
}

// ── ภาษีขาย (Output VAT) ──
function OutputVat({ initialData }: { initialData?: unknown }) {
  const { t } = useLang();
  const [month, setMonth] = useState(6);
  const [year, setYear] = useState(2026);
  // Server-prefetched for the default 6/2026 period only (the initial queryKey); changing the period
  // fetches fresh exactly as before.
  const q = useQuery<any>({
    queryKey: ['output-vat', month, year],
    queryFn: () => api(`/api/tax-reports/output-vat?month=${month}&year=${year}`),
    initialData: month === 6 && year === 2026 ? (initialData ?? undefined) : undefined,
  });
  return (
    <div>
      <PeriodPicker month={month} year={year} setMonth={setMonth} setYear={setYear}
        exportHref={`/api/tax-reports/output-vat/export?month=${month}&year=${year}`} />
      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('tax.count_items')} value={num(q.data.totals.count)} icon={Calendar} tone="primary" />
              <StatCard label={t('tax.sales_value')} value={baht(q.data.totals.value)} icon={TrendingUp} tone="info" />
              <StatCard label={t('tax.output_vat')} value={baht(q.data.totals.vat)} icon={TrendingUp} tone="success" />
              <StatCard label={t('tax.inv_abbrev_count')} value={num(q.data.abbreviated_count)} icon={Calendar} />
            </div>
            <DataTable
              rows={q.data.rows}
              columns={[
                { key: 'date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.date) },
                { key: 'doc_no', label: t('tax.col_doc_no') },
                { key: 'type', label: t('tax.col_type'), render: (r: any) => (r.type === 'abbreviated' ? t('tax.abbrev') : t('tax.full')) },
                { key: 'buyer_name', label: t('tax.col_buyer') },
                { key: 'buyer_tax_id', label: t('tax.col_tax_id') },
                { key: 'value', label: t('tax.col_value'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.value)}</span> },
                { key: 'vat', label: 'VAT', align: 'right', render: (r: any) => <span className="tabular">{baht(r.vat)}</span> },
              ]}
              emptyState={{
                icon: ReceiptText,
                title: t('tax.output_empty_title'),
                description: t('tax.output_empty_desc'),
              }}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ── ภ.พ.36 — reverse-charge / self-assessed VAT on imported services (ม.83/6) ──
function Pp36() {
  const { t } = useLang();
  const [month, setMonth] = useState(6);
  const [year, setYear] = useState(2026);
  const q = useQuery<any>({
    queryKey: ['pp36', month, year],
    queryFn: () => api(`/api/tax-reports/pp36?month=${month}&year=${year}`),
  });
  return (
    <div>
      <PeriodPicker month={month} year={year} setMonth={setMonth} setYear={setYear} />
      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label={t('tax.count_items')} value={num(q.data.totals.count)} icon={Calendar} tone="primary" />
              <StatCard label={t('tax.input_base')} value={baht(q.data.totals.base)} icon={TrendingDown} tone="info" />
              <StatCard label={t('tax.pp36_vat')} value={baht(q.data.totals.vat)} icon={TrendingDown} tone="warning" />
            </div>
            <DataTable
              rows={q.data.rows}
              columns={[
                { key: 'date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.date) },
                { key: 'doc_no', label: t('dash.col_no') },
                { key: 'invoice_no', label: t('tax.col_inv_no') },
                { key: 'vendor_name', label: t('inv.col_supplier') },
                { key: 'base', label: t('tax.col_base'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.base)}</span> },
                { key: 'vat', label: 'VAT', align: 'right', render: (r: any) => <span className="tabular">{baht(r.vat)}</span> },
              ]}
              emptyState={{ icon: FileText, title: t('tax.pp36_empty_title'), description: t('tax.pp36_empty_desc') }}
            />
            <Card className="flex-row flex-wrap items-center gap-2 p-5 text-sm">
              <Scale className="size-4 text-muted-foreground" />
              {t('tax.recon_gl', { account: q.data.reconciliation.gl_account })}
              <span className="tabular">{baht(q.data.reconciliation.gl_net_movement)}</span>{' '}
              <Badge variant={q.data.reconciliation.tied ? 'success' : 'destructive'}>
                {q.data.reconciliation.tied ? t('tax.tied') : t('tax.untied')}
              </Badge>
              <span className="ml-auto text-muted-foreground">{t('tax.deadline_label')} {q.data.deadline}</span>
            </Card>
          </div>
        )}
      </StateView>
    </div>
  );
}

// ── ภาษีซื้อ (Input VAT) ──
function InputVat() {
  const { t } = useLang();
  const [month, setMonth] = useState(6);
  const [year, setYear] = useState(2026);
  const q = useQuery<any>({
    queryKey: ['input-vat', month, year],
    queryFn: () => api(`/api/tax-reports/input-vat?month=${month}&year=${year}`),
  });
  return (
    <div>
      <PeriodPicker month={month} year={year} setMonth={setMonth} setYear={setYear}
        exportHref={`/api/tax-reports/input-vat/export?month=${month}&year=${year}`} />
      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label={t('tax.count_items')} value={num(q.data.totals.count)} icon={Calendar} tone="primary" />
              <StatCard label={t('tax.input_base')} value={baht(q.data.totals.base)} icon={TrendingDown} tone="info" />
              <StatCard label={t('tax.input_vat')} value={baht(q.data.totals.vat)} icon={TrendingDown} tone="warning" />
            </div>
            <DataTable
              rows={q.data.rows}
              columns={[
                { key: 'date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.date) },
                { key: 'doc_no', label: t('dash.col_no') },
                { key: 'invoice_no', label: t('tax.col_inv_no') },
                { key: 'vendor_name', label: t('inv.col_supplier') },
                { key: 'base', label: t('tax.col_base'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.base)}</span> },
                { key: 'vat', label: 'VAT', align: 'right', render: (r: any) => <span className="tabular">{baht(r.vat)}</span> },
              ]}
              emptyState={{
                icon: FileText,
                title: t('tax.input_empty_title'),
                description: t('tax.input_empty_desc'),
              }}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ── ภ.พ.30 ──
function Pp30() {
  const { t } = useLang();
  const [month, setMonth] = useState(6);
  const [year, setYear] = useState(2026);
  const q = useQuery<any>({
    queryKey: ['pp30', month, year],
    queryFn: () => api(`/api/tax-reports/pp30?month=${month}&year=${year}`),
  });
  return (
    <div>
      <PeriodPicker month={month} year={year} setMonth={setMonth} setYear={setYear}
        exportHref={`/api/tax-reports/pp30/export?month=${month}&year=${year}`} />
      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('tax.pp30_sales_taxable')} value={baht(q.data.form.sales_taxable)} icon={TrendingUp} tone="info" />
              <StatCard label={t('tax.output_vat_short')} value={baht(q.data.form.output_vat)} icon={TrendingUp} tone="success" />
              <StatCard label={t('tax.input_vat_short')} value={baht(q.data.form.input_vat)} icon={TrendingDown} tone="warning" />
              <StatCard
                label={q.data.form.vat_payable > 0 ? t('tax.vat_payable') : t('tax.vat_carry')}
                value={baht(q.data.form.vat_payable > 0 ? q.data.form.vat_payable : q.data.form.vat_credit_carry_forward)}
                icon={Scale}
                tone={q.data.form.vat_payable > 0 ? 'danger' : 'success'}
              />
            </div>

            <Card className="gap-3 p-5">
              <h3 className="text-sm font-semibold text-muted-foreground">{t('tax.pp30_summary', { period: q.data.period })}</h3>
              <table className="w-full text-sm">
                <tbody>
                  <tr><td className="py-1">{t('tax.pp30_sales_taxable')}</td><td className="py-1 text-right tabular">{baht(q.data.form.sales_taxable)}</td></tr>
                  <tr><td className="py-1">{t('tax.output_vat')}</td><td className="py-1 text-right tabular">{baht(q.data.form.output_vat)}</td></tr>
                  <tr><td className="py-1">{t('tax.purchases')}</td><td className="py-1 text-right tabular">{baht(q.data.form.purchases)}</td></tr>
                  <tr><td className="py-1">{t('tax.input_vat')}</td><td className="py-1 text-right tabular">{baht(q.data.form.input_vat)}</td></tr>
                  <tr className="border-t font-semibold">
                    <td className="py-1">{q.data.form.vat_payable > 0 ? t('tax.vat_payable') : t('tax.vat_carry_next')}</td>
                    <td className="py-1 text-right tabular">{baht(q.data.form.vat_payable > 0 ? q.data.form.vat_payable : q.data.form.vat_credit_carry_forward)}</td>
                  </tr>
                </tbody>
              </table>
            </Card>

            <Card className="flex-row flex-wrap items-center gap-2 p-5 text-sm">
              <Scale className="size-4 text-muted-foreground" />
              {t('tax.recon_gl', { account: q.data.reconciliation.gl_account })}
              <span className="tabular">{baht(q.data.reconciliation.gl_net_movement)}</span>{t('tax.recon_report')}
              <span className="tabular">{baht(q.data.reconciliation.report_net_vat)}</span>{' '}
              <Badge variant={q.data.reconciliation.tied ? 'success' : 'destructive'}>
                {q.data.reconciliation.tied ? t('tax.tied') : t('tax.untied')}
              </Badge>
            </Card>

            <Card className="gap-1 p-5 text-sm">
              <div className="flex items-center gap-2">
                <Calendar className="size-4 text-muted-foreground" />
                {t('tax.deadline_label')} <strong>{thaiDate(q.data.deadline)}</strong>
              </div>
              <p className="text-xs text-muted-foreground">{q.data.deadline_note}</p>
            </Card>
          </div>
        )}
      </StateView>
    </div>
  );
}

// ── การยื่นแบบ + ปฏิทินกำหนดยื่น (filing register + remittance calendar, TAX-05) ──
const FILING_STATUSES = ['NOT_FILED', 'DRAFT', 'SUBMITTED', 'ACCEPTED'];
const filingVariant = (s: string) => (s === 'ACCEPTED' ? 'success' : s === 'SUBMITTED' ? 'info' : s === 'DRAFT' ? 'warning' : 'muted');

function Filings() {
  const { t } = useLang();
  const [year, setYear] = useState(2026);
  const qc = useQueryClient();
  const cal = useQuery<any>({ queryKey: ['remittance-calendar', year], queryFn: () => api(`/api/tax-reports/remittance-calendar?year=${year}`) });
  const filingStatusLabel = (s: string) => (FILING_STATUSES.includes(s) ? t('tax.filing_status_' + s) : s);

  const file = useMutation({
    mutationFn: (v: { filing_type: string; month: number }) => api('/api/tax-reports/filings', { method: 'POST', body: JSON.stringify({ ...v, year }) }),
    onSuccess: (r: any) => { notifySuccess(r?.already_filed ? t('tax.already_filed', { status: r.status }) : t('tax.draft_created', { type: r.filing_type })); qc.invalidateQueries({ queryKey: ['remittance-calendar'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const submit = useMutation({
    mutationFn: (id: number) => api(`/api/tax-reports/filings/${id}/submit`, { method: 'POST', body: JSON.stringify({ submission_ref: window.prompt(t('tax.submit_ref_prompt')) ?? '' }) }),
    onSuccess: () => { notifySuccess(t('tax.filed_ok')); qc.invalidateQueries({ queryKey: ['remittance-calendar'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div>
      <div className="mb-4 grid w-[110px] gap-1.5">
        <Label>{t('tax.year')}</Label>
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{[2024, 2025, 2026, 2027].map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <StateView q={cal}>
        {cal.data && (
          <DataTable
            rows={(cal.data.calendar ?? []).filter((c: any) => c.filing_type !== 'PND3' || c.status !== 'NOT_FILED')}
            columns={[
              { key: 'filing_type', label: t('tax.col_form') },
              { key: 'period_month', label: t('tax.col_period'), render: (r: any) => `${t('tax.month_' + r.period_month)} ${r.period_year}` },
              { key: 'deadline', label: t('tax.col_deadline'), render: (r: any) => r.deadline },
              { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={filingVariant(r.status)}>{filingStatusLabel(r.status)}</Badge> },
              { key: 'submission_ref', label: t('tax.col_ref_no'), render: (r: any) => r.submission_ref ?? '—' },
              {
                key: 'act', label: '', align: 'right', render: (r: any) =>
                  r.status === 'NOT_FILED' ? <Button size="sm" variant="outline" disabled={file.isPending} onClick={() => file.mutate({ filing_type: r.filing_type, month: r.period_month })}>{t('tax.create_draft')}</Button>
                  : r.status === 'DRAFT' ? <Button size="sm" variant="outline" disabled={submit.isPending} onClick={() => submit.mutate(r.filing_id)}>{t('tax.file_btn')}</Button>
                  : null,
              },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

export default function TaxReportsWorkspace({ initialOutputVat }: { initialOutputVat?: unknown }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('tax.reports_title')}
        description={t('tax.reports_subtitle')}
      />
      <Tabs
        tabs={[
          { key: 'output', label: t('tax.output_vat'), content: <OutputVat initialData={initialOutputVat} /> },
          { key: 'input', label: t('tax.input_vat'), content: <InputVat /> },
          { key: 'pp30', label: t('tax.pp30'), content: <Pp30 /> },
          { key: 'pp36', label: t('tax.pp36'), content: <Pp36 /> },
          { key: 'filings', label: t('tax.tab_filings'), content: <Filings /> },
        ]}
      />
    </div>
  );
}
