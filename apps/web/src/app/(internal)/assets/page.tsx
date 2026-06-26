'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, CalendarRange, Coins, FolderTree, Landmark, Play, QrCode, ScanLine, SearchX, X } from 'lucide-react';
import { api, apiDownload } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
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
  const qc = useQueryClient();
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
              emptyState={
                status
                  ? {
                      icon: SearchX,
                      title: 'ไม่พบสินทรัพย์ตามตัวกรอง',
                      description: 'ไม่มีสินทรัพย์ในสถานะนี้ ลองล้างตัวกรองเพื่อดูทั้งหมด',
                      action: (
                        <Button variant="outline" size="sm" onClick={() => setStatus('')}>
                          ล้างตัวกรอง
                        </Button>
                      ),
                    }
                  : { icon: Boxes, title: 'ยังไม่มีสินทรัพย์', description: 'เพิ่มสินทรัพย์ในทะเบียน หรือบันทึกการได้มาเพื่อเริ่มต้น' }
              }
            />
          </div>
        )}
      </StateView>

      {selected && <ScheduleDrill assetNo={selected} onClose={() => setSelected(null)} />}
      {selected && <RevaluationPanel assetNo={selected} onChange={() => qc.invalidateQueries({ queryKey: ['assets'] })} />}
      {selected && q.data && <DisposalPanel asset={(q.data.assets ?? []).find((a: any) => a.asset_no === selected)} onChange={() => qc.invalidateQueries({ queryKey: ['assets'] })} />}
    </div>
  );
}

// Disposal with maker-checker (FA-09): a request posts a Draft JE + flags the asset disposal_pending; a
// DIFFERENT user must approve before it is effective (status → disposed). Requester self-approval → SOD.
function DisposalPanel({ asset, onChange }: { asset: any; onChange: () => void }) {
  const [proceeds, setProceeds] = useState('');
  const refresh = () => onChange();
  if (!asset) return null;

  const request = useMutation({
    mutationFn: () => api<any>(`/api/assets/${asset.asset_no}/dispose`, { method: 'PATCH', body: JSON.stringify({ proceeds: Number(proceeds) || 0 }) }),
    onSuccess: (r: any) => { notifySuccess(`ส่งคำขอจำหน่าย (${r.gain_loss >= 0 ? 'กำไร' : 'ขาดทุน'} ${baht(Math.abs(r.gain_loss))}) — รอผู้อื่นอนุมัติ`); setProceeds(''); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const approve = useMutation({
    mutationFn: () => api<any>(`/api/assets/${asset.asset_no}/dispose/approve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess('อนุมัติการจำหน่าย — สินทรัพย์ถูกจำหน่ายและลงบัญชีแล้ว'); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: () => api<any>(`/api/assets/${asset.asset_no}/dispose/reject`, { method: 'POST', body: JSON.stringify({ reason: window.prompt('เหตุผลที่ปฏิเสธ (ไม่บังคับ)') || undefined }) }),
    onSuccess: () => { notifySuccess('ปฏิเสธการจำหน่าย — สินทรัพย์ยังใช้งานอยู่'); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const busy = approve.isPending || reject.isPending;

  return (
    <Card className="gap-4 p-5">
      <h3 className="text-base font-semibold">จำหน่ายสินทรัพย์ · {asset.asset_no}</h3>
      {asset.status === 'disposed' ? (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
          <Badge variant="secondary">จำหน่ายแล้ว</Badge> รับเงิน {baht(asset.disposal_proceeds)} · {asset.disposal_gain_loss >= 0 ? 'กำไร' : 'ขาดทุน'} {baht(Math.abs(asset.disposal_gain_loss))}
          {asset.disposal_approved_by && <span className="text-muted-foreground"> · อนุมัติโดย {asset.disposal_approved_by}</span>}
        </div>
      ) : asset.disposal_pending ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <Badge variant="warning">รออนุมัติจำหน่าย</Badge>
          <span>รับเงิน {baht(asset.disposal_proceeds)} · {asset.disposal_gain_loss >= 0 ? 'กำไร' : 'ขาดทุน'} {baht(Math.abs(asset.disposal_gain_loss))} · ผู้ขอ {asset.disposal_requested_by}</span>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => approve.mutate()}>อนุมัติ</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => reject.mutate()}>ปฏิเสธ</Button>
          </div>
          <p className="w-full text-xs text-muted-foreground">ต้องเป็นคนละคนกับผู้ขอ (แบ่งแยกหน้าที่) — สินทรัพย์ถูกจำหน่ายและลงบัญชีเมื่ออนุมัติเท่านั้น</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>เงินที่ได้รับ (Proceeds)</Label><Input type="number" min="0" value={proceeds} onChange={(e) => setProceeds(e.target.value)} className="w-44" /></div>
          <span className="text-xs text-muted-foreground">NBV ปัจจุบัน {baht(asset.net_book_value)}</span>
          <Button disabled={!proceeds || request.isPending} onClick={() => request.mutate()}>ส่งคำขอจำหน่าย</Button>
        </div>
      )}
    </Card>
  );
}

// Revaluation / impairment with maker-checker (FA-08): request defers the carrying-value change as a
// Draft; a DIFFERENT user approves before it is effective. Preparer self-approval → SOD_VIOLATION.
function RevaluationPanel({ assetNo, onChange }: { assetNo: string; onChange: () => void }) {
  const qc = useQueryClient();
  const [newValue, setNewValue] = useState('');
  const [reason, setReason] = useState('');
  const q = useQuery<any>({ queryKey: ['asset-revals', assetNo], queryFn: () => api(`/api/assets/${assetNo}/revaluations`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['asset-revals', assetNo] }); onChange(); };
  const pending = (q.data?.revaluations ?? []).find((r: any) => r.status === 'PendingApproval');

  const request = useMutation({
    mutationFn: () => api<any>(`/api/assets/${assetNo}/revalue`, { method: 'POST', body: JSON.stringify({ new_value: Number(newValue), reason: reason || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(`ส่งคำขอตีมูลค่าใหม่ (${r.kind === 'impairment' ? 'ด้อยค่า' : 'เพิ่มมูลค่า'} ${baht(r.delta)}) — รอผู้อื่นอนุมัติ`); setNewValue(''); setReason(''); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const approve = useMutation({
    mutationFn: () => api<any>(`/api/assets/${assetNo}/revalue/approve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess('อนุมัติการตีมูลค่าใหม่ — ลงบัญชีมีผล'); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: () => api<any>(`/api/assets/${assetNo}/revalue/reject`, { method: 'POST', body: JSON.stringify({ reason: window.prompt('เหตุผลที่ปฏิเสธ (ไม่บังคับ)') || undefined }) }),
    onSuccess: () => { notifySuccess('ปฏิเสธการตีมูลค่าใหม่ — ยกเลิกรายการบัญชี'); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const busy = approve.isPending || reject.isPending;

  return (
    <Card className="gap-4 p-5">
      <h3 className="text-base font-semibold">ตีมูลค่าใหม่ / ด้อยค่า · {assetNo}</h3>
      {pending ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <Badge variant="warning">รออนุมัติ</Badge>
          <span>{pending.kind === 'impairment' ? 'ด้อยค่า' : 'เพิ่มมูลค่า'}: {baht(pending.old_value)} → {baht(pending.new_value)} · ผู้ขอ {pending.actioned_by}</span>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => approve.mutate()}>อนุมัติ</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => reject.mutate()}>ปฏิเสธ</Button>
          </div>
          <p className="w-full text-xs text-muted-foreground">ต้องเป็นคนละคนกับผู้ขอ (แบ่งแยกหน้าที่) — มูลค่ามีผลต่อบัญชีเมื่ออนุมัติเท่านั้น</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5"><Label>มูลค่าใหม่ (NBV)</Label><Input type="number" min="0" value={newValue} onChange={(e) => setNewValue(e.target.value)} className="w-40" /></div>
          <div className="grid gap-1.5"><Label>เหตุผล</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} className="w-56" placeholder="เช่น ประเมินราคาตลาด" /></div>
          <Button disabled={!newValue || request.isPending} onClick={() => request.mutate()}>ส่งคำขอ</Button>
        </div>
      )}
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.revaluations}
            emptyState={{ title: 'ยังไม่มีประวัติการตีมูลค่า' }}
            dense
            columns={[
              { key: 'reval_date', label: 'วันที่', render: (r: any) => (r.reval_date ? thaiDate(r.reval_date) : '—') },
              { key: 'kind', label: 'ประเภท', render: (r: any) => <Badge variant={r.kind === 'impairment' ? 'destructive' : 'success'}>{r.kind === 'impairment' ? 'ด้อยค่า' : 'เพิ่มมูลค่า'}</Badge> },
              { key: 'old_value', label: 'เดิม', align: 'right', render: (r: any) => <span className="tabular">{baht(r.old_value)}</span> },
              { key: 'new_value', label: 'ใหม่', align: 'right', render: (r: any) => <span className="tabular">{baht(r.new_value)}</span> },
              { key: 'delta', label: 'ส่วนต่าง', align: 'right', render: (r: any) => <span className={`tabular ${r.delta < 0 ? 'text-destructive' : 'text-success'}`}>{baht(r.delta)}</span> },
              { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={r.status === 'Posted' ? 'success' : r.status === 'Rejected' ? 'destructive' : 'warning'}>{r.status === 'Posted' ? 'ผ่านแล้ว' : r.status === 'Rejected' ? 'ปฏิเสธ' : 'รออนุมัติ'}</Badge> },
              { key: 'by', label: 'ผู้ขอ/อนุมัติ', render: (r: any) => <span className="text-xs text-muted-foreground">{r.actioned_by ?? '—'}{r.approved_by ? ` → ${r.approved_by}` : ''}</span> },
            ]}
          />
        )}
      </StateView>
    </Card>
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
              emptyState={{ title: 'ยังไม่มีรายการค่าเสื่อม' }}
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

  const [scanCode, setScanCode] = useState('');
  const [scanLoc, setScanLoc] = useState('');
  const scan = useMutation({
    mutationFn: () => api('/api/assets/scan-update', { method: 'POST', body: JSON.stringify({ code: scanCode, location: scanLoc || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(`อัปเดต ${r.asset_no} → 📍 ${r.location ?? '—'}`); setScanCode(''); setScanLoc(''); qc.invalidateQueries({ queryKey: ['assets'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  async function downloadLabels() {
    setBusy(true);
    try { await apiDownload('/api/assets/qr/labels', 'asset_tags.pdf'); }
    catch (e: any) { notifyError(e.message); }
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
            emptyState={{ icon: FolderTree, title: 'ยังไม่มีหมวดหมู่สินทรัพย์', description: 'ตั้งค่าหมวดหมู่เพื่อกำหนดอายุการใช้งานและผังบัญชีเริ่มต้น' }}
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

  const run = useMutation({
    mutationFn: () => api<any>('/api/assets/depreciation/run', { method: 'POST', body: JSON.stringify({ period }) }),
    onSuccess: (r) => {
      if (r.already) notifySuccess(`งวด ${period} ลงบัญชีไปแล้ว`);
      else if (!r.asset_count) notifySuccess(`ไม่มีสินทรัพย์ที่ต้องคิดค่าเสื่อมในงวด ${period}`);
      else notifySuccess(`คิดค่าเสื่อม ${num(r.asset_count)} รายการ · ${baht(r.total_depreciation)} · ${r.runs?.length ?? 1} รอบ`);
      qc.invalidateQueries({ queryKey: ['dep-runs'] });
      qc.invalidateQueries({ queryKey: ['assets'] });
    },
    onError: (e: any) => notifyError(e.message),
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
            emptyState={{ icon: CalendarRange, title: 'ยังไม่มีรอบค่าเสื่อมราคา', description: 'เลือกงวดด้านบนแล้วกด คิดค่าเสื่อม เพื่อสร้างรอบแรก' }}
          />
        )}
      </StateView>
    </div>
  );
}
