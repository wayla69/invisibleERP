'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { CheckCheck, FileScan, ListChecks, Loader2, ScanLine, Send, ShieldAlert, ShieldCheck, Link2 } from 'lucide-react';
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

type Candidate = { po_no: string; vendor_name: string | null; total_amount: number; score: number };
type Intake = {
  intake_no: string; status: string; extract_source: string | null;
  vendor_name: string | null; vendor_tax_id: string | null; invoice_no: string | null; invoice_date: string | null;
  amount: number | null; currency: string | null; po_no: string | null; map_method: string | null;
  map_confidence: number; candidates: Candidate[]; dup_of: string | null;
  txn_no: string | null; match_status: string | null; payable: boolean | null; auto_posted?: boolean;
};

const statusVariant = (s: string) => (s === 'Posted' ? 'success' : s === 'Mapped' ? 'info' : 'warning');
const matchVariant = (s: string | null) => (s === 'matched' ? 'success' : s == null ? 'muted' : 'destructive');

// AP invoice intake (EXP-10): scan/paste a vendor invoice → auto-extract → auto-map to the PO →
// post the bill + run the 3-way match in one step. Payment stays behind the AP-PAY maker-checker.
export default function ApIntakePage() {
  return (
    <div>
      <PageHeader
        title="สแกนใบแจ้งหนี้จับคู่ PO (AP Intake)"
        description="วางข้อความใบแจ้งหนี้ผู้ขาย ระบบดึงข้อมูล จับคู่ PO อัตโนมัติ บันทึกบิล และรันจับคู่ 3 ทางให้พร้อมจ่าย — การจ่ายเงินยังต้องขอ/อนุมัติแยกตามปกติ (EXP-06)"
      />
      <Tabs
        tabs={[
          { key: 'scan', label: 'สแกน / รับเข้า', content: <ScanTab /> },
          { key: 'worklist', label: 'รายการรอตรวจ / ประวัติ', content: <WorklistTab /> },
        ]}
      />
    </div>
  );
}

function ScanTab() {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [res, setRes] = useState<Intake | null>(null);

  const done = (r: Intake, msg: string) => {
    setRes(r);
    notifySuccess(`${msg} · ${r.intake_no}`);
    qc.invalidateQueries({ queryKey: ['ap-intake-list'] });
  };
  const scan = useMutation({
    mutationFn: () => api<Intake>('/api/procurement/ap-intake', { method: 'POST', body: JSON.stringify({ text }) }),
    onSuccess: (r) => done(r, r.po_no ? `จับคู่ ${r.po_no} แล้ว` : 'รอตรวจสอบ'),
    onError: (e) => notifyError((e as Error).message),
  });
  const auto = useMutation({
    mutationFn: () => api<Intake>('/api/procurement/ap-intake/auto', { method: 'POST', body: JSON.stringify({ text }) }),
    onSuccess: (r) => done(r, r.auto_posted ? `บันทึกบิล ${r.txn_no} + จับคู่แล้ว` : 'ยังไม่บันทึก — รอตรวจสอบ'),
    onError: (e) => notifyError((e as Error).message),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="gap-4">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ScanLine className="size-4 text-primary" /> ข้อความใบแจ้งหนี้ (จากสแกน/OCR)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <textarea className="min-h-56 w-full rounded-md border bg-transparent p-3 text-sm" placeholder="วางข้อความใบแจ้งหนี้ที่นี่…" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={scan.isPending || !text.trim()} onClick={() => scan.mutate()}>
              {scan.isPending ? <Loader2 className="size-4 animate-spin" /> : <FileScan className="size-4" />} ดึงข้อมูล + จับคู่ PO
            </Button>
            <Button disabled={auto.isPending || !text.trim()} onClick={() => auto.mutate()}>
              {auto.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} อัตโนมัติทั้งหมด (บันทึกบิล + จับคู่ 3 ทาง)
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">"อัตโนมัติทั้งหมด" ต้องมีสิทธิ์เจ้าหนี้ (creditors) และจะบันทึกเฉพาะเอกสารที่จับคู่ได้ชัดเจนและไม่ซ้ำเท่านั้น</p>
        </CardContent>
      </Card>
      {res ? <IntakeDetail intake={res} onChanged={setRes} /> : (
        <Card><CardHeader><CardTitle className="text-base">ผลการรับเข้า</CardTitle></CardHeader>
          <CardContent><p className="text-sm text-muted-foreground">สแกนเอกสารแล้วผลจะแสดงที่นี่</p></CardContent></Card>
      )}
    </div>
  );
}

function IntakeDetail({ intake: r, onChanged }: { intake: Intake; onChanged: (r: Intake) => void }) {
  const qc = useQueryClient();
  const [manualPo, setManualPo] = useState('');
  const refresh = (x: Intake) => { onChanged(x); qc.invalidateQueries({ queryKey: ['ap-intake-list'] }); };

  const mapPo = useMutation({
    mutationFn: (po: string) => api<Intake>(`/api/procurement/ap-intake/${encodeURIComponent(r.intake_no)}/map`, { method: 'PUT', body: JSON.stringify({ po_no: po }) }),
    onSuccess: (x) => { refresh(x); notifySuccess(`จับคู่ ${x.po_no} แล้ว`); },
    onError: (e) => notifyError((e as Error).message),
  });
  const post = useMutation({
    mutationFn: () => api<Intake>(`/api/procurement/ap-intake/${encodeURIComponent(r.intake_no)}/post`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (x) => { refresh(x); notifySuccess(`บันทึกบิล ${x.txn_no} แล้ว`); },
    onError: (e) => notifyError((e as Error).message),
  });

  const rows: [string, any][] = [
    ['สถานะ', <Badge key="s" variant={statusVariant(r.status)}>{r.status}</Badge>],
    ['ผู้ขาย', r.vendor_name], ['เลขผู้เสียภาษี', r.vendor_tax_id],
    ['เลขที่ใบแจ้งหนี้', r.invoice_no], ['วันที่', r.invoice_date],
    ['จำนวนเงิน', r.amount != null ? num(r.amount) : null],
    ['PO ที่จับคู่', r.po_no ? `${r.po_no} (${r.map_method}, ${num(r.map_confidence)}%)` : null],
    ['บิล (AP)', r.txn_no],
    ['ผลจับคู่ 3 ทาง', r.match_status ? <Badge key="m" variant={matchVariant(r.match_status)}>{r.match_status}</Badge> : null],
    ['พร้อมจ่าย', r.payable == null ? null : <Badge key="p" variant={r.payable ? 'success' : 'destructive'}>{r.payable ? 'พร้อมจ่าย' : 'ระงับ'}</Badge>],
  ];

  return (
    <Card className="gap-4">
      <CardHeader><CardTitle className="text-base">ผลการรับเข้า {r.intake_no} <span className="ml-1 text-xs text-muted-foreground">({r.extract_source})</span></CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {r.dup_of && (
          <p className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
            <ShieldAlert className="size-4 shrink-0" /> อาจซ้ำกับ {r.dup_of} — ระบบไม่บันทึกอัตโนมัติ
          </p>
        )}
        <table className="w-full text-sm"><tbody>
          {rows.map(([k, v]) => <tr key={k as string} className="border-b"><td className="px-2 py-1 text-muted-foreground">{k}</td><td className="px-2 py-1 text-right">{v == null || v === '' ? '—' : v}</td></tr>)}
        </tbody></table>

        {r.status !== 'Posted' && r.candidates.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">PO ที่ใกล้เคียง — เลือกเพื่อจับคู่</p>
            {r.candidates.map((c) => (
              <button key={c.po_no} className="flex w-full items-center justify-between rounded-md border p-2 text-sm hover:bg-accent" onClick={() => mapPo.mutate(c.po_no)} disabled={mapPo.isPending}>
                <span className="flex items-center gap-2"><Link2 className="size-4 text-primary" /> {c.po_no} · {c.vendor_name ?? '—'}</span>
                <span className="text-muted-foreground">{num(c.total_amount)} · คะแนน {c.score}</span>
              </button>
            ))}
          </div>
        )}

        {r.status !== 'Posted' && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor="ai-po">ระบุเลข PO เอง</Label>
              <Input id="ai-po" className="w-44" value={manualPo} onChange={(e) => setManualPo(e.target.value)} placeholder="PO-20260701-001" />
            </div>
            <Button variant="outline" disabled={mapPo.isPending || !manualPo.trim()} onClick={() => mapPo.mutate(manualPo.trim())}><Link2 className="size-4" /> จับคู่</Button>
            <Button disabled={post.isPending} onClick={() => post.mutate()}>
              <CheckCheck className="size-4" /> {post.isPending ? 'กำลังบันทึก…' : r.po_no ? 'บันทึกบิล + จับคู่ 3 ทาง' : 'บันทึกบิล (ไม่มี PO)'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WorklistTab() {
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<Intake | null>(null);
  const q = useQuery<{ intakes: Intake[]; count: number }>({
    queryKey: ['ap-intake-list', status],
    queryFn: () => api(`/api/procurement/ap-intake?limit=200${status ? `&status=${status}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const counts = (s: string) => (d?.intakes ?? []).filter((i) => i.status === s).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {['', 'NeedsReview', 'Mapped', 'Posted'].map((s) => (
          <Button key={s || 'all'} variant={status === s ? 'default' : 'outline'} onClick={() => setStatus(s)}>{s === '' ? 'ทั้งหมด' : s}</Button>
        ))}
      </div>
      <StateView q={q}>
        {d && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatCard label="รอตรวจสอบ" value={num(counts('NeedsReview'))} icon={ShieldAlert} tone={counts('NeedsReview') > 0 ? 'warning' : 'success'} />
              <StatCard label="จับคู่แล้วรอบันทึก" value={num(counts('Mapped'))} icon={Link2} tone="info" />
              <StatCard label="บันทึกบิลแล้ว" value={num(counts('Posted'))} icon={ShieldCheck} tone="primary" />
            </div>
            <DataTable
              rows={d.intakes}
              rowKey={(r: Intake) => r.intake_no}
              onRowClick={(r: Intake) => setSelected(r)}
              emptyState={{ icon: ListChecks, title: 'ยังไม่มีเอกสารรับเข้า', description: 'สแกนใบแจ้งหนี้ที่แท็บ "สแกน / รับเข้า"' }}
              columns={[
                { key: 'intake_no', label: 'เลขรับเข้า', render: (r: Intake) => <span className="font-medium">{r.intake_no}</span> },
                { key: 'vendor_name', label: 'ผู้ขาย', render: (r: Intake) => r.vendor_name ?? '—' },
                { key: 'invoice_no', label: 'ใบแจ้งหนี้', render: (r: Intake) => r.invoice_no ?? '—' },
                { key: 'amount', label: 'จำนวนเงิน', align: 'right', render: (r: Intake) => <span className="tabular">{r.amount != null ? num(r.amount) : '—'}</span> },
                { key: 'po_no', label: 'PO', render: (r: Intake) => r.po_no ?? '—' },
                { key: 'status', label: 'สถานะ', render: (r: Intake) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                { key: 'match_status', label: 'ผลจับคู่', render: (r: Intake) => r.match_status ? <Badge variant={matchVariant(r.match_status)}>{r.match_status}</Badge> : '—' },
                { key: 'txn_no', label: 'บิล (AP)', render: (r: Intake) => r.txn_no ?? '—' },
              ]}
            />
          </>
        )}
      </StateView>
      {selected && <IntakeDetail intake={selected} onChanged={setSelected} />}
    </div>
  );
}
