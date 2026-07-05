'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, KeyRound, FileSignature, CheckCircle2, HandCoins } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const unitTone: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = { available: 'default', reserved: 'outline', contracted: 'secondary', transferred: 'destructive' };

// Real-estate developer vertical (docs/35 P4, RE-01/02/03). Developments/units availability grid, booking,
// maker-checker sale contract, installment payments. Permission-gated (re_sales).
export default function RealEstatePage() {
  const qc = useQueryClient();
  const [devCode, setDevCode] = useState('');
  const [active, setActive] = useState('');
  const [contractNo, setContractNo] = useState('');
  const units = useQuery<any>({ queryKey: ['re-units', active], queryFn: () => api(`/api/realestate/developments/${active}/units`), enabled: !!active });
  const contract = useQuery<any>({ queryKey: ['re-contract', contractNo], queryFn: () => api(`/api/realestate/contracts/${contractNo}`), enabled: !!contractNo });
  const [dev, setDev] = useState({ dev_code: '', name: '', location: '' });
  const [unit, setUnit] = useState({ unit_no: '', unit_type: 'condo', area_sqm: '', list_price: '' });
  const refreshUnits = () => qc.invalidateQueries({ queryKey: ['re-units', active] });

  const createDev = useMutation({ mutationFn: () => api('/api/realestate/developments', { method: 'POST', body: JSON.stringify(dev) }), onSuccess: () => { notifySuccess('สร้างโครงการแล้ว'); setActive(dev.dev_code); setDev({ dev_code: '', name: '', location: '' }); }, onError: (e: any) => notifyError(e.message) });
  const addUnit = useMutation({ mutationFn: () => api(`/api/realestate/developments/${active}/units`, { method: 'POST', body: JSON.stringify({ unit_no: unit.unit_no, unit_type: unit.unit_type, area_sqm: Number(unit.area_sqm) || 0, list_price: Number(unit.list_price) || 0 }) }), onSuccess: () => { notifySuccess('เพิ่มยูนิตแล้ว'); setUnit({ unit_no: '', unit_type: 'condo', area_sqm: '', list_price: '' }); refreshUnits(); }, onError: (e: any) => notifyError(e.message) });
  const book = useMutation({ mutationFn: (v: { unit_no: string; deposit: number }) => api('/api/realestate/bookings', { method: 'POST', body: JSON.stringify({ dev_code: active, unit_no: v.unit_no, deposit: v.deposit }) }), onSuccess: () => { notifySuccess('จองยูนิตแล้ว (Dr เงินสด / Cr เงินมัดจำ)'); refreshUnits(); }, onError: (e: any) => notifyError(e.message) });
  const contractM = useMutation({ mutationFn: (v: { unit_no: string; discount: number; down: number; inst: number }) => api('/api/realestate/contracts', { method: 'POST', body: JSON.stringify({ dev_code: active, unit_no: v.unit_no, discount: v.discount, down_payment: v.down, installment_count: v.inst }) }), onSuccess: (d: any) => { notifySuccess(`ร่างสัญญา ${d.contract_no}`); setContractNo(d.contract_no); refreshUnits(); }, onError: (e: any) => notifyError(e.message) });
  const approve = useMutation({ mutationFn: (no: string) => api(`/api/realestate/contracts/${no}/approve`, { method: 'POST' }), onSuccess: () => { notifySuccess('อนุมัติสัญญา — ยูนิตทำสัญญา, ลงดาวน์, สร้างงวดผ่อน'); qc.invalidateQueries({ queryKey: ['re-contract', contractNo] }); refreshUnits(); }, onError: (e: any) => notifyError(e.message) });
  const pay = useMutation({ mutationFn: (v: { id: number; amount: number }) => api(`/api/realestate/installments/${v.id}/pay`, { method: 'POST', body: JSON.stringify({ amount: v.amount }) }), onSuccess: () => { notifySuccess('รับชำระงวดแล้ว'); qc.invalidateQueries({ queryKey: ['re-contract', contractNo] }); }, onError: (e: any) => notifyError(e.message) });

  const u = units.data;
  const c = contract.data;
  return (
    <div>
      <PageHeader title="อสังหาริมทรัพย์ (Developer)" description="โครงการ & ยูนิต · จอง · สัญญาจะซื้อจะขาย (maker-checker) · ผ่อนดาวน์ (RE-01/02/03)" />

      <div className="mb-5 grid gap-4 lg:grid-cols-2">
        <Card className="gap-3 p-5">
          <h3 className="text-base font-semibold">สร้างโครงการ</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5"><Label>รหัส</Label><Input value={dev.dev_code} onChange={(e) => setDev({ ...dev, dev_code: e.target.value })} placeholder="RED-…" /></div>
            <div className="grid gap-1.5"><Label>ชื่อ</Label><Input value={dev.name} onChange={(e) => setDev({ ...dev, name: e.target.value })} /></div>
            <div className="grid gap-1.5"><Label>ทำเล</Label><Input value={dev.location} onChange={(e) => setDev({ ...dev, location: e.target.value })} /></div>
          </div>
          <div><Button onClick={() => createDev.mutate()} disabled={!dev.dev_code || !dev.name || createDev.isPending}><Plus className="size-4" /> สร้าง</Button></div>
        </Card>
        <Card className="flex flex-wrap items-end gap-3 p-5">
          <div className="grid gap-1.5"><Label>เปิดโครงการ</Label><Input value={devCode} onChange={(e) => setDevCode(e.target.value)} placeholder="RED-…" /></div>
          <Button variant="outline" onClick={() => setActive(devCode.trim())} disabled={!devCode.trim()}><Search className="size-4" /> เปิด</Button>
        </Card>
      </div>

      {active && (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-4">
            <StatCard label="ยูนิตทั้งหมด" value={u?.summary?.total ?? '—'} />
            <StatCard label="ว่าง" value={u?.summary?.available ?? '—'} />
            <StatCard label="จองแล้ว" value={u?.summary?.reserved ?? '—'} />
            <StatCard label="ทำสัญญา" value={u?.summary?.contracted ?? '—'} />
          </div>

          <Card className="mb-5 gap-3 p-5">
            <h3 className="text-base font-semibold">เพิ่มยูนิต ({active})</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="grid gap-1.5"><Label>เลขยูนิต</Label><Input value={unit.unit_no} onChange={(e) => setUnit({ ...unit, unit_no: e.target.value })} placeholder="U-101" /></div>
              <div className="grid gap-1.5"><Label>ประเภท</Label><Input value={unit.unit_type} onChange={(e) => setUnit({ ...unit, unit_type: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>พื้นที่ (ตร.ม.)</Label><Input type="number" min="0" value={unit.area_sqm} onChange={(e) => setUnit({ ...unit, area_sqm: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>ราคาตั้ง</Label><Input type="number" min="0" value={unit.list_price} onChange={(e) => setUnit({ ...unit, list_price: e.target.value })} /></div>
            </div>
            <div><Button onClick={() => addUnit.mutate()} disabled={!unit.unit_no || !unit.list_price || addUnit.isPending}><Plus className="size-4" /> เพิ่มยูนิต</Button></div>
          </Card>

          <StateView q={units}>{u && (
            <DataTable
              rows={u.units ?? []}
              rowKey={(r: any) => r.unit_no}
              columns={[
                { key: 'unit_no', label: 'ยูนิต' },
                { key: 'unit_type', label: 'ประเภท' },
                { key: 'area_sqm', label: 'ตร.ม.', align: 'right' },
                { key: 'list_price', label: 'ราคาตั้ง', align: 'right', render: (r: any) => <span className="tabular">{baht(r.list_price)}</span> },
                { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={unitTone[r.status] ?? 'secondary'}>{r.status}</Badge> },
                { key: 'actions', label: '', align: 'right', render: (r: any) => (
                  <div className="flex justify-end gap-1.5">
                    {r.status === 'available' && <Button size="sm" variant="outline" onClick={() => { const dep = prompt('เงินจอง'); if (dep) book.mutate({ unit_no: r.unit_no, deposit: Number(dep) }); }}><KeyRound className="size-3.5" /> จอง</Button>}
                    {(r.status === 'available' || r.status === 'reserved') && <Button size="sm" onClick={() => { const discount = Number(prompt('ส่วนลด', '0') || 0); const down = Number(prompt('เงินดาวน์', '0') || 0); const inst = Number(prompt('จำนวนงวดผ่อน', '12') || 0); contractM.mutate({ unit_no: r.unit_no, discount, down, inst }); }}><FileSignature className="size-3.5" /> ทำสัญญา</Button>}
                  </div>
                ) },
              ]}
            />
          )}</StateView>

          <Card className="mt-5 gap-3 p-5">
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1.5"><Label>ดูสัญญา (เลขที่)</Label><Input value={contractNo} onChange={(e) => setContractNo(e.target.value)} placeholder="REC-…" /></div>
            </div>
            {c && (
              <div className="grid gap-3">
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <span>ราคา <b className="tabular">{baht(c.price)}</b></span>
                  <span>ดาวน์ <b className="tabular">{baht(c.down_payment)}</b></span>
                  <span>ผ่อนแล้ว <b className="tabular">{baht(c.installments_paid)}</b></span>
                  <span>คงเหลือ <b className="tabular">{baht(c.outstanding)}</b></span>
                  <Badge variant={c.status === 'active' ? 'default' : 'secondary'}>{c.status}</Badge>
                  {c.status === 'draft' && <Button size="sm" onClick={() => approve.mutate(c.contract_no)}><CheckCircle2 className="size-3.5" /> อนุมัติสัญญา</Button>}
                </div>
                {(c.installments ?? []).length > 0 && (
                  <DataTable
                    rows={c.installments}
                    rowKey={(r: any) => r.id}
                    columns={[
                      { key: 'seq', label: 'งวด', align: 'right' },
                      { key: 'due_date', label: 'ครบกำหนด' },
                      { key: 'amount', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
                      { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={r.status === 'paid' ? 'default' : 'secondary'}>{r.status}</Badge> },
                      { key: 'actions', label: '', align: 'right', render: (r: any) => r.status === 'pending' ? <Button size="sm" variant="outline" onClick={() => pay.mutate({ id: r.id, amount: r.amount })}><HandCoins className="size-3.5" /> รับชำระ</Button> : null },
                    ]}
                  />
                )}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
