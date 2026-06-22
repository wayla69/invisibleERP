'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Banknote, HandCoins, Plus, ReceiptText, RefreshCw, TrendingUp, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose,
} from '@/components/ui/dialog';
import { statusVariant } from '@/components/ui';
import { Msg } from '@/components/tabs';

export default function FinancePage() {
  const qc = useQueryClient();
  const kpi = useQuery<any>({ queryKey: ['fin-kpi'], queryFn: () => api('/api/finance/kpi') });
  const ar = useQuery<any>({ queryKey: ['fin-ar'], queryFn: () => api('/api/finance/ar?limit=50') });
  const ap = useQuery<any>({ queryKey: ['fin-ap'], queryFn: () => api('/api/finance/ap?status=Unpaid&limit=50') });

  const refresh = () => { qc.invalidateQueries({ queryKey: ['fin-kpi'] }); qc.invalidateQueries({ queryKey: ['fin-ar'] }); qc.invalidateQueries({ queryKey: ['fin-ap'] }); };

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

  // ── AP pay (per row) ──
  const [payTxn, setPayTxn] = useState<string | null>(null);
  const [payAmt, setPayAmt] = useState('');
  const [payMsg, setPayMsg] = useState('');
  const payAp = useMutation({
    mutationFn: () => api(`/api/finance/ap/transactions/${payTxn}/pay`, { method: 'PATCH', body: JSON.stringify({ amount: Number(payAmt) }) }),
    onSuccess: (r: any) => { setPayMsg(`✅ จ่าย ${r.txn_no} — สถานะ ${r.status}`); refresh(); setPayTxn(null); setPayAmt(''); },
    onError: (e: any) => setPayMsg(`❌ ${e.message}`),
  });

  const field = (label: string, key: string, props: any = {}, form = apForm, set = setApForm) => (
    <div className="grid gap-2">
      <Label htmlFor={key}>{label}</Label>
      <Input id={key} value={form[key] ?? ''} onChange={(e) => set((f: any) => ({ ...f, [key]: e.target.value }))} {...props} />
    </div>
  );

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
        <StateView q={kpi}>
          {kpi.data && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="รายได้ MTD" value={baht(kpi.data.mtd_revenue)} icon={Banknote} tone="primary" />
              <StatCard label="รายได้ YTD" value={baht(kpi.data.ytd_revenue)} icon={TrendingUp} tone="default" />
              <StatCard label="ลูกหนี้คงค้าง (AR)" value={baht(kpi.data.ar_outstanding)} icon={ReceiptText} tone={kpi.data.ar_outstanding > 0 ? 'warning' : 'success'} />
              <StatCard label="เจ้าหนี้คงค้าง (AP)" value={baht(kpi.data.ap_outstanding)} icon={Wallet} tone={kpi.data.ap_outstanding > 0 ? 'danger' : 'success'} />
            </div>
          )}
        </StateView>

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
      </div>

      {/* AP pay dialog */}
      <Dialog open={!!payTxn} onOpenChange={(o) => { if (!o) { setPayTxn(null); setPayMsg(''); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>จ่ายเจ้าหนี้ {payTxn}</DialogTitle></DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="payAmt">จำนวนเงิน</Label>
            <Input id="payAmt" type="number" step="0.01" value={payAmt} onChange={(e) => setPayAmt(e.target.value)} />
            {payMsg && <Msg ok={payMsg.startsWith('✅')}>{payMsg}</Msg>}
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">ยกเลิก</Button></DialogClose>
            <Button onClick={() => { setPayMsg(''); payAp.mutate(); }} disabled={payAp.isPending || !payAmt}>ยืนยันจ่าย</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
