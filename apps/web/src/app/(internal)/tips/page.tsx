'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Coins, HandCoins, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { notifySuccess, notifyError } from '@/lib/notify';

// B3 — tip pooling / distribution. Tips accrue to 2300 Tips Payable on checkout; a manager pays the
// pool out to staff (Dr 2300 / Cr 1000), clearing the liability. SoD: distributing needs order_mgt/exec.
interface Dist { dist_no: string; period_from: string; period_to: string; method: string; pool_amount: number; journal_no: string | null; created_by: string | null; created_at: string; lines: { staff: string; amount: number; share: number }[] }
interface ListResp { distributions: Dist[]; count: number; gl_outstanding: number }
interface Pool { from: string; to: string; collected: number; distributed: number; available: number; gl_outstanding: number }

function today() { const d = new Date(); return d.toISOString().slice(0, 10); }
function monthStart() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; }

export default function TipsPage() {
  const qc = useQueryClient();
  const list = useQuery<ListResp>({ queryKey: ['tips'], queryFn: () => api('/api/restaurant/tips'), refetchInterval: 30_000 });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['tips'] }); qc.invalidateQueries({ queryKey: ['tip-pool'] }); };

  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [method, setMethod] = useState<'equal' | 'hours' | 'weight'>('equal');
  const [staff, setStaff] = useState('');

  const pool = useQuery<Pool>({ queryKey: ['tip-pool', from, to], queryFn: () => api(`/api/restaurant/tips/pool?from=${from}&to=${to}`) });

  const distribute = useMutation({
    mutationFn: () => {
      const rows = staff.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).map((line) => {
        const [name, val] = line.split(/[:\s]+/);
        return method === 'equal' ? { staff: name } : method === 'hours' ? { staff: name, hours: Number(val) || 0 } : { staff: name, weight: Number(val) || 0 };
      });
      return api('/api/restaurant/tips/distribute', { method: 'POST', body: JSON.stringify({ from, to, method, staff: rows }) });
    },
    onSuccess: (r: any) => { notifySuccess(`แบ่งทิป ${baht(r.amount)} ให้ ${r.lines.length} คนแล้ว`); setStaff(''); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const d = list.data;
  return (
    <ModulePage
      title="ทิปพนักงาน (Tip pooling & payout)"
      description="ทิปจากการขายจะรวมเป็นหนี้สิน 2300 ทิปค้างจ่าย; ผู้จัดการแบ่งจ่ายให้พนักงาน (Dr 2300 / Cr 1000) เคลียร์ยอดค้าง"
      query={list}
      stats={d && (
        <>
          <StatCard label="ทิปค้างจ่าย (2300)" value={baht(d.gl_outstanding)} icon={Coins} tone={d.gl_outstanding > 0 ? 'warning' : 'success'} hint="ยังไม่ได้แบ่งให้พนักงาน" />
          <StatCard label="ยอดแบ่งได้ (งวดนี้)" value={baht(pool.data?.available ?? 0)} icon={HandCoins} tone="primary" />
          <StatCard label="ทิปที่เก็บได้ (งวดนี้)" value={baht(pool.data?.collected ?? 0)} icon={Wallet} tone="default" />
          <StatCard label="แบ่งไปแล้ว (รวม)" value={String(d.count)} icon={HandCoins} tone="default" hint="ครั้ง" />
        </>
      )}
      statsClassName="xl:grid-cols-4"
    >
      <div className="mb-4 rounded-xl border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">แบ่งจ่ายทิป</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FormField label="ตั้งแต่"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
          <FormField label="ถึง"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
          <FormField label="วิธีแบ่ง">
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={method} onChange={(e) => setMethod(e.target.value as any)}>
              <option value="equal">เท่ากันทุกคน</option>
              <option value="hours">ตามชั่วโมงทำงาน</option>
              <option value="weight">ตามน้ำหนัก</option>
            </select>
          </FormField>
          <div className="flex items-end"><div className="text-sm text-muted-foreground">ยอดแบ่งได้ <strong className="text-foreground">{baht(pool.data?.available ?? 0)}</strong></div></div>
          <FormField label={method === 'equal' ? 'พนักงาน (บรรทัดละชื่อ)' : `พนักงาน : ${method === 'hours' ? 'ชั่วโมง' : 'น้ำหนัก'} (เช่น  สมชาย 6)`} className="lg:col-span-3">
            <textarea className="min-h-[72px] w-full rounded-md border bg-background p-2 text-sm" value={staff} onChange={(e) => setStaff(e.target.value)} placeholder={method === 'equal' ? 'สมชาย\nสมหญิง' : 'สมชาย 6\nสมหญิง 2'} />
          </FormField>
          <div className="flex items-end"><Button disabled={distribute.isPending || !staff.trim() || (pool.data?.available ?? 0) <= 0} onClick={() => distribute.mutate()}>แบ่งจ่ายทิป</Button></div>
        </div>
      </div>

      {d && (
        <DataTable
          rows={d.distributions}
          rowKey={(r) => r.dist_no}
          emptyState={{ icon: HandCoins, title: 'ยังไม่มีการแบ่งทิป', description: 'เลือกงวดและพนักงานด้านบนเพื่อแบ่งจ่ายทิปที่เก็บได้' }}
          columns={[
            { key: 'dist_no', label: 'เลขที่', render: (r) => <span className="font-mono text-sm">{r.dist_no}</span> },
            { key: 'period', label: 'งวด', render: (r) => `${r.period_from} → ${r.period_to}` },
            { key: 'method', label: 'วิธี', render: (r) => ({ equal: 'เท่ากัน', hours: 'ตามชั่วโมง', weight: 'ตามน้ำหนัก' }[r.method] ?? r.method) },
            { key: 'pool_amount', label: 'ยอดรวม', align: 'right', render: (r) => baht(r.pool_amount) },
            { key: 'lines', label: 'พนักงาน', render: (r) => <span className="text-muted-foreground text-xs">{r.lines.map((l) => `${l.staff} ${baht(l.amount)}`).join(' · ')}</span> },
            { key: 'created_at', label: 'วันที่', render: (r) => thaiDate(r.created_at) },
          ]}
        />
      )}
    </ModulePage>
  );
}
