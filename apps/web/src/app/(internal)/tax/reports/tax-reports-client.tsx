'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { TrendingUp, TrendingDown, Scale, Calendar, Download, ReceiptText, FileText } from 'lucide-react';
import { api } from '@/lib/api';
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

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

// ── shared month/year control ──
function PeriodPicker({
  month, year, setMonth, setYear, exportHref,
}: {
  month: number; year: number;
  setMonth: (m: number) => void; setYear: (y: number) => void;
  exportHref: string;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end gap-3">
      <div className="grid gap-1.5">
        <Label>เดือน</Label>
        <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
          <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {THAI_MONTHS.map((m, i) => (
              <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label>ปี (ค.ศ.)</Label>
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[2024, 2025, 2026, 2027].map((y) => (
              <SelectItem key={y} value={String(y)}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button variant="outline" asChild>
        <a href={`${BASE}${exportHref}`} target="_blank" rel="noopener noreferrer">
          <Download className="size-4" /> ดาวน์โหลด PDF
        </a>
      </Button>
    </div>
  );
}

// ── ภาษีขาย (Output VAT) ──
function OutputVat({ initialData }: { initialData?: unknown }) {
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
              <StatCard label="จำนวนรายการ" value={num(q.data.totals.count)} icon={Calendar} tone="primary" />
              <StatCard label="มูลค่าขาย" value={baht(q.data.totals.value)} icon={TrendingUp} tone="info" />
              <StatCard label="ภาษีขาย (Output VAT)" value={baht(q.data.totals.vat)} icon={TrendingUp} tone="success" />
              <StatCard label="ใบกำกับอย่างย่อ" value={num(q.data.abbreviated_count)} icon={Calendar} />
            </div>
            <DataTable
              rows={q.data.rows}
              columns={[
                { key: 'date', label: 'วันที่', render: (r: any) => thaiDate(r.date) },
                { key: 'doc_no', label: 'เลขที่เอกสาร' },
                { key: 'type', label: 'ประเภท', render: (r: any) => (r.type === 'abbreviated' ? 'อย่างย่อ' : 'เต็มรูป') },
                { key: 'buyer_name', label: 'ผู้ซื้อ' },
                { key: 'buyer_tax_id', label: 'เลขผู้เสียภาษี' },
                { key: 'value', label: 'มูลค่า', align: 'right', render: (r: any) => <span className="tabular">{baht(r.value)}</span> },
                { key: 'vat', label: 'VAT', align: 'right', render: (r: any) => <span className="tabular">{baht(r.vat)}</span> },
              ]}
              emptyState={{
                icon: ReceiptText,
                title: 'ไม่มีภาษีขายในรอบนี้',
                description: 'ยังไม่มีใบกำกับภาษีขายในเดือน/ปีที่เลือก ลองเปลี่ยนรอบด้านบนเพื่อดูข้อมูลรอบอื่น',
              }}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ── ภาษีซื้อ (Input VAT) ──
function InputVat() {
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
              <StatCard label="จำนวนรายการ" value={num(q.data.totals.count)} icon={Calendar} tone="primary" />
              <StatCard label="ฐานภาษีซื้อ" value={baht(q.data.totals.base)} icon={TrendingDown} tone="info" />
              <StatCard label="ภาษีซื้อ (Input VAT)" value={baht(q.data.totals.vat)} icon={TrendingDown} tone="warning" />
            </div>
            <DataTable
              rows={q.data.rows}
              columns={[
                { key: 'date', label: 'วันที่', render: (r: any) => thaiDate(r.date) },
                { key: 'doc_no', label: 'เลขที่' },
                { key: 'invoice_no', label: 'เลขใบกำกับ' },
                { key: 'vendor_name', label: 'ผู้ขาย' },
                { key: 'base', label: 'ฐานภาษี', align: 'right', render: (r: any) => <span className="tabular">{baht(r.base)}</span> },
                { key: 'vat', label: 'VAT', align: 'right', render: (r: any) => <span className="tabular">{baht(r.vat)}</span> },
              ]}
              emptyState={{
                icon: FileText,
                title: 'ไม่มีภาษีซื้อในรอบนี้',
                description: 'ยังไม่มีใบกำกับภาษีซื้อในเดือน/ปีที่เลือก ลองเปลี่ยนรอบด้านบนเพื่อดูข้อมูลรอบอื่น',
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
              <StatCard label="ยอดขายที่ต้องเสียภาษี" value={baht(q.data.form.sales_taxable)} icon={TrendingUp} tone="info" />
              <StatCard label="ภาษีขาย" value={baht(q.data.form.output_vat)} icon={TrendingUp} tone="success" />
              <StatCard label="ภาษีซื้อ" value={baht(q.data.form.input_vat)} icon={TrendingDown} tone="warning" />
              <StatCard
                label={q.data.form.vat_payable > 0 ? 'ภาษีที่ต้องชำระ' : 'ภาษีซื้อยกไป'}
                value={baht(q.data.form.vat_payable > 0 ? q.data.form.vat_payable : q.data.form.vat_credit_carry_forward)}
                icon={Scale}
                tone={q.data.form.vat_payable > 0 ? 'danger' : 'success'}
              />
            </div>

            <Card className="gap-3 p-5">
              <h3 className="text-sm font-semibold text-muted-foreground">สรุปแบบ ภ.พ.30 — รอบ {q.data.period}</h3>
              <table className="w-full text-sm">
                <tbody>
                  <tr><td className="py-1">ยอดขายที่ต้องเสียภาษี</td><td className="py-1 text-right tabular">{baht(q.data.form.sales_taxable)}</td></tr>
                  <tr><td className="py-1">ภาษีขาย (Output VAT)</td><td className="py-1 text-right tabular">{baht(q.data.form.output_vat)}</td></tr>
                  <tr><td className="py-1">ยอดซื้อ</td><td className="py-1 text-right tabular">{baht(q.data.form.purchases)}</td></tr>
                  <tr><td className="py-1">ภาษีซื้อ (Input VAT)</td><td className="py-1 text-right tabular">{baht(q.data.form.input_vat)}</td></tr>
                  <tr className="border-t font-semibold">
                    <td className="py-1">{q.data.form.vat_payable > 0 ? 'ภาษีที่ต้องชำระ' : 'ภาษีซื้อยกไปเดือนถัดไป'}</td>
                    <td className="py-1 text-right tabular">{baht(q.data.form.vat_payable > 0 ? q.data.form.vat_payable : q.data.form.vat_credit_carry_forward)}</td>
                  </tr>
                </tbody>
              </table>
            </Card>

            <Card className="flex-row flex-wrap items-center gap-2 p-5 text-sm">
              <Scale className="size-4 text-muted-foreground" />
              กระทบยอดบัญชี {q.data.reconciliation.gl_account}: เคลื่อนไหว GL{' '}
              <span className="tabular">{baht(q.data.reconciliation.gl_net_movement)}</span> · ภาษีสุทธิตามรายงาน{' '}
              <span className="tabular">{baht(q.data.reconciliation.report_net_vat)}</span>{' '}
              <Badge variant={q.data.reconciliation.tied ? 'success' : 'destructive'}>
                {q.data.reconciliation.tied ? 'ตรงกัน' : 'ไม่ตรงกัน'}
              </Badge>
            </Card>

            <Card className="gap-1 p-5 text-sm">
              <div className="flex items-center gap-2">
                <Calendar className="size-4 text-muted-foreground" />
                กำหนดยื่นแบบ: <strong>{thaiDate(q.data.deadline)}</strong>
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
const FILING_STATUS_TH: Record<string, string> = { NOT_FILED: 'ยังไม่ยื่น', DRAFT: 'ฉบับร่าง', SUBMITTED: 'ยื่นแล้ว', ACCEPTED: 'รับแล้ว' };
const filingVariant = (s: string) => (s === 'ACCEPTED' ? 'success' : s === 'SUBMITTED' ? 'info' : s === 'DRAFT' ? 'warning' : 'muted');

function Filings() {
  const [year, setYear] = useState(2026);
  const qc = useQueryClient();
  const cal = useQuery<any>({ queryKey: ['remittance-calendar', year], queryFn: () => api(`/api/tax-reports/remittance-calendar?year=${year}`) });

  const file = useMutation({
    mutationFn: (v: { filing_type: string; month: number }) => api('/api/tax-reports/filings', { method: 'POST', body: JSON.stringify({ ...v, year }) }),
    onSuccess: (r: any) => { notifySuccess(r?.already_filed ? `ยื่นไว้แล้ว (${r.status})` : `สร้างฉบับร่าง ${r.filing_type} แล้ว`); qc.invalidateQueries({ queryKey: ['remittance-calendar'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const submit = useMutation({
    mutationFn: (id: number) => api(`/api/tax-reports/filings/${id}/submit`, { method: 'POST', body: JSON.stringify({ submission_ref: window.prompt('เลขอ้างอิงการยื่น (RD reference)') ?? '' }) }),
    onSuccess: () => { notifySuccess('ยื่นแบบแล้ว'); qc.invalidateQueries({ queryKey: ['remittance-calendar'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div>
      <div className="mb-4 grid w-[110px] gap-1.5">
        <Label>ปี (ค.ศ.)</Label>
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
              { key: 'filing_type', label: 'แบบ' },
              { key: 'period_month', label: 'งวด', render: (r: any) => `${THAI_MONTHS[r.period_month - 1]} ${r.period_year}` },
              { key: 'deadline', label: 'กำหนดยื่น', render: (r: any) => r.deadline },
              { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={filingVariant(r.status)}>{FILING_STATUS_TH[r.status] ?? r.status}</Badge> },
              { key: 'submission_ref', label: 'เลขอ้างอิง', render: (r: any) => r.submission_ref ?? '—' },
              {
                key: 'act', label: '', align: 'right', render: (r: any) =>
                  r.status === 'NOT_FILED' ? <Button size="sm" variant="outline" disabled={file.isPending} onClick={() => file.mutate({ filing_type: r.filing_type, month: r.period_month })}>สร้างร่าง</Button>
                  : r.status === 'DRAFT' ? <Button size="sm" variant="outline" disabled={submit.isPending} onClick={() => submit.mutate(r.filing_id)}>ยื่น</Button>
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
  return (
    <div>
      <PageHeader
        title="รายงานภาษี"
        description="รายงานภาษีขาย / ภาษีซื้อ และแบบ ภ.พ.30 / ภ.ง.ด. — เลือกเดือน/ปีเพื่อดูข้อมูลแต่ละรอบ และติดตามการยื่นแบบ"
      />
      <Tabs
        tabs={[
          { key: 'output', label: 'ภาษีขาย (Output VAT)', content: <OutputVat initialData={initialOutputVat} /> },
          { key: 'input', label: 'ภาษีซื้อ (Input VAT)', content: <InputVat /> },
          { key: 'pp30', label: 'ภ.พ.30', content: <Pp30 /> },
          { key: 'filings', label: 'การยื่นแบบ & ปฏิทิน', content: <Filings /> },
        ]}
      />
    </div>
  );
}
