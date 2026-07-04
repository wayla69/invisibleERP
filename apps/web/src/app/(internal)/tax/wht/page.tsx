'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FileMinus, Coins, Receipt, Plus, ExternalLink, Ban, SearchX } from 'lucide-react';
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
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { statusVariant } from '@/components/ui';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
const today = () => new Date().toISOString().slice(0, 10);

const PND_TYPES = ['PND3', 'PND53', 'PND1K', 'PND1KS', 'PND2', 'PND2K', 'PND3K'];
// common income types (see wht-rates.ts); rate falls back to the standard for the income type
const INCOME_TYPES: { value: string; key: string }[] = [
  { value: '40(2)', key: 'tax.income_40_2' },
  { value: '40(3)', key: 'tax.income_40_3' },
  { value: '40(4)', key: 'tax.income_40_4' },
  { value: '40(5)', key: 'tax.income_40_5' },
  { value: '40(6)', key: 'tax.income_40_6' },
  { value: '40(7)', key: 'tax.income_40_7' },
  { value: '40(8)', key: 'tax.income_40_8' },
];

type Cert = {
  doc_no: string;
  pnd_type: string;
  status: string;
  date_paid: string;
  payee: { name: string; tax_id: string; kind: string };
  total_paid: number;
  total_wht: number;
};

export default function WhtPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const q = useQuery<{ certificates: Cert[]; count: number }>({
    queryKey: ['wht-certs', filter],
    queryFn: () => api(`/api/wht/certificates${filter ? `?pnd=${filter}` : ''}`),
  });

  const certs = q.data?.certificates ?? [];
  const totalWht = certs.reduce((a, r) => a + (r.total_wht || 0), 0);
  const totalPaid = certs.reduce((a, r) => a + (r.total_paid || 0), 0);

  // ── ออกหนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) ──
  const [datePaid, setDatePaid] = useState(today());
  const [payeeName, setPayeeName] = useState('');
  const [payeeTaxId, setPayeeTaxId] = useState('');
  const [payeeKind, setPayeeKind] = useState<'person' | 'company'>('company');
  const [incomeType, setIncomeType] = useState('40(2)');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');

  const issue = useMutation({
    mutationFn: () =>
      api<{ doc_no: string }>('/api/wht/certificates', {
        method: 'POST',
        body: JSON.stringify({
          date_paid: datePaid,
          payee: { name: payeeName, tax_id: payeeTaxId, kind: payeeKind },
          lines: [
            {
              income_type: incomeType,
              amount_paid: Number(amount),
              ...(rate ? { rate: Number(rate) } : {}),
            },
          ],
        }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('tax.cert_issued', { doc: r.doc_no }));
      setPayeeName(''); setPayeeTaxId(''); setAmount(''); setRate('');
      qc.invalidateQueries({ queryKey: ['wht-certs'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const canIssue = !!payeeName && !!payeeTaxId && Number(amount) > 0 && !issue.isPending;

  return (
    <div>
      <PageHeader
        title={t('tax.wht_title')}
        description={t('tax.wht_subtitle')}
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button variant={filter === '' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('')}>
          {t('tax.all')}
        </Button>
        {PND_TYPES.map((p) => (
          <Button key={p} variant={filter === p ? 'default' : 'outline'} size="sm" onClick={() => setFilter(p)}>
            {p}
          </Button>
        ))}
      </div>

      <Card className="mb-6 max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plus className="size-4" /> {t('tax.wht_issue_card')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="date-paid">{t('tax.date_paid')}</Label>
              <Input id="date-paid" type="date" value={datePaid} onChange={(e) => setDatePaid(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>{t('tax.payee_kind')}</Label>
              <Select value={payeeKind} onValueChange={(v) => setPayeeKind(v as 'person' | 'company')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="company">{t('tax.payee_company')}</SelectItem>
                  <SelectItem value="person">{t('tax.payee_person')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="payee-name">{t('tax.payee_name')}</Label>
            <Input id="payee-name" value={payeeName} onChange={(e) => setPayeeName(e.target.value)} placeholder={t('tax.payee_name_ph')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="payee-taxid">{t('tax.taxid_13')}</Label>
            <Input id="payee-taxid" value={payeeTaxId} onChange={(e) => setPayeeTaxId(e.target.value)} placeholder={t('tax.taxid_13_ph')} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label>{t('tax.income_type')}</Label>
              <Select value={incomeType} onValueChange={setIncomeType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INCOME_TYPES.map((it) => (
                    <SelectItem key={it.value} value={it.value}>{t(it.key)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="amount">{t('tax.wht_base')}</Label>
              <Input id="amount" type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rate">{t('tax.rate')}</Label>
              <Input id="rate" type="number" min="0" max="0.3" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} placeholder={t('tax.auto')} />
            </div>
          </div>
          <Button disabled={!canIssue} onClick={() => issue.mutate()}>
            <Receipt className="size-4" /> {issue.isPending ? t('tax.issuing') : t('tax.wht_issue_btn')}
          </Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label={t('tax.cert_count')} value={num(q.data.count)} icon={FileMinus} tone="primary" />
              <StatCard label={t('tax.total_paid')} value={baht(totalPaid)} icon={Coins} />
              <StatCard label={t('tax.total_wht')} value={baht(totalWht)} icon={Receipt} tone="info" />
            </div>
            <DataTable
              rows={certs}
              columns={[
                { key: 'doc_no', label: t('tax.col_doc_no') },
                { key: 'date_paid', label: t('tax.date_paid'), render: (r: Cert) => thaiDate(r.date_paid) },
                { key: 'pnd_type', label: t('tax.col_pnd') },
                { key: 'payee', label: t('tax.col_payee'), render: (r: Cert) => r.payee?.name ?? '—' },
                { key: 'payee_tax_id', label: t('tax.col_tax_id'), render: (r: Cert) => r.payee?.tax_id ?? '—' },
                { key: 'total_paid', label: t('tax.col_paid'), align: 'right', render: (r: Cert) => <span className="tabular">{baht(r.total_paid)}</span> },
                { key: 'total_wht', label: t('tax.col_wht'), align: 'right', render: (r: Cert) => <span className="tabular">{baht(r.total_wht)}</span> },
                { key: 'status', label: t('fin.col_status'), render: (r: Cert) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                {
                  key: 'pdf',
                  label: 'PDF',
                  sortable: false,
                  render: (r: Cert) => (
                    <Button variant="ghost" size="sm" asChild>
                      <a href={`${BASE}/api/wht/certificates/${r.doc_no}/pdf`} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="size-4" />
                      </a>
                    </Button>
                  ),
                },
              ]}
              emptyState={
                filter
                  ? {
                      icon: SearchX,
                      title: t('tax.wht_empty_filter_title', { pnd: filter }),
                      description: t('tax.wht_empty_filter_desc'),
                      action: (
                        <Button variant="outline" size="sm" onClick={() => setFilter('')}>
                          {t('inv.clear_filter')}
                        </Button>
                      ),
                    }
                  : {
                      icon: FileMinus,
                      title: t('tax.wht_empty_title'),
                      description: t('tax.wht_empty_desc'),
                    }
              }
            />
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Ban className="size-3.5" /> {t('tax.wht_void_note')}
            </p>
          </div>
        )}
      </StateView>
    </div>
  );
}
