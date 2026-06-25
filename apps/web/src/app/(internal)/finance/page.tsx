'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Banknote, BellRing, CalendarClock, Download, HandCoins, PlayCircle, Plus, ReceiptText, RefreshCw, TrendingUp, Wallet } from 'lucide-react';
import { api, apiDownload } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose,
} from '@/components/ui/dialog';
import { statusVariant } from '@/components/ui';
import { TrendAreaChart } from '@/components/charts';
import { Msg } from '@/components/tabs';

// AR/AP aging buckets in escalating-severity order — shared by the overview composition bars and the
// detail Aging section. Colours ramp current → 90+ so an overdue-heavy book reads "red" at a glance.
const AGING_BUCKETS = [
  { k: 'current', l: 'ยังไม่ครบกำหนด', cls: 'bg-success' },
  { k: 'd1_30', l: '1–30 วัน', cls: 'bg-info' },
  { k: 'd31_60', l: '31–60 วัน', cls: 'bg-warning' },
  { k: 'd61_90', l: '61–90 วัน', cls: 'bg-orange-500' },
  { k: 'd90_plus', l: '90+ วัน', cls: 'bg-destructive' },
] as const;

/** A single horizontal stacked bar showing how an outstanding balance splits across aging buckets. */
function AgingStack({ label, total, buckets }: { label: string; total: number; buckets?: Record<string, number> }) {
  const t = total || AGING_BUCKETS.reduce((a, b) => a + Number(buckets?.[b.k] ?? 0), 0);
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular text-muted-foreground">{baht(t)}</span>
      </div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${label} แยกตามอายุหนี้ รวม ${baht(t)}`}
      >
        {t > 0 &&
          AGING_BUCKETS.map((b) => {
            const v = Number(buckets?.[b.k] ?? 0);
            if (v <= 0) return null;
            return <div key={b.k} className={b.cls} style={{ width: `${(v / t) * 100}%` }} title={`${b.l}: ${baht(v)}`} />;
          })}
      </div>
    </div>
  );
}

export default function FinancePage() {
  const qc = useQueryClient();
  const kpi = useQuery<any>({ queryKey: ['fin-kpi'], queryFn: () => api('/api/finance/kpi') });
  const ar = useQuery<any>({ queryKey: ['fin-ar'], queryFn: () => api('/api/finance/ar?limit=50') });
  const ap = useQuery<any>({ queryKey: ['fin-ap'], queryFn: () => api('/api/finance/ap?status=Unpaid&limit=50') });

  // Awaiting-approval AP payments (checker queue). retry:false so a maker without approval rights simply
  // doesn't see the section (the 403 leaves data undefined) instead of getting an error banner.
  const pendingPay = useQuery<any>({ queryKey: ['fin-ap-pending'], queryFn: () => api('/api/finance/ap/payments/pending'), retry: false });
  // Overview visuals. The aging queries reuse the exact keys the detail Aging section uses, so React Query
  // dedupes them to a single fetch each — no extra network round-trips for the dashboard band.
  const trend = useQuery<any>({ queryKey: ['fin-revenue-trend'], queryFn: () => api('/api/dashboard/sales-trend?days=30') });
  const arAging = useQuery<any>({ queryKey: ['fin-ar-aging'], queryFn: () => api('/api/finance/ar/aging') });
  const apAging = useQuery<any>({ queryKey: ['fin-ap-aging'], queryFn: () => api('/api/finance/ap/aging') });
  const refresh = () => { for (const k of ['fin-kpi', 'fin-ar', 'fin-ap', 'fin-ap-pending', 'fin-revenue-trend', 'fin-ar-aging', 'fin-ap-aging']) qc.invalidateQueries({ queryKey: [k] }); };

  // ── AP vendor invoice entry ──
  const [apOpen, setApOpen] = useState(false);
  const [apForm, setApForm] = useState<any>({ vendor_name: '', invoice_no: '', invoice_date: '', due_date: '', amount: '', txn_type: 'Invoice', vat_treatment: 'standard' });
  const [apMsg, setApMsg] = useState('');
  const apCreate = useMutation({
    mutationFn: () => api('/api/finance/ap/transactions', { method: 'POST', body: JSON.stringify({ ...apForm, amount: Number(apForm.amount) }) }),
    onSuccess: (r: any) => { setApMsg(`✅ บันทึกบิล ${r.txn_no}`); refresh(); setApForm({ vendor_name: '', invoice_no: '', invoice_date: '', due_date: '', amount: '', txn_type: 'Invoice', vat_treatment: 'standard' }); },
    onError: (e: any) => setApMsg(`❌ ${e.message}`),
  });

  // ── AR receipt ──
  const [arOpen, setArOpen] = useState(false);
  const [arForm, setArForm] = useState<any>({ invoice_no: '', amount: '', method: 'Transfer', ref_no: '' });
  const [arMsg, setArMsg] = useState('');
  const arReceipt = useMutation({
    mutationFn: () => api('/api/finance/ar/receipts', { method: 'POST', body: JSON.stringify({ ...arForm, amount: Number(arForm.amount) }) }),
    onSuccess: (r: any) => { setArMsg(`✅ รับชำระ ${r.receipt_no} — สถานะ ${r.status}`); refresh(); setArForm({ invoice_no: '', amount: '', method: 'Transfer', ref_no: '' }); },
    onError: (e: any) => setArMsg(`❌ ${e.message}`),
  });
  const syncAr = useMutation({ mutationFn: () => api('/api/finance/ar/sync', { method: 'POST' }), onSuccess: () => refresh() });

  // ── AP pay REQUEST (per row) — maker-checker: this submits a request; a different user approves it ──
  const [payTxn, setPayTxn] = useState<string | null>(null);
  const [payAmt, setPayAmt] = useState('');
  const [payMsg, setPayMsg] = useState('');
  const payAp = useMutation({
    mutationFn: () => api(`/api/finance/ap/transactions/${payTxn}/pay`, { method: 'PATCH', body: JSON.stringify({ amount: Number(payAmt) }) }),
    onSuccess: (r: any) => { setPayMsg(`✅ ส่งคำขอจ่าย ${r.payment_no ?? r.txn_no} — รออนุมัติ`); refresh(); setPayTxn(null); setPayAmt(''); },
    onError: (e: any) => setPayMsg(`❌ ${e.message}`),
  });

  // ── AP payment approval (checker) — approve / reject a pending payment (approver ≠ requester) ──
  const [apprMsg, setApprMsg] = useState('');
  const approvePay = useMutation({
    mutationFn: (no: string) => api(`/api/finance/ap/payments/${no}/approve`, { method: 'POST' }),
    onSuccess: (r: any) => { setApprMsg(`✅ อนุมัติจ่าย ${r.payment_no} — บิล ${r.bill_status}`); refresh(); },
    onError: (e: any) => setApprMsg(`❌ ${e.message}`),
  });
  const rejectPay = useMutation({
    mutationFn: (no: string) => api(`/api/finance/ap/payments/${no}/reject`, { method: 'POST', body: JSON.stringify({ reason: 'rejected by approver' }) }),
    onSuccess: (r: any) => { setApprMsg(`✅ ปฏิเสธคำขอ ${r.payment_no}`); refresh(); },
    onError: (e: any) => setApprMsg(`❌ ${e.message}`),
  });

  const field = (label: string, key: string, props: any = {}, form = apForm, set = setApForm) => (
    <div className="grid gap-2">
      <Label htmlFor={key}>{label}</Label>
      <Input id={key} value={form[key] ?? ''} onChange={(e) => set((f: any) => ({ ...f, [key]: e.target.value }))} {...props} />
    </div>
  );

  const trendData = (trend.data?.trend ?? []).map((r: any) => ({ ...r, label: thaiDate(r.date) }));

  return (
    <div>
      <PageHeader
        title="การเงิน"
        description="รายได้ ลูกหนี้ และเจ้าหนี้"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => syncAr.mutate()} disabled={syncAr.isPending}>
              <RefreshCw className={`size-4 ${syncAr.isPending ? 'animate-spin' : ''}`} /> Sync AR
            </Button>
            {/* AR receipt */}
            <Dialog open={arOpen} onOpenChange={(o) => { setArOpen(o); setArMsg(''); }}>
              <DialogTrigger asChild><Button variant="outline" size="sm"><HandCoins className="size-4" /> รับชำระ (AR)</Button></DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>รับชำระจากลูกหนี้</DialogTitle></DialogHeader>
                <div className="grid gap-4">
                  {field('เลขที่ใบแจ้งหนี้', 'invoice_no', { placeholder: 'INV-…' }, arForm, setArForm)}
                  {field('จำนวนเงิน', 'amount', { type: 'number', step: '0.01' }, arForm, setArForm)}
                  {field('วิธีรับชำระ', 'method', {}, arForm, setArForm)}
                  {field('อ้างอิง', 'ref_no', {}, arForm, setArForm)}
                  {arMsg && <Msg ok={arMsg.startsWith('✅')}>{arMsg}</Msg>}
                </div>
                <DialogFooter>
                  <Button onClick={() => { setArMsg(''); arReceipt.mutate(); }} disabled={arReceipt.isPending || !arForm.invoice_no || !arForm.amount}>บันทึก</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            {/* AP entry */}
            <Dialog open={apOpen} onOpenChange={(o) => { setApOpen(o); setApMsg(''); }}>
              <DialogTrigger asChild><Button size="sm"><Plus className="size-4" /> บันทึกบิลเจ้าหนี้ (AP)</Button></DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>บันทึกบิลเจ้าหนี้</DialogTitle></DialogHeader>
                <div className="grid gap-4 sm:grid-cols-2">
                  {field('ชื่อเจ้าหนี้/ผู้ขาย', 'vendor_name')}
                  {field('เลขที่ใบแจ้งหนี้', 'invoice_no')}
                  {field('วันที่บิล', 'invoice_date', { type: 'date' })}
                  {field('ครบกำหนด', 'due_date', { type: 'date' })}
                  {field('จำนวนเงิน (รวม VAT)', 'amount', { type: 'number', step: '0.01' })}
                  <div className="grid gap-2">
                    <Label htmlFor="vat_treatment">ภาษี</Label>
                    <select id="vat_treatment" className="h-9 rounded-md border bg-transparent px-3 text-sm" value={apForm.vat_treatment} onChange={(e) => setApForm((f: any) => ({ ...f, vat_treatment: e.target.value }))}>
                      <option value="standard">VAT 7% (standard)</option>
                      <option value="exempt">ยกเว้น VAT</option>
                      <option value="zero">VAT 0%</option>
                    </select>
                  </div>
                </div>
                {apMsg && <Msg ok={apMsg.startsWith('✅')}>{apMsg}</Msg>}
                <DialogFooter>
                  <Button onClick={() => { setApMsg(''); apCreate.mutate(); }} disabled={apCreate.isPending || !apForm.amount}>บันทึก</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        }
      />
      <div className="space-y-6">
        {/* ── Executive overview band: KPIs + revenue trend + AR/AP aging composition ── */}
        <StateView q={kpi}>
          {kpi.data && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="รายได้ MTD" value={baht(kpi.data.mtd_revenue)} icon={Banknote} tone="primary" hint="รายได้เดือนนี้ (สะสม)" />
              <StatCard label="รายได้ YTD" value={baht(kpi.data.ytd_revenue)} icon={TrendingUp} tone="default" hint="รายได้ปีนี้ (สะสม)" />
              <StatCard label="ลูกหนี้คงค้าง (AR)" value={baht(kpi.data.ar_outstanding)} icon={ReceiptText} tone={kpi.data.ar_outstanding > 0 ? 'warning' : 'success'} hint="ยอดที่ต้องเรียกเก็บ" />
              <StatCard label="เจ้าหนี้คงค้าง (AP)" value={baht(kpi.data.ap_outstanding)} icon={Wallet} tone={kpi.data.ap_outstanding > 0 ? 'danger' : 'success'} hint="ยอดที่ต้องชำระ" />
            </div>
          )}
        </StateView>

        <div className="grid gap-4 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle className="text-base">แนวโน้มรายได้ (30 วัน)</CardTitle>
            </CardHeader>
            <CardContent>
              {trend.isLoading ? (
                <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">กำลังโหลด…</div>
              ) : trendData.length ? (
                <TrendAreaChart data={trendData} xKey="label" yKey="sales" fmt={(v) => baht(v)} />
              ) : (
                <div className="grid h-[260px] place-items-center text-sm text-muted-foreground">ยังไม่มีข้อมูลรายได้</div>
              )}
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">อายุหนี้คงค้าง (AR เทียบ AP)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {arAging.isLoading || apAging.isLoading ? (
                <div className="grid h-[200px] place-items-center text-sm text-muted-foreground">กำลังโหลด…</div>
              ) : (
                <>
                  <AgingStack label="ลูกหนี้ (AR)" total={arAging.data?.total ?? 0} buckets={arAging.data?.buckets} />
                  <AgingStack label="เจ้าหนี้ (AP)" total={apAging.data?.total ?? 0} buckets={apAging.data?.buckets} />
                  <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
                    {AGING_BUCKETS.map((b) => (
                      <span key={b.k} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className={`size-2.5 rounded-sm ${b.cls}`} /> {b.l}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">ลูกหนี้ (AR)</h3>
          <StateView q={ar}>
            {ar.data && (
              <DataTable
                rows={ar.data.invoices}
                columns={[
                  { key: 'Invoice_No', label: 'เลขที่' },
                  { key: 'Customer_Name', label: 'ลูกค้า' },
                  { key: 'Due_Date', label: 'ครบกำหนด', render: (r: any) => thaiDate(r.Due_Date) },
                  { key: 'Amount', label: 'ยอด', align: 'right', render: (r: any) => <span className="tabular">{baht(r.Amount)}</span> },
                  { key: 'Outstanding_Amount', label: 'คงค้าง', align: 'right', render: (r: any) => <span className="tabular">{baht(r.Outstanding_Amount)}</span> },
                  { key: 'Status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
                  { key: 'act', label: '', sortable: false, render: (r: any) => (
                    <Button variant="ghost" size="sm" onClick={() => { setArForm({ invoice_no: r.Invoice_No, amount: String(r.Outstanding_Amount), method: 'Transfer', ref_no: '' }); setArMsg(''); setArOpen(true); }}>รับชำระ</Button>
                  ) },
                ]}
              />
            )}
          </StateView>
        </div>

        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">เจ้าหนี้ (AP)</h3>
          <StateView q={ap}>
            {ap.data && (
              <DataTable
                rows={ap.data.transactions}
                columns={[
                  { key: 'Transaction_ID', label: 'เลขที่' },
                  { key: 'Creditor_Name', label: 'เจ้าหนี้' },
                  { key: 'Due_Date', label: 'ครบกำหนด', render: (r: any) => thaiDate(r.Due_Date) },
                  { key: 'Amount', label: 'ยอด', align: 'right', render: (r: any) => <span className="tabular">{baht(r.Amount)}</span> },
                  { key: 'Outstanding_Amount', label: 'คงค้าง', align: 'right', render: (r: any) => <span className="tabular">{baht(r.Outstanding_Amount)}</span> },
                  { key: 'Status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
                  { key: 'act', label: '', sortable: false, render: (r: any) => (
                    <Button variant="ghost" size="sm" onClick={() => { setPayTxn(r.Transaction_ID); setPayAmt(String(r.Outstanding_Amount)); setPayMsg(''); }}>จ่าย</Button>
                  ) },
                ]}
              />
            )}
          </StateView>
        </div>

        {/* AP payments awaiting approval (maker-checker) — only shown to users with approval authority */}
        {pendingPay.data && (
          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">คำขอจ่ายรออนุมัติ (Maker-Checker)</h3>
            {apprMsg && <div className="mb-2"><Msg ok={apprMsg.startsWith('✅')}>{apprMsg}</Msg></div>}
            <DataTable
              rows={pendingPay.data.payments}
              columns={[
                { key: 'payment_no', label: 'เลขที่คำขอ' },
                { key: 'txn_no', label: 'บิล AP' },
                { key: 'vendor_name', label: 'เจ้าหนี้' },
                { key: 'requested_by', label: 'ผู้ขอจ่าย' },
                { key: 'amount', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'act', label: '', sortable: false, render: (r: any) => {
                  const busy = (approvePay.isPending && approvePay.variables === r.payment_no) || (rejectPay.isPending && rejectPay.variables === r.payment_no);
                  return (
                    <div className="flex gap-1">
                      <Button size="sm" disabled={busy} onClick={() => { setApprMsg(''); approvePay.mutate(r.payment_no); }}>อนุมัติ</Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => { setApprMsg(''); rejectPay.mutate(r.payment_no); }}>ปฏิเสธ</Button>
                    </div>
                  );
                } },
              ]}
              emptyText="ไม่มีคำขอจ่ายรออนุมัติ"
            />
          </div>
        )}

        <CollectionsSection />

        <AgingSection />
      </div>

      {/* AP pay-request dialog — submits a request that a different user must approve (maker-checker) */}
      <Dialog open={!!payTxn} onOpenChange={(o) => { if (!o) { setPayTxn(null); setPayMsg(''); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>ขอจ่ายเจ้าหนี้ {payTxn}</DialogTitle></DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="payAmt">จำนวนเงิน</Label>
            <Input id="payAmt" type="number" step="0.01" value={payAmt} onChange={(e) => setPayAmt(e.target.value)} />
            <p className="text-xs text-muted-foreground">คำขอจ่ายต้องได้รับการอนุมัติจากผู้มีสิทธิ์อีกคน (แบ่งแยกหน้าที่) ก่อนตัดจ่ายจริง</p>
            {payMsg && <Msg ok={payMsg.startsWith('✅')}>{payMsg}</Msg>}
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">ยกเลิก</Button></DialogClose>
            <Button onClick={() => { setPayMsg(''); payAp.mutate(); }} disabled={payAp.isPending || !payAmt}>ส่งคำขอจ่าย</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── AR/AP aging buckets (Current / 1-30 / 31-60 / 61-90 / 90+) + AP-aging export ──
function AgingSection() {
  const arA = useQuery<any>({ queryKey: ['fin-ar-aging'], queryFn: () => api('/api/finance/ar/aging') });
  const apA = useQuery<any>({ queryKey: ['fin-ap-aging'], queryFn: () => api('/api/finance/ap/aging') });
  const [busy, setBusy] = useState(false);
  const B = [
    { k: 'current', l: 'ยังไม่ครบกำหนด' }, { k: 'd1_30', l: '1–30 วัน' }, { k: 'd31_60', l: '31–60 วัน' },
    { k: 'd61_90', l: '61–90 วัน' }, { k: 'd90_plus', l: '90+ วัน' },
  ];
  const row = (title: string, data: any) => data && (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{title} · รวมคงค้าง {baht(data.total)}</h3>
      <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
        {B.map((b, i) => <StatCard key={b.k} label={b.l} value={baht(data.buckets?.[b.k])} icon={CalendarClock} tone={i >= 3 ? 'danger' : i === 2 ? 'warning' : 'default'} />)}
      </div>
    </div>
  );
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">วิเคราะห์อายุหนี้ (Aging)</h2>
        <Button variant="outline" size="sm" disabled={busy} onClick={async () => { setBusy(true); try { await apiDownload('/api/reports/ap-aging/export', 'ap-aging.xlsx'); } finally { setBusy(false); } }}>
          <Download className="size-4" /> ส่งออก AP Aging (Excel)
        </Button>
      </div>
      <StateView q={arA}>{row('อายุลูกหนี้ (AR)', arA.data)}</StateView>
      <StateView q={apA}>{row('อายุเจ้าหนี้ (AP)', apA.data)}</StateView>
    </div>
  );
}

// ── AR collections worklist: aging + dunning stage + record action + automated sweep ──
const DUNNING_STAGES = ['reminder', 'first_notice', 'second_notice', 'final_notice', 'legal'] as const;
const STAGE_LABEL: Record<string, string> = {
  reminder: 'เตือนความจำ', first_notice: 'แจ้งเตือนครั้งที่ 1', second_notice: 'แจ้งเตือนครั้งที่ 2',
  final_notice: 'แจ้งเตือนครั้งสุดท้าย', legal: 'ดำเนินคดี',
};
const stageBadge = (stage: string | null): 'secondary' | 'warning' | 'destructive' =>
  stage === 'legal' || stage === 'final_notice' ? 'destructive' : stage === 'second_notice' ? 'warning' : 'secondary';

function CollectionsSection() {
  const qc = useQueryClient();
  const wl = useQuery<any>({ queryKey: ['ar-collections'], queryFn: () => api('/api/finance/ar/collections?overdue_only=1') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['ar-collections'] });

  const [dun, setDun] = useState<any | null>(null); // the worklist row being dunned
  const [form, setForm] = useState<any>({ stage: 'reminder', channel: 'email', promise_to_pay_date: '', notes: '' });
  const [msg, setMsg] = useState('');
  const record = useMutation({
    mutationFn: () => api(`/api/finance/ar/collections/${dun.invoice_no}/dunning`, {
      method: 'POST',
      body: JSON.stringify({ stage: form.stage, channel: form.channel, promise_to_pay_date: form.promise_to_pay_date || undefined, notes: form.notes || undefined }),
    }),
    onSuccess: (r: any) => {
      const note = r.message_status === 'sent' ? ` — ส่งแจ้งเตือนแล้ว (${r.recipient ?? r.channel})`
        : r.message_status === 'manual' ? ` — บันทึกการติดต่อ (${r.channel})`
        : r.message_status === 'failed' ? ' — แต่ส่งแจ้งเตือนไม่สำเร็จ (ไม่มีช่องทางติดต่อ)' : '';
      setMsg(`✅ บันทึกการทวงถาม ${r.dunning_no}${note}`); refresh(); setDun(null);
    },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  const [sweepMsg, setSweepMsg] = useState('');
  const sweep = useMutation({
    mutationFn: () => api('/api/finance/ar/collections/sweep', { method: 'POST' }),
    onSuccess: (r: any) => { setSweepMsg(`✅ รันการทวงถามอัตโนมัติ: เลื่อนขั้น ${r.advanced} จาก ${r.scanned} รายการ`); refresh(); },
    onError: (e: any) => setSweepMsg(`❌ ${e.message}`),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">ติดตามหนี้ค้างชำระ (Collections)</h2>
        <Button variant="outline" size="sm" disabled={sweep.isPending} onClick={() => { setSweepMsg(''); sweep.mutate(); }}>
          <PlayCircle className={`size-4 ${sweep.isPending ? 'animate-spin' : ''}`} /> ทวงถามอัตโนมัติ
        </Button>
      </div>
      {sweepMsg && <Msg ok={sweepMsg.startsWith('✅')}>{sweepMsg}</Msg>}
      <StateView q={wl}>
        {wl.data && (
          <DataTable
            rows={wl.data.rows}
            columns={[
              { key: 'invoice_no', label: 'ใบแจ้งหนี้' },
              { key: 'party', label: 'ลูกค้า' },
              { key: 'outstanding', label: 'คงค้าง', align: 'right', render: (r: any) => <span className="tabular">{baht(r.outstanding)}</span> },
              { key: 'days_overdue', label: 'เกินกำหนด (วัน)', align: 'right', render: (r: any) => <span className={`tabular ${r.days_overdue > 90 ? 'text-red-600' : ''}`}>{r.days_overdue}</span> },
              { key: 'current_stage', label: 'ขั้นปัจจุบัน', render: (r: any) => r.current_stage ? <Badge variant={stageBadge(r.current_stage)}>{STAGE_LABEL[r.current_stage]}</Badge> : <span className="text-muted-foreground">—</span> },
              { key: 'recommended_stage', label: 'แนะนำ', render: (r: any) => r.recommended_stage ? <Badge variant={r.escalate ? 'destructive' : 'outline'}>{STAGE_LABEL[r.recommended_stage]}</Badge> : <span className="text-muted-foreground">—</span> },
              { key: 'act', label: '', sortable: false, render: (r: any) => (
                <Button variant="ghost" size="sm" onClick={() => { setForm({ stage: r.recommended_stage ?? 'reminder', channel: 'email', promise_to_pay_date: '', notes: '' }); setMsg(''); setDun(r); }}>
                  <BellRing className="size-4" /> ทวงถาม
                </Button>
              ) },
            ]}
          />
        )}
      </StateView>

      {/* Record-dunning dialog */}
      <Dialog open={!!dun} onOpenChange={(o) => { if (!o) { setDun(null); setMsg(''); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>บันทึกการทวงถาม {dun?.invoice_no}</DialogTitle></DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="dun-stage">ขั้นการทวงถาม</Label>
              <select id="dun-stage" className="h-9 rounded-md border bg-transparent px-3 text-sm" value={form.stage} onChange={(e) => setForm((f: any) => ({ ...f, stage: e.target.value }))}>
                {DUNNING_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="dun-channel">ช่องทาง</Label>
              <select id="dun-channel" className="h-9 rounded-md border bg-transparent px-3 text-sm" value={form.channel} onChange={(e) => setForm((f: any) => ({ ...f, channel: e.target.value }))}>
                <option value="email">อีเมล</option><option value="phone">โทรศัพท์</option><option value="letter">จดหมาย</option><option value="sms">SMS</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="dun-ptp">นัดชำระ (ถ้ามี)</Label>
              <Input id="dun-ptp" type="date" value={form.promise_to_pay_date} onChange={(e) => setForm((f: any) => ({ ...f, promise_to_pay_date: e.target.value }))} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="dun-notes">บันทึก</Label>
              <Input id="dun-notes" value={form.notes} onChange={(e) => setForm((f: any) => ({ ...f, notes: e.target.value }))} />
            </div>
            {msg && <Msg ok={msg.startsWith('✅')}>{msg}</Msg>}
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">ยกเลิก</Button></DialogClose>
            <Button onClick={() => { setMsg(''); record.mutate(); }} disabled={record.isPending}>บันทึก</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
