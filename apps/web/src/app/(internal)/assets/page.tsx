'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, Coins, Landmark, Play, QrCode, ScanLine, X } from 'lucide-react';
import { api, apiDownload } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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
          { key: 'qr', label: 'QR ป้ายทรัพย์สิน', content: <QrTags /> },
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

// ───────────────────────── QR asset tags + scan-to-update ─────────────────────────
function QrTags() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['assets', ''], queryFn: () => api('/api/assets') });
  const [assetNo, setAssetNo] = useState('');
  const single = useQuery<any>({
    queryKey: ['asset-qr', assetNo],
    queryFn: () => api(`/api/assets/${assetNo}/qr`),
    enabled: !!assetNo,
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const [scanCode, setScanCode] = useState('');
  const [scanLoc, setScanLoc] = useState('');
  const scan = useMutation({
    mutationFn: () => api('/api/assets/scan-update', { method: 'POST', body: JSON.stringify({ code: scanCode, location: scanLoc || undefined }) }),
    onSuccess: (r: any) => { setMsg(`✅ อัปเดต ${r.asset_no} → 📍 ${r.location ?? '—'}`); setScanCode(''); setScanLoc(''); qc.invalidateQueries({ queryKey: ['assets'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  async function downloadLabels() {
    setMsg(''); setBusy(true);
    try { await apiDownload('/api/assets/qr/labels', 'asset_tags.pdf'); }
    catch (e: any) { setMsg(`❌ ${e.message}`); }
    finally { setBusy(false); }
  }

  const assets = q.data?.assets ?? [];

  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">พิมพ์ป้าย QR ทรัพย์สิน</h3>
        <p className="text-sm text-muted-foreground">ดาวน์โหลดแผ่นป้าย QR (A4) สำหรับติดบนทรัพย์สินทุกชิ้น</p>
        <div>
          <Button disabled={busy} onClick={downloadLabels}><QrCode className="size-4" /> {busy ? 'กำลังสร้าง…' : 'ดาวน์โหลดป้าย QR ทั้งหมด'}</Button>
        </div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="gap-3 p-5">
          <h3 className="text-base font-semibold">ดู QR รายชิ้น</h3>
          <div className="grid gap-1.5 max-w-sm">
            <Label htmlFor="qr-asset">ทรัพย์สิน</Label>
            <select id="qr-asset" className={selectCls} value={assetNo} onChange={(e) => setAssetNo(e.target.value)}>
              <option value="">— เลือก —</option>
              {assets.map((a: any) => <option key={a.asset_no} value={a.asset_no}>{a.asset_no} — {a.name}</option>)}
            </select>
          </div>
          {single.data?.data_url && (
            <div className="flex flex-col items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={single.data.data_url} alt="QR" width={200} height={200} />
              <code className="break-all text-center text-xs text-muted-foreground">{single.data.payload}</code>
            </div>
          )}
        </Card>

        <Card className="gap-3 p-5">
          <h3 className="text-base font-semibold">สแกน & อัปเดตตำแหน่ง</h3>
          <p className="text-sm text-muted-foreground">สแกน (หรือวาง) โค้ดจากป้าย QR แล้วระบุตำแหน่งใหม่</p>
          <div className="grid gap-1.5">
            <Label htmlFor="scan-code">โค้ดจาก QR</Label>
            <Input id="scan-code" placeholder="ASSET_ID:FA-0001|…" value={scanCode} onChange={(e) => setScanCode(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="scan-loc">ตำแหน่งใหม่</Label>
            <Input id="scan-loc" placeholder="เช่น ห้องครัวกลาง" value={scanLoc} onChange={(e) => setScanLoc(e.target.value)} />
          </div>
          <div>
            <Button disabled={!scanCode || scan.isPending} onClick={() => scan.mutate()}><ScanLine className="size-4" /> {scan.isPending ? 'กำลังอัปเดต…' : 'อัปเดต'}</Button>
          </div>
        </Card>
      </div>
    </div>
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
