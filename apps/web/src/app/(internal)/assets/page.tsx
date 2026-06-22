'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, Coins, Landmark, Play, X } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function AssetsPage() {
  return (
    <div>
      <PageHeader
        title="สินทรัพย์ถาวร (Fixed Assets)"
        description="ทะเบียนสินทรัพย์ ค่าเสื่อมราคาแบบเส้นตรง และการลงบัญชีอัตโนมัติ (Dr 5200 / Cr 1590)"
      />
      <Tabs
        tabs={[
          { key: 'register', label: 'ทะเบียนสินทรัพย์', content: <Register /> },
          { key: 'categories', label: 'หมวดหมู่', content: <Categories /> },
          { key: 'runs', label: 'รอบค่าเสื่อมราคา', content: <DepreciationRuns /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Register + per-asset schedule drill-in ─────────────────────────
function Register() {
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const q = useQuery<any>({
    queryKey: ['assets', status],
    queryFn: () => api(`/api/assets${status ? `?status=${status}` : ''}`),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {[
          { v: '', label: 'ทั้งหมด' },
          { v: 'active', label: 'ใช้งาน' },
          { v: 'fully_depreciated', label: 'หมดค่าเสื่อม' },
          { v: 'disposed', label: 'จำหน่ายแล้ว' },
        ].map((f) => (
          <Button key={f.v} variant={status === f.v ? 'default' : 'outline'} size="sm" onClick={() => setStatus(f.v)}>
            {f.label}
          </Button>
        ))}
      </div>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="จำนวนสินทรัพย์" value={num(q.data.count)} icon={Boxes} tone="primary" />
              <StatCard label="ราคาทุนรวม" value={baht(q.data.total_cost)} icon={Coins} />
              <StatCard label="ค่าเสื่อมสะสม" value={baht(q.data.total_accum_dep)} tone="warning" />
              <StatCard label="มูลค่าตามบัญชี (NBV)" value={baht(q.data.total_nbv)} icon={Landmark} tone="success" />
            </div>

            <DataTable
              rows={q.data.assets}
              onRowClick={(r: any) => setSelected(r.asset_no)}
              columns={[
                { key: 'asset_no', label: 'รหัส' },
                { key: 'name', label: 'ชื่อสินทรัพย์' },
                { key: 'acquire_date', label: 'วันที่ได้มา', render: (r: any) => thaiDate(r.acquire_date) },
                { key: 'acquire_cost', label: 'ราคาทุน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.acquire_cost)}</span> },
                { key: 'accumulated_depreciation', label: 'ค่าเสื่อมสะสม', align: 'right', render: (r: any) => <span className="tabular">{baht(r.accumulated_depreciation)}</span> },
                { key: 'net_book_value', label: 'NBV', align: 'right', render: (r: any) => <span className="tabular">{baht(r.net_book_value)}</span> },
                { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              ]}
              emptyText="ยังไม่มีสินทรัพย์"
            />
          </div>
        )}
      </StateView>

      {selected && <ScheduleDrill assetNo={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ScheduleDrill({ assetNo, onClose }: { assetNo: string; onClose: () => void }) {
  const q = useQuery<any>({ queryKey: ['asset-schedule', assetNo], queryFn: () => api(`/api/assets/${assetNo}/schedule`) });
  return (
    <Card className="gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold">ตารางค่าเสื่อมราคา · {assetNo}</h3>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground">
              {q.data.asset?.name} · อายุการใช้งาน {num(q.data.asset?.useful_life_months)} เดือน · ราคาทุน {baht(q.data.asset?.acquire_cost)}
            </div>
            <DataTable
              rows={q.data.schedule}
              columns={[
                { key: 'period', label: 'งวด' },
                { key: 'amount', label: 'ค่าเสื่อม', align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'accumulated_after', label: 'สะสมหลังงวด', align: 'right', render: (r: any) => <span className="tabular">{baht(r.accumulated_after)}</span> },
                { key: 'nbv_after', label: 'NBV หลังงวด', align: 'right', render: (r: any) => <span className="tabular">{baht(r.nbv_after)}</span> },
              ]}
              emptyText="ยังไม่มีรายการค่าเสื่อม"
              dense
            />
          </div>
        )}
      </StateView>
    </Card>
  );
}

// ───────────────────────── Categories ─────────────────────────
function Categories() {
  const q = useQuery<any>({ queryKey: ['asset-categories'], queryFn: () => api('/api/assets/categories') });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <StatCard label="จำนวนหมวดหมู่" value={num(q.data.count)} icon={Boxes} tone="primary" className="max-w-xs" />
          <DataTable
            rows={q.data.categories}
            columns={[
              { key: 'code', label: 'รหัส' },
              { key: 'name', label: 'ชื่อหมวดหมู่' },
              { key: 'default_useful_life_years', label: 'อายุ (ปี)', align: 'right', render: (r: any) => <span className="tabular">{num(r.default_useful_life_years)}</span> },
              { key: 'asset_account', label: 'บัญชีสินทรัพย์' },
              { key: 'accum_dep_account', label: 'บัญชีค่าเสื่อมสะสม' },
              { key: 'dep_expense_account', label: 'บัญชีค่าใช้จ่าย' },
            ]}
            emptyText="ยังไม่มีหมวดหมู่"
          />
        </div>
      )}
    </StateView>
  );
}

// ───────────────────────── Depreciation runs + run action ─────────────────────────
function DepreciationRuns() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['dep-runs'], queryFn: () => api('/api/assets/depreciation/runs') });
  const [period, setPeriod] = useState('2026-06');
  const [msg, setMsg] = useState('');

  const run = useMutation({
    mutationFn: () => api<any>('/api/assets/depreciation/run', { method: 'POST', body: JSON.stringify({ period }) }),
    onSuccess: (r) => {
      if (r.already) setMsg(`✅ งวด ${period} ลงบัญชีไปแล้ว`);
      else if (!r.asset_count) setMsg(`✅ ไม่มีสินทรัพย์ที่ต้องคิดค่าเสื่อมในงวด ${period}`);
      else setMsg(`✅ คิดค่าเสื่อม ${num(r.asset_count)} รายการ · ${baht(r.total_depreciation)} · ${r.runs?.length ?? 1} รอบ`);
      qc.invalidateQueries({ queryKey: ['dep-runs'] });
      qc.invalidateQueries({ queryKey: ['assets'] });
    },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div className="space-y-5">
      <Card className="gap-4 p-5">
        <h3 className="text-base font-semibold">คิดค่าเสื่อมราคาประจำงวด</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="dep-period">งวด (YYYY-MM)</Label>
            <input id="dep-period" className={`${selectCls} max-w-[160px]`} value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-06" />
          </div>
          <Button disabled={run.isPending || !/^\d{4}-\d{2}$/.test(period)} onClick={() => run.mutate()}>
            <Play className="size-4" /> {run.isPending ? 'กำลังคิด…' : 'คิดค่าเสื่อม'}
          </Button>
        </div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.runs}
            columns={[
              { key: 'run_no', label: 'เลขที่รอบ' },
              { key: 'period', label: 'งวด' },
              { key: 'asset_count', label: 'จำนวนสินทรัพย์', align: 'right', render: (r: any) => <span className="tabular">{num(r.asset_count)}</span> },
              { key: 'total_depreciation', label: 'ค่าเสื่อมรวม', align: 'right', render: (r: any) => <span className="tabular">{baht(r.total_depreciation)}</span> },
              { key: 'journal_no', label: 'เลขที่บัญชี', render: (r: any) => r.journal_no ?? '—' },
              { key: 'posted_at', label: 'ลงบัญชีเมื่อ', render: (r: any) => thaiDate(r.posted_at) },
            ]}
            emptyText="ยังไม่มีรอบค่าเสื่อม"
          />
        )}
      </StateView>
    </div>
  );
}
