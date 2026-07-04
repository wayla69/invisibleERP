'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Coins, Plus, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useLang } from '@/lib/i18n';

const today = () => new Date().toISOString().slice(0, 10);

export default function FxPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('fnx.fx.title')}
        description={t('fnx.fx.subtitle')}
      />
      <Tabs
        tabs={[
          { key: 'rates', label: t('fnx.fx.tab_rates'), content: <Rates /> },
          { key: 'revalue', label: t('fnx.fx.tab_revalue'), content: <Revalue /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── rate table + add/update form ─────────────────────────
function Rates() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['fx-rates'], queryFn: () => api('/api/fx/rates') });

  const [currency, setCurrency] = useState('USD');
  const [rateDate, setRateDate] = useState(today());
  const [rate, setRate] = useState('');
  const [shared, setShared] = useState(false);

  const setRateMut = useMutation({
    mutationFn: () =>
      api<any>('/api/fx/rates', {
        method: 'POST',
        body: JSON.stringify({ currency: currency.toUpperCase(), rate_date: rateDate, rate: Number(rate), shared }),
      }),
    onSuccess: (r) => {
      notifySuccess(r.status === 'PendingApproval'
        ? t('fnx.fx.rate_pending', { currency: r.currency, rate: num(r.rate) })
        : t('fnx.fx.rate_saved', { currency: r.currency, rate: num(r.rate), date: r.rate_date }));
      setRate('');
      qc.invalidateQueries({ queryKey: ['fx-rates'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  // FX-04 maker-checker: approve/reject a pending manual rate (must be a different user from the requester).
  const decide = useMutation({
    mutationFn: ({ r, action }: { r: any; action: 'approve' | 'reject' }) =>
      api<any>(`/api/fx/rates/${action}`, { method: 'POST', body: JSON.stringify({ currency: r.currency, rate_date: r.rate_date, shared: r.tenant_id == null }) }),
    onSuccess: (_r, v) => { notifySuccess(v.action === 'approve' ? t('fnx.fx.rate_approved') : t('fnx.fx.rate_rejected')); qc.invalidateQueries({ queryKey: ['fx-rates'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4 p-5">
        <h3 className="text-base font-semibold">เพิ่ม / อัปเดตอัตรา</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="fx-ccy">สกุลเงิน</Label>
            <Input id="fx-ccy" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="USD" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="fx-date">วันที่</Label>
            <Input id="fx-date" type="date" value={rateDate} onChange={(e) => setRateDate(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="fx-rate">อัตรา (ต่อ THB)</Label>
            <Input id="fx-rate" type="number" step="0.0001" min="0" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="35.5" />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="size-4 rounded border-input" />
          ใช้ร่วมทุกร้าน (shared)
        </label>
        <div>
          <Button disabled={setRateMut.isPending || currency.length !== 3 || !rate} onClick={() => setRateMut.mutate()}>
            <Plus className="size-4" /> {setRateMut.isPending ? 'กำลังบันทึก…' : 'บันทึกอัตรา'}
          </Button>
        </div>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <StatCard label="จำนวนอัตราที่บันทึก" value={num(q.data.count)} icon={Coins} tone="primary" className="max-w-xs" />
            <DataTable
              rows={q.data.rates}
              columns={[
                { key: 'currency', label: 'สกุลเงิน' },
                { key: 'rate_date', label: 'วันที่', render: (r: any) => thaiDate(r.rate_date) },
                { key: 'rate', label: 'อัตรา (ต่อ THB)', align: 'right', render: (r: any) => <span className="tabular">{num(r.rate)}</span> },
                { key: 'tenant_id', label: 'ขอบเขต', render: (r: any) => (r.tenant_id == null ? 'ใช้ร่วม' : `ร้าน #${r.tenant_id}`) },
                { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={r.status === 'Approved' ? 'success' : r.status === 'PendingApproval' ? 'warning' : 'destructive'}>{r.status === 'Approved' ? 'อนุมัติแล้ว' : r.status === 'PendingApproval' ? 'รออนุมัติ' : 'ปฏิเสธ'}</Badge> },
                { key: 'act', label: '', align: 'right', render: (r: any) => r.status === 'PendingApproval' ? (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ r, action: 'approve' })}>อนุมัติ</Button>
                    <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ r, action: 'reject' })}>ปฏิเสธ</Button>
                  </div>
                ) : null },
              ]}
              emptyState={{
                icon: Coins,
                title: 'ยังไม่มีอัตราแลกเปลี่ยน',
                description: 'กรอกสกุลเงิน วันที่ และอัตราด้านบน เพื่อบันทึกอัตราสิ้นงวดรายการแรก',
              }}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── unrealized report + revaluation action ─────────────────────────
function Revalue() {
  const [asOf, setAsOf] = useState(today());
  const [currency, setCurrency] = useState('USD');
  const [autoReverse, setAutoReverse] = useState(true);

  const report = useQuery<any>({
    queryKey: ['fx-unrealized', asOf, currency],
    queryFn: () => api(`/api/fx/unrealized?as_of=${asOf}${currency ? `&currency=${currency.toUpperCase()}` : ''}`),
  });

  const revalue = useMutation({
    mutationFn: () =>
      api<any>('/api/fx/revalue', {
        method: 'POST',
        body: JSON.stringify({ as_of: asOf, currency: currency.toUpperCase(), auto_reverse: autoReverse }),
      }),
    onSuccess: (r) => {
      if (r.already) notifySuccess(`ตีราคา ${r.currency} ณ ${r.as_of} ลงบัญชีไปแล้ว`);
      else if (!r.entry_no) notifySuccess(`${r.note ?? 'ไม่มียอดคงค้างสกุลต่างประเทศ'}`);
      else notifySuccess(`ตีราคา ${r.currency} @ ${num(r.current_rate)} · JE ${r.entry_no}${r.reverse_entry_no ? ` (กลับ ${r.reverse_entry_no})` : ''}`);
      report.refetch();
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-5">
      <Card className="gap-4 p-5">
        <h3 className="text-base font-semibold">ตีราคาอัตราแลกเปลี่ยน</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="rev-asof">ณ วันที่</Label>
            <Input id="rev-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rev-ccy">สกุลเงิน</Label>
            <Input id="rev-ccy" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="USD" />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={autoReverse} onChange={(e) => setAutoReverse(e.target.checked)} className="size-4 rounded border-input" />
          กลับรายการต้นงวดถัดไป (auto-reverse)
        </label>
        <div>
          <Button disabled={revalue.isPending || currency.length !== 3} onClick={() => revalue.mutate()}>
            <RefreshCw className="size-4" /> {revalue.isPending ? 'กำลังตีราคา…' : 'ตีราคาและลงบัญชี'}
          </Button>
        </div>
      </Card>

      <StateView q={report}>
        {report.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="ผลต่าง AR" value={baht(report.data.totals?.ar_delta)} tone={Number(report.data.totals?.ar_delta) >= 0 ? 'success' : 'danger'} />
              <StatCard label="ผลต่าง AP" value={baht(report.data.totals?.ap_delta)} tone={Number(report.data.totals?.ap_delta) >= 0 ? 'success' : 'danger'} />
              <StatCard label="ผลต่างสุทธิ" value={baht(report.data.totals?.net_delta)} tone={Number(report.data.totals?.net_delta) >= 0 ? 'success' : 'danger'} />
            </div>

            <div>
              <h4 className="mb-3 text-sm font-semibold text-muted-foreground">ลูกหนี้ (AR) สกุลต่างประเทศคงค้าง</h4>
              <DataTable
                rows={report.data.ar ?? []}
                columns={fxRowColumns}
                emptyState={{ title: 'ไม่มีลูกหนี้สกุลต่างประเทศคงค้าง' }}
                dense
              />
            </div>
            <div>
              <h4 className="mb-3 text-sm font-semibold text-muted-foreground">เจ้าหนี้ (AP) สกุลต่างประเทศคงค้าง</h4>
              <DataTable
                rows={report.data.ap ?? []}
                columns={fxRowColumns}
                emptyState={{ title: 'ไม่มีเจ้าหนี้สกุลต่างประเทศคงค้าง' }}
                dense
              />
            </div>
          </div>
        )}
      </StateView>
    </div>
  );
}

const fxRowColumns = [
  { key: 'doc_no', label: 'เลขที่เอกสาร' },
  { key: 'currency', label: 'สกุล' },
  { key: 'open_foreign', label: 'คงค้าง (ตปท.)', align: 'right' as const, render: (r: any) => <span className="tabular">{num(r.open_foreign)}</span> },
  { key: 'booked_rate', label: 'อัตราเดิม', align: 'right' as const, render: (r: any) => <span className="tabular">{num(r.booked_rate)}</span> },
  { key: 'current_rate', label: 'อัตราปัจจุบัน', align: 'right' as const, render: (r: any) => <span className="tabular">{num(r.current_rate)}</span> },
  { key: 'booked_thb', label: 'มูลค่าเดิม (THB)', align: 'right' as const, render: (r: any) => <span className="tabular">{baht(r.booked_thb)}</span> },
  { key: 'current_thb', label: 'มูลค่าปัจจุบัน (THB)', align: 'right' as const, render: (r: any) => <span className="tabular">{baht(r.current_thb)}</span> },
  { key: 'delta', label: 'ผลต่าง', align: 'right' as const, render: (r: any) => <span className="tabular">{baht(r.delta)}</span> },
];
