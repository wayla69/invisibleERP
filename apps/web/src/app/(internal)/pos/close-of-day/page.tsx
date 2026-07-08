'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ReceiptText, ShieldCheck, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDateTime } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable, type Column } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type XzReport = {
  id: number; till_session_id: number; report_type: string; status: string; generated_by: string;
  generated_at: string; gross_sales: number; total_cash: number; total_card: number; total_refund: number;
  cash_expected: number; cash_counted: number; variance: number; content_hash: string; hash_valid?: boolean;
};

export default function CloseOfDayPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [sessionNo, setSessionNo] = useState('');

  const list = useQuery<{ reports: XzReport[]; count: number }>({
    queryKey: ['xz-reports'],
    queryFn: () => api('/api/payments/xz-reports'),
  });

  const sign = useMutation({
    mutationFn: (s: string) => api(`/api/payments/till/${encodeURIComponent(s)}/z-report/sign`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r: any) => {
      notifySuccess(r?.already ? t('px.cod_already') : t('px.cod_signed_ok', { id: r?.id }));
      setSessionNo('');
      qc.invalidateQueries({ queryKey: ['xz-reports'] });
    },
    onError: (e: any) => notifyError(e?.message ?? t('px.cod_sign_fail')),
  });

  const columns: Column<XzReport>[] = [
    { key: 'id', label: '#', render: (r) => `Z-${r.id}` },
    { key: 'generated_at', label: t('px.cod_time'), render: (r) => thaiDateTime(r.generated_at) },
    { key: 'gross_sales', label: t('px.cod_gross'), align: 'right', render: (r) => baht(r.gross_sales) },
    { key: 'total_cash', label: t('px.cod_cash'), align: 'right', render: (r) => baht(r.total_cash) },
    { key: 'cash_counted', label: t('px.cod_counted'), align: 'right', render: (r) => baht(r.cash_counted) },
    { key: 'variance', label: t('px.cod_variance'), align: 'right', render: (r) => <span className={r.variance < 0 ? 'text-destructive' : ''}>{baht(r.variance)}</span> },
    { key: 'generated_by', label: t('px.cod_signed_by') },
    {
      key: 'hash_valid', label: t('px.cod_integrity'), align: 'center',
      render: (r) => r.hash_valid === false
        ? <Badge variant="destructive"><ShieldAlert className="mr-1 h-3 w-3" />{t('px.cod_tampered')}</Badge>
        : <Badge variant="secondary"><ShieldCheck className="mr-1 h-3 w-3" />{t('px.cod_valid')}</Badge>,
    },
  ];

  return (
    <div>
      <PageHeader title={t('px.cod_title')} description={t('px.cod_desc')} />

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">{t('px.cod_card_title')}</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="sess">{t('px.cod_sess_label')}</Label>
              <Input id="sess" value={sessionNo} onChange={(e) => setSessionNo(e.target.value)} placeholder="TILL-20260626-001" className="w-64" />
            </div>
            <Button disabled={!sessionNo || sign.isPending} onClick={() => sign.mutate(sessionNo)}>
              <ReceiptText className="mr-1.5 h-4 w-4" />{sign.isPending ? t('px.cod_signing') : t('px.cod_sign_btn')}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t('px.cod_hint')}</p>
        </CardContent>
      </Card>

      <DataTable
        rows={list.data?.reports ?? []}
        columns={columns}
        loading={list.isLoading}
        emptyState={{ icon: ReceiptText, title: t('px.cod_empty_title'), description: t('px.cod_empty_desc') }}
      />
    </div>
  );
}
