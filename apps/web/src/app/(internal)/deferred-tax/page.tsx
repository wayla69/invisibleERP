'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Calculator, Landmark, Scale, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
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

const thisMonth = () => new Date().toISOString().slice(0, 7);
const pct = (v: unknown) => `${(Number(v ?? 0) * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

function statusBadge(status: string) {
  return status === 'Posted'
    ? <Badge variant="success">โพสต์แล้ว</Badge>
    : <Badge variant="warning">รอโพสต์ (Open)</Badge>;
}

// TAS 12 / TAX-06 — deferred tax run → review → post. runDeferredTax stages an 'Open' run (DTA/DTL from
// book-vs-tax temporary differences); posting is maker-checker (poster ≠ runner, enforced server-side).
export default function DeferredTaxPage() {
  return (
    <div>
      <PageHeader
        title="ภาษีเงินได้รอการตัดบัญชี (Deferred Tax)"
        description="คำนวณสินทรัพย์/หนี้สินภาษีเงินได้รอการตัดบัญชี (DTA/DTL) จากผลแตกต่างชั่วคราวทางบัญชี-ภาษี (TAS 12) แล้วให้ผู้มีสิทธิ์คนละคนโพสต์ผลต่างเข้า GL (1700/5950)"
      />
      <Tabs
        urlParam="tab"
        tabs={[
          { key: 'review', label: 'รายการที่คำนวณ / โพสต์', content: <RunsList /> },
          { key: 'run', label: 'คำนวณงวดใหม่', content: <RunForm /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── staged runs table + maker-checker post ─────────────────────────
function RunsList() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['deferred-tax'], queryFn: () => api('/api/ledger/deferred-tax') });

  const post = useMutation({
    mutationFn: (id: number) => api<any>(`/api/ledger/deferred-tax/${id}/post`, { method: 'POST' }),
    onSuccess: (r) => {
      notifySuccess(r.entry_no
        ? `โพสต์งวด ${r.period} แล้ว · JE ${r.entry_no} (ผลต่าง ${baht(r.delta_posted)})`
        : `โพสต์งวด ${r.period} แล้ว — ไม่มีผลต่างที่ต้องลงบัญชี`);
      qc.invalidateQueries({ queryKey: ['deferred-tax'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const latest = q.data?.runs?.[0];

  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          {latest && (
            <div className="grid gap-4 sm:grid-cols-4">
              <StatCard label="สินทรัพย์ภาษีรอตัดบัญชี (DTA)" value={baht(latest.dta)} icon={Wallet} tone="success" hint={`งวด ${latest.period}`} />
              <StatCard label="หนี้สินภาษีรอตัดบัญชี (DTL)" value={baht(latest.dtl)} icon={Scale} tone="danger" />
              <StatCard label="สุทธิ (DTA − DTL)" value={baht(latest.net_deferred)} icon={Landmark} tone={Number(latest.net_deferred) >= 0 ? 'primary' : 'warning'} />
              <StatCard label="ผลต่างที่ต้องโพสต์" value={baht(latest.delta_posted)} icon={Calculator} tone={Number(latest.delta_posted) >= 0 ? 'success' : 'danger'} hint={statusBadge(latest.status)} />
            </div>
          )}

          <DataTable
            rows={q.data.runs ?? []}
            rowKey={(r: any) => r.id}
            columns={[
              { key: 'period', label: 'งวด' },
              { key: 'as_of_date', label: 'ณ วันที่', render: (r: any) => thaiDate(r.as_of_date) },
              { key: 'tax_rate', label: 'อัตราภาษี', align: 'right', render: (r: any) => <span className="tabular">{pct(r.tax_rate)}</span> },
              { key: 'dta', label: 'DTA', align: 'right', render: (r: any) => <span className="tabular">{baht(r.dta)}</span> },
              { key: 'dtl', label: 'DTL', align: 'right', render: (r: any) => <span className="tabular">{baht(r.dtl)}</span> },
              { key: 'net_deferred', label: 'สุทธิ', align: 'right', render: (r: any) => <span className="tabular">{baht(r.net_deferred)}</span> },
              { key: 'delta_posted', label: 'ผลต่าง', align: 'right', render: (r: any) => <span className="tabular">{baht(r.delta_posted)}</span> },
              { key: 'status', label: 'สถานะ', render: (r: any) => statusBadge(r.status) },
              { key: 'run_by', label: 'ผู้คำนวณ', render: (r: any) => r.run_by ?? '—' },
              { key: 'posted_by', label: 'ผู้โพสต์', render: (r: any) => r.posted_by ?? '—' },
              { key: 'act', label: '', align: 'right', sortable: false, render: (r: any) => r.status === 'Open' ? (
                <Button size="sm" disabled={post.isPending} onClick={() => post.mutate(r.id)}>โพสต์เข้า GL</Button>
              ) : null },
            ]}
            emptyState={{
              icon: Calculator,
              title: 'ยังไม่มีการคำนวณภาษีเงินได้รอการตัดบัญชี',
              description: 'ไปที่แท็บ “คำนวณงวดใหม่” เพื่อคำนวณ DTA/DTL ของงวดแรก',
            }}
          />
          <p className="text-xs text-muted-foreground">
            การโพสต์ต้องทำโดยผู้มีสิทธิ์คนละคนกับผู้คำนวณ (แบ่งแยกหน้าที่ / maker-checker) — ระบบจะปฏิเสธหากพยายามโพสต์รายการที่ตนคำนวณเอง
          </p>
        </div>
      )}
    </StateView>
  );
}

// ───────────────────────── compute (run) form ─────────────────────────
function RunForm() {
  const qc = useQueryClient();
  const [period, setPeriod] = useState(thisMonth());
  const [asOf, setAsOf] = useState('');
  const [taxRate, setTaxRate] = useState('');
  const [depFactor, setDepFactor] = useState('');
  const [result, setResult] = useState<any>(null);

  const run = useMutation({
    mutationFn: () =>
      api<any>('/api/ledger/deferred-tax/run', {
        method: 'POST',
        body: JSON.stringify({
          period,
          ...(asOf ? { as_of_date: asOf } : {}),
          ...(taxRate ? { tax_rate: Number(taxRate) } : {}),
          ...(depFactor ? { tax_dep_factor: Number(depFactor) } : {}),
        }),
      }),
    onSuccess: (r) => {
      setResult(r);
      notifySuccess(`คำนวณงวด ${r.period} แล้ว — สุทธิ ${baht(r.net_deferred)} (ผลต่างที่ต้องโพสต์ ${baht(r.delta_posted)})`);
      qc.invalidateQueries({ queryKey: ['deferred-tax'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const validPeriod = /^\d{4}-\d{2}$/.test(period);

  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4 p-5">
        <h3 className="text-base font-semibold">คำนวณ DTA/DTL</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="dt-period">งวด (YYYY-MM)</Label>
            <Input id="dt-period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-07" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dt-asof">ณ วันที่ (ไม่ระบุ = สิ้นงวด)</Label>
            <Input id="dt-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dt-rate">อัตราภาษี (ไม่ระบุ = 20%)</Label>
            <Input id="dt-rate" type="number" step="0.01" min="0" max="1" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} placeholder="0.20" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dt-depf">ตัวคูณค่าเสื่อมทางภาษี (ไม่ระบุ = 1.5)</Label>
            <Input id="dt-depf" type="number" step="0.1" min="0" value={depFactor} onChange={(e) => setDepFactor(e.target.value)} placeholder="1.5" />
          </div>
        </div>
        <div>
          <Button disabled={run.isPending || !validPeriod} onClick={() => run.mutate()}>
            <Calculator className="size-4" /> {run.isPending ? 'กำลังคำนวณ…' : 'คำนวณ (สร้างรายการสถานะ Open)'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          การคำนวณจะสร้าง/ปรับรายการสถานะ Open (ยังไม่ลงบัญชี) — ไปที่แท็บ “รายการที่คำนวณ / โพสต์” เพื่อให้ผู้มีสิทธิ์คนละคนโพสต์เข้า GL
        </p>
      </Card>

      {result && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-4">
            <StatCard label="DTA" value={baht(result.dta)} tone="success" />
            <StatCard label="DTL" value={baht(result.dtl)} tone="danger" />
            <StatCard label="สุทธิ (DTA − DTL)" value={baht(result.net_deferred)} tone="primary" hint={`ยอดยกมา ${baht(result.prior_net)}`} />
            <StatCard label="ผลต่างที่ต้องโพสต์" value={baht(result.delta_posted)} tone={Number(result.delta_posted) >= 0 ? 'success' : 'danger'} />
          </div>
          <div>
            <h4 className="mb-3 text-sm font-semibold text-muted-foreground">ผลแตกต่างชั่วคราว (Temporary differences)</h4>
            <DataTable
              rows={result.temp_differences ?? []}
              columns={[
                { key: 'name', label: 'รายการ' },
                { key: 'bookBasis', label: 'มูลค่าทางบัญชี', align: 'right', render: (r: any) => <span className="tabular">{baht(r.bookBasis)}</span> },
                { key: 'taxBasis', label: 'มูลค่าทางภาษี', align: 'right', render: (r: any) => <span className="tabular">{baht(r.taxBasis)}</span> },
                { key: 'difference', label: 'ผลแตกต่าง', align: 'right', render: (r: any) => <span className="tabular">{baht(r.difference)}</span> },
                { key: 'dtAssetOrLiab', label: 'ประเภท', render: (r: any) => <Badge variant={r.dtAssetOrLiab === 'DTA' ? 'success' : 'warning'}>{r.dtAssetOrLiab}</Badge> },
              ]}
              emptyState={{ title: 'ไม่มีผลแตกต่างชั่วคราวในงวดนี้' }}
              dense
            />
          </div>
        </div>
      )}
    </div>
  );
}
