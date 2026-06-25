'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { CheckCheck, ListChecks, ShieldAlert, ShieldCheck, Save, Search, Unlock } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const lineStatusVariant = (s: string) =>
  s === 'matched'
    ? 'success'
    : s === 'price_variance' || s === 'qty_variance'
    ? 'warning'
    : s === 'over_invoiced' || s === 'unmatched'
    ? 'destructive'
    : 'secondary';

const pct = (v: unknown) => `${Number(v ?? 0).toLocaleString('en-US', { maximumFractionDigits: 3 })}%`;

export default function MatchPage() {
  return (
    <div>
      <PageHeader
        title="จับคู่เอกสาร 3 ทาง (3-Way Match)"
        description="กระทบใบแจ้งหนี้ (AP) กับ PO (ราคา) และใบรับ (จำนวน) ภายในเกณฑ์ที่กำหนด เพื่อปลดล็อกการจ่ายเงิน"
      />
      <Tabs
        tabs={[
          { key: 'run', label: 'รันการจับคู่ + ผลลัพธ์', content: <RunMatchTab /> },
          { key: 'worklist', label: 'รายการ / ใบที่ถูกระงับ', content: <WorklistTab /> },
          { key: 'tolerance', label: 'เกณฑ์ความคลาดเคลื่อน', content: <ToleranceTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Worklist / blocked-invoice register ─────────────────────────
function WorklistTab() {
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(search), 300); return () => clearTimeout(t); }, [search]);

  const q = useQuery<any>({
    queryKey: ['match-worklist', blockedOnly, debounced],
    queryFn: () => api(`/api/procurement/match?limit=200${blockedOnly ? '&blocked=true' : ''}${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8 sm:w-72" placeholder="ค้นหา เลขที่บิล / PO…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="ค้นหาผลการจับคู่" />
        </div>
        <Button variant={blockedOnly ? 'default' : 'outline'} aria-pressed={blockedOnly} onClick={() => setBlockedOnly((v) => !v)}>
          <ShieldAlert className="size-4" /> เฉพาะใบที่ถูกระงับ
        </Button>
        {q.isFetching && !q.isLoading && <span className="text-xs text-muted-foreground">กำลังอัปเดต…</span>}
      </div>
      <StateView q={q}>
        {d && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatCard label="ผลการจับคู่ทั้งหมด" value={num(d.total)} icon={ListChecks} tone="primary" />
              <StatCard label="ถูกระงับการจ่าย" value={num(d.blocked)} icon={ShieldAlert} tone={d.blocked > 0 ? 'danger' : 'success'} hint="ไม่ผ่าน + ยังไม่ override" />
              <StatCard label="ใช้สิทธิ์ทับ (override)" value={num(d.overridden)} icon={Unlock} tone={d.overridden > 0 ? 'warning' : 'default'} />
            </div>
            <DataTable
              rows={d.results}
              rowKey={(r: any) => r.txn_no}
              emptyState={{
                icon: ListChecks,
                title: blockedOnly ? 'ไม่มีใบที่ถูกระงับ' : 'ยังไม่มีผลการจับคู่',
                description: blockedOnly ? 'ทุกใบแจ้งหนี้ที่จับคู่ผ่านหรือถูก override แล้ว' : 'รันการจับคู่ที่แท็บ "รันการจับคู่" แล้วผลจะแสดงที่นี่',
              }}
              columns={[
                { key: 'txn_no', label: 'เลขที่บิล (AP)', render: (r: any) => <span className="font-medium">{r.txn_no}</span> },
                { key: 'po_no', label: 'PO', render: (r: any) => r.po_no ?? '—' },
                { key: 'match_status', label: 'ผลจับคู่', render: (r: any) => <Badge variant={lineStatusVariant(r.match_status)}>{r.match_status}</Badge> },
                { key: 'state', label: 'สถานะจ่าย', render: (r: any) => (r.override ? <Badge variant="warning">ใช้สิทธิ์ทับ</Badge> : r.payable ? <Badge variant="success">จ่ายได้</Badge> : <Badge variant="destructive">ระงับ</Badge>) },
                { key: 'matched_by', label: 'จับคู่โดย', render: (r: any) => r.matched_by ?? '—' },
              ]}
            />
          </>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── Run + result ─────────────────────────
function RunMatchTab() {
  const qc = useQueryClient();
  const [txnNo, setTxnNo] = useState('');
  const [poNo, setPoNo] = useState('');
  const [lookup, setLookup] = useState('');
  const [overrideReason, setOverrideReason] = useState('');

  const result = useQuery<any>({
    queryKey: ['match', lookup],
    queryFn: () => api(`/api/procurement/match/${encodeURIComponent(lookup)}`),
    enabled: !!lookup,
    retry: false,
  });

  const run = useMutation({
    mutationFn: () =>
      api<{ match_no: string; txn_no: string }>('/api/procurement/match/run', {
        method: 'POST',
        body: JSON.stringify({ txn_no: txnNo, po_no: poNo || undefined }),
      }),
    onSuccess: (r) => {
      notifySuccess(`${r.match_no} · ${r.txn_no}`);
      setLookup(r.txn_no);
      qc.invalidateQueries({ queryKey: ['match', r.txn_no] });
    },
    onError: (e) => notifyError((e as Error).message),
  });

  const override = useMutation({
    mutationFn: () =>
      api<{ txn_no: string }>(`/api/procurement/match/${encodeURIComponent(lookup)}/override`, {
        method: 'POST',
        body: JSON.stringify({ reason: overrideReason }),
      }),
    onSuccess: () => {
      notifySuccess('อนุมัติทับแล้ว — จ่ายเงินได้');
      setOverrideReason('');
      qc.invalidateQueries({ queryKey: ['match', lookup] });
    },
    onError: (e) => notifyError((e as Error).message),
  });

  const m = result.data;
  const lines: any[] = m?.lines ?? [];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="text-base">รันการจับคู่</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="m-txn">เลขใบแจ้งหนี้ (AP txn)</Label>
                <Input id="m-txn" value={txnNo} onChange={(e) => setTxnNo(e.target.value)} placeholder="AP-0001" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="m-po">เลข PO</Label>
                <Input id="m-po" value={poNo} onChange={(e) => setPoNo(e.target.value)} placeholder="PO-0001" />
              </div>
            </div>
            <Button disabled={run.isPending || !txnNo} onClick={() => run.mutate()}>
              <CheckCheck className="size-4" /> {run.isPending ? 'กำลังจับคู่…' : 'รันการจับคู่'}
            </Button>
          </CardContent>
        </Card>

        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="text-base">ค้นหาผลการจับคู่</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="m-lookup">เลขใบแจ้งหนี้</Label>
              <div className="flex gap-2">
                <Input
                  id="m-lookup"
                  value={lookup}
                  onChange={(e) => setLookup(e.target.value)}
                  placeholder="AP-0001"
                  onKeyDown={(e) => e.key === 'Enter' && result.refetch()}
                />
                <Button variant="outline" onClick={() => result.refetch()} disabled={!lookup}>
                  <Search className="size-4" /> ค้นหา
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {lookup && (
        <StateView q={result}>
          {m && (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  label="สถานะการจับคู่"
                  value={<Badge variant={lineStatusVariant(m.match_status)}>{m.match_status}</Badge>}
                  icon={m.match_status === 'matched' ? ShieldCheck : ShieldAlert}
                  tone={m.match_status === 'matched' ? 'success' : 'warning'}
                />
                <StatCard
                  label="จ่ายได้"
                  value={<Badge variant={m.payable ? 'success' : 'destructive'}>{m.payable ? 'ปลดล็อก' : 'ระงับ'}</Badge>}
                  icon={m.payable ? ShieldCheck : ShieldAlert}
                  tone={m.payable ? 'success' : 'danger'}
                />
                <StatCard label="PO" value={m.po_no ?? '—'} tone="default" />
                <StatCard
                  label="Override"
                  value={<Badge variant={m.override ? 'warning' : 'muted'}>{m.override ? 'ใช้สิทธิ์ทับ' : 'ไม่มี'}</Badge>}
                  icon={Unlock}
                  tone={m.override ? 'warning' : 'default'}
                />
              </div>

              <DataTable
                rows={lines}
                rowKey={(_r, i) => i}
                columns={[
                  { key: 'item_id', label: 'รหัสสินค้า' },
                  { key: 'inv_qty', label: 'จำนวน(บิล)', align: 'right', render: (r: any) => <span className="tabular">{num(r.inv_qty)}</span> },
                  { key: 'gr_qty', label: 'รับจริง', align: 'right', render: (r: any) => <span className="tabular">{num(r.gr_qty)}</span> },
                  { key: 'inv_price', label: 'ราคา(บิล)', align: 'right', render: (r: any) => <span className="tabular">{num(r.inv_price)}</span> },
                  { key: 'po_price', label: 'ราคา PO', align: 'right', render: (r: any) => <span className="tabular">{num(r.po_price)}</span> },
                  { key: 'qty_var_pct', label: '%ต่างจำนวน', align: 'right', render: (r: any) => <span className="tabular">{pct(r.qty_var_pct)}</span> },
                  { key: 'price_var_pct', label: '%ต่างราคา', align: 'right', render: (r: any) => <span className="tabular">{pct(r.price_var_pct)}</span> },
                  { key: 'line_status', label: 'ผลลัพธ์', render: (r: any) => <Badge variant={lineStatusVariant(r.line_status)}>{r.line_status}</Badge> },
                ]}
                emptyState={{ icon: ListChecks, title: 'ไม่มีบรรทัดสำหรับจับคู่' }}
              />

              {!m.payable && !m.override && (
                <Card className="max-w-xl gap-4">
                  <CardHeader>
                    <CardTitle className="text-base">ใช้สิทธิ์อนุมัติทับ (Override)</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground">อนุมัติให้จ่ายได้ทั้งที่จับคู่ไม่ผ่าน — ต้องระบุเหตุผล</p>
                    <Input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="เหตุผลในการอนุมัติทับ" />
                    <Button variant="destructive" disabled={override.isPending || !overrideReason} onClick={() => override.mutate()}>
                      <Unlock className="size-4" /> {override.isPending ? 'กำลังบันทึก…' : 'อนุมัติทับ'}
                    </Button>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </StateView>
      )}
    </div>
  );
}

// ───────────────────────── Tolerance ─────────────────────────
function ToleranceTab() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['match-tolerance'], queryFn: () => api('/api/procurement/match/tolerance') });

  const [qtyPct, setQtyPct] = useState('');
  const [pricePct, setPricePct] = useState('');
  const [amountPct, setAmountPct] = useState('');
  const [amountAbs, setAmountAbs] = useState('');

  const save = useMutation({
    mutationFn: () =>
      api('/api/procurement/match/tolerance', {
        method: 'PUT',
        body: JSON.stringify({
          qty_pct: qtyPct !== '' ? Number(qtyPct) : undefined,
          price_pct: pricePct !== '' ? Number(pricePct) : undefined,
          amount_pct: amountPct !== '' ? Number(amountPct) : undefined,
          amount_abs: amountAbs !== '' ? Number(amountAbs) : undefined,
        }),
      }),
    onSuccess: () => {
      notifySuccess('บันทึกเกณฑ์แล้ว');
      setQtyPct(''); setPricePct(''); setAmountPct(''); setAmountAbs('');
      qc.invalidateQueries({ queryKey: ['match-tolerance'] });
    },
    onError: (e) => notifyError((e as Error).message),
  });

  const t = q.data;

  return (
    <div className="space-y-5">
      <StateView q={q}>
        {t && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="เกณฑ์จำนวน (%)" value={pct(t.qtyPct)} tone="info" />
            <StatCard label="เกณฑ์ราคา (%)" value={pct(t.pricePct)} tone="info" />
            <StatCard label="เกณฑ์ยอดรวม (%)" value={pct(t.amountPct)} tone="info" />
            <StatCard label="เกณฑ์ยอดรวม (บาท)" value={num(t.amountAbs)} tone="info" />
          </div>
        )}
      </StateView>

      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">ปรับเกณฑ์ความคลาดเคลื่อน</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">เว้นว่างเพื่อคงค่าเดิม</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="t-qty">เกณฑ์จำนวน (%)</Label>
              <Input id="t-qty" type="number" min="0" step="0.1" value={qtyPct} onChange={(e) => setQtyPct(e.target.value)} placeholder={String(t?.qtyPct ?? '')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="t-price">เกณฑ์ราคา (%)</Label>
              <Input id="t-price" type="number" min="0" step="0.1" value={pricePct} onChange={(e) => setPricePct(e.target.value)} placeholder={String(t?.pricePct ?? '')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="t-amt">เกณฑ์ยอดรวม (%)</Label>
              <Input id="t-amt" type="number" min="0" step="0.1" value={amountPct} onChange={(e) => setAmountPct(e.target.value)} placeholder={String(t?.amountPct ?? '')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="t-abs">เกณฑ์ยอดรวม (บาท)</Label>
              <Input id="t-abs" type="number" min="0" step="0.01" value={amountAbs} onChange={(e) => setAmountAbs(e.target.value)} placeholder={String(t?.amountAbs ?? '')} />
            </div>
          </div>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            <Save className="size-4" /> {save.isPending ? 'กำลังบันทึก…' : 'บันทึกเกณฑ์'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
