'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Scale, ListChecks, ShieldCheck, X, Download, Link2, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { notifySuccess, notifyError } from '@/lib/notify';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

export default function ReconciliationPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const q = useQuery<any>({ queryKey: ['recon-periods'], queryFn: () => api('/api/recon/periods') });

  return (
    <ModulePage
      title="กระทบยอด (Reconciliation)"
      description="เปิดงวดกระทบยอดตามบัญชี นำเข้ารายการ GL จับคู่อัตโนมัติ และรับรอง (SoD)"
    >
      <div className="space-y-6">
        <ControlAccountPack />
        <PendingApprovalsMonitor />
        <OpenPeriod onDone={() => qc.invalidateQueries({ queryKey: ['recon-periods'] })} />

        <StateView q={q}>
          {q.data && (
            <div className="space-y-5">
              <StatCard label="จำนวนงวดกระทบยอด" value={num(q.data.count)} icon={Scale} tone="primary" className="max-w-xs" />
              <DataTable
                rows={q.data.periods}
                onRowClick={(r: any) => setSelected(r.id)}
                columns={[
                  { key: 'period', label: 'งวด' },
                  { key: 'account_code', label: 'บัญชี' },
                  { key: 'gl_balance', label: 'ยอด GL', align: 'right', render: (r: any) => <span className="tabular">{baht(r.gl_balance)}</span> },
                  { key: 'subledger_balance', label: 'ยอด Subledger', align: 'right', render: (r: any) => <span className="tabular">{baht(r.subledger_balance)}</span> },
                  { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                  { key: 'prepared_by', label: 'ผู้จัดทำ', render: (r: any) => r.prepared_by ?? '—' },
                  { key: 'certified_by', label: 'ผู้รับรอง', render: (r: any) => r.certified_by ?? '—' },
                ]}
                emptyState={{
                  icon: Scale,
                  title: 'ยังไม่มีงวดกระทบยอด',
                  description: 'เปิดงวดกระทบยอดตามบัญชีและงวดด้านบนเพื่อเริ่มต้น',
                }}
              />
            </div>
          )}
        </StateView>

        {selected != null && <PeriodDetail id={selected} onClose={() => setSelected(null)} />}
      </div>
    </ModulePage>
  );
}

// ────────── REC-04 control-account reconciliation pack (sub-ledger ↔ GL, period-end overview) ──────────
function ControlAccountPack() {
  const q = useQuery<any>({ queryKey: ['recon-controls'], queryFn: () => api('/api/finance/reconciliation/controls') });
  const d = q.data;
  return (
    <Card className="gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck className="size-4 text-muted-foreground" /> ภาพรวมบัญชีคุมยอด ↔ บัญชีแยกประเภท (Control accounts)</h3>
        {d && (
          d.all_reconciled
            ? <Badge variant="success">กระทบยอดครบทุกบัญชี ✓</Badge>
            : <Badge variant="destructive">{num(d.exceptions)} บัญชีไม่ตรง — ต้องตรวจสอบ</Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">เทียบยอดบัญชีย่อย (sub-ledger) กับบัญชีคุมยอดใน GL ทุกบัญชีหลักในคราวเดียว — ใช้ก่อนปิดงวด/รับรอง (REC-04)</p>
      <StateView q={q}>
        {d && (
          <DataTable
            rows={d.lines}
            rowKey={(r: any) => r.account}
            columns={[
              { key: 'account', label: 'บัญชี', render: (r: any) => <span className="font-mono text-sm">{r.account}</span> },
              { key: 'label', label: 'รายการ' },
              { key: 'sub_ledger', label: 'ยอดบัญชีย่อย', align: 'right', render: (r: any) => <span className="tabular">{baht(r.sub_ledger)}</span> },
              { key: 'gl_control', label: 'ยอด GL คุมยอด', align: 'right', render: (r: any) => <span className="tabular">{baht(r.gl_control)}</span> },
              { key: 'variance', label: 'ส่วนต่าง', align: 'right', render: (r: any) => <span className={`tabular ${Math.abs(r.variance) >= 0.01 ? 'font-medium text-destructive' : 'text-muted-foreground'}`}>{baht(r.variance)}</span> },
              { key: 'reconciled', label: 'สถานะ', render: (r: any) => <Badge variant={r.reconciled ? 'success' : 'destructive'}>{r.reconciled ? 'ตรง' : 'ไม่ตรง'}</Badge> },
            ]}
            emptyState={{ title: 'ไม่มีข้อมูล' }}
            dense
          />
        )}
      </StateView>
      {d?.as_of && <p className="text-xs text-muted-foreground">ณ วันที่ {thaiDate(d.as_of)}</p>}
    </Card>
  );
}

// ────────── MON-01 pending-approvals aging monitor (every maker-checker queue, aged) ──────────
function PendingApprovalsMonitor() {
  const q = useQuery<any>({ queryKey: ['approvals-aging'], queryFn: () => api('/api/finance/approvals/aging') });
  const d = q.data;
  return (
    <Card className="gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-base font-semibold"><Clock className="size-4 text-muted-foreground" /> รายการรออนุมัติค้างนาน (Pending approvals aging)</h3>
        {d && (
          d.all_clear
            ? <Badge variant="success">ไม่มีรายการค้างเกินกำหนด ✓</Badge>
            : <Badge variant="destructive">{num(d.stale_count)} รายการเกินกำหนด — ต้องเร่งอนุมัติ</Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">รวมทุกคิว maker-checker (รายการบัญชี Draft + ตัดสต๊อก + จ่ายเจ้าหนี้) เรียงตามอายุที่รออนุมัติ — รายการที่ค้างเกิน SLA คือสัญญาณการควบคุมไม่ทำงาน (MON-01)</p>
      <StateView q={q}>
        {d && (
          <>
            <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-4">
              <StatCard label="รออนุมัติทั้งหมด" value={num(d.total_pending)} icon={Clock} tone="primary" />
              <StatCard label="มูลค่ารวม" value={baht(d.total_value)} />
              <StatCard label="อายุสูงสุด (วัน)" value={num(d.oldest_age_days)} />
              <StatCard label="เกินกำหนด" value={num(d.stale_count)} tone={d.stale_count ? 'danger' : 'success'} hint={`SLA ${num(d.stale_threshold_days)} วัน`} />
            </div>
            <DataTable
              rows={d.items}
              rowKey={(r: any) => `${r.type}-${r.ref}`}
              columns={[
                { key: 'control', label: 'ควบคุม', render: (r: any) => <span className="font-mono text-xs">{r.control}</span> },
                { key: 'label', label: 'ประเภท' },
                { key: 'ref', label: 'เลขที่', render: (r: any) => <span className="font-mono text-sm">{r.ref}</span> },
                { key: 'requested_by', label: 'ผู้ขอ', render: (r: any) => r.requested_by ?? '—' },
                { key: 'amount', label: 'มูลค่า', align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'age_days', label: 'อายุ (วัน)', align: 'right', render: (r: any) => <span className={`tabular ${r.stale ? 'font-medium text-destructive' : 'text-muted-foreground'}`}>{num(r.age_days)}</span> },
                { key: 'stale', label: 'สถานะ', render: (r: any) => <Badge variant={r.stale ? 'destructive' : 'success'}>{r.stale ? 'เกินกำหนด' : 'ปกติ'}</Badge> },
              ]}
              emptyState={{ icon: Clock, title: 'ไม่มีรายการรออนุมัติ', description: 'ทุกคิว maker-checker ว่าง' }}
              dense
            />
          </>
        )}
      </StateView>
      {d?.as_of && <p className="text-xs text-muted-foreground">ณ วันที่ {thaiDate(d.as_of)}</p>}
    </Card>
  );
}

// ───────────────────────── open a new recon period ─────────────────────────
function OpenPeriod({ onDone }: { onDone: () => void }) {
  const [accountCode, setAccountCode] = useState('');
  const [period, setPeriod] = useState('2026-06');

  const open = useMutation({
    mutationFn: () => api<any>('/api/recon/periods', { method: 'POST', body: JSON.stringify({ account_code: accountCode, period }) }),
    onSuccess: (r) => {
      notifySuccess(`เปิดงวด ${r.period} · บัญชี ${r.account_code}`);
      setAccountCode('');
      onDone();
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="max-w-2xl gap-4 p-5">
      <h3 className="text-base font-semibold">เปิดงวดกระทบยอด</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="recon-acct">รหัสบัญชี (account_code)</Label>
          <Input id="recon-acct" value={accountCode} onChange={(e) => setAccountCode(e.target.value)} placeholder="เช่น 1010" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="recon-period">งวด (YYYY-MM)</Label>
          <Input id="recon-period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-06" />
        </div>
      </div>
      <div>
        <Button disabled={open.isPending || !accountCode || !/^\d{4}-\d{2}$/.test(period)} onClick={() => open.mutate()}>
          {open.isPending ? 'กำลังเปิด…' : 'เปิดงวด'}
        </Button>
      </div>
    </Card>
  );
}

// ───────────────────────── period detail: summary + import GL / auto-match / certify ─────────────────────────
function PeriodDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['recon-summary', id], queryFn: () => api(`/api/recon/periods/${id}/summary`) });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['recon-summary', id] });
    qc.invalidateQueries({ queryKey: ['recon-periods'] });
  };

  const importGl = useMutation({
    mutationFn: () => api<any>(`/api/recon/periods/${id}/import-gl`, { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(`นำเข้ารายการ GL ${num(r.imported)} รายการ`); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const autoMatch = useMutation({
    mutationFn: () => api<any>(`/api/recon/periods/${id}/auto-match`, { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(`จับคู่ ${num(r.matched_pairs)} คู่ · ค้าง ${num(r.unmatched_gl)} รายการ`); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const certify = useMutation({
    mutationFn: () => api<any>(`/api/recon/periods/${id}/certify`, { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(`รับรองงวดโดย ${r.certified_by}`); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <ListChecks className="size-4 text-muted-foreground" /> รายละเอียดงวด #{id}
        </h3>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              งวด {q.data.period} · บัญชี {q.data.account_code} · <Badge variant={statusVariant(q.data.status)}>{q.data.status}</Badge>
              {q.data.prepared_by && <span>· จัดทำ {q.data.prepared_by}</span>}
              {q.data.certified_by && <span>· รับรอง {q.data.certified_by} ({thaiDate(q.data.certified_at)})</span>}
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="ยอด GL" value={baht(q.data.gl_balance)} tone="primary" />
              <StatCard label="ยอด Subledger" value={baht(q.data.subledger_balance)} />
              <StatCard label="รายการทั้งหมด" value={num(q.data.items?.total)} />
              <StatCard label="จับคู่แล้ว" value={num(q.data.items?.matched)} tone="success" hint={`ค้าง GL ${num(q.data.items?.unmatched_gl)} · Sub ${num(q.data.items?.unmatched_subledger)}`} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" disabled={importGl.isPending} onClick={() => importGl.mutate()}>
                <Download className="size-4" /> {importGl.isPending ? 'กำลังนำเข้า…' : 'นำเข้ารายการ GL'}
              </Button>
              <Button size="sm" variant="outline" disabled={autoMatch.isPending} onClick={() => autoMatch.mutate()}>
                <Link2 className="size-4" /> {autoMatch.isPending ? 'กำลังจับคู่…' : 'จับคู่อัตโนมัติ'}
              </Button>
              <Button size="sm" disabled={certify.isPending} onClick={() => certify.mutate()}>
                <ShieldCheck className="size-4" /> {certify.isPending ? 'กำลังรับรอง…' : 'รับรองงวด'}
              </Button>
            </div>
          </div>
        )}
      </StateView>
    </Card>
  );
}
