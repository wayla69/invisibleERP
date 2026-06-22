'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Receipt, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { statusVariant } from '@/components/ui';

const sel = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm';

export default function ProjectsPage() {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <div>
      <PageHeader title="โครงการ (Project Accounting / PSA)" description="โครงการ งาน ลงเวลา ค่าใช้จ่าย งวดงาน — ตั้งเบิกแบบ T&M/งวดงาน → ลูกหนี้ และกำไรโครงการ" />
      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <ProjectsList onSelect={setSelected} />
        {selected ? <ProjectDetail id={selected} /> : <Card className="p-8 text-center text-sm text-muted-foreground">เลือกโครงการเพื่อดูรายละเอียด</Card>}
      </div>
    </div>
  );
}

function ProjectsList({ onSelect }: { onSelect: (id: number) => void }) {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['projects'], queryFn: () => api('/api/projects') });
  const [f, setF] = useState({ name: '', customer_name: '', billing_type: 'TM', default_bill_rate: '', cost_budget: '' });
  const [msg, setMsg] = useState('');
  const create = useMutation({
    mutationFn: () => api('/api/projects', { method: 'POST', body: JSON.stringify({ name: f.name, customer_name: f.customer_name || undefined, billing_type: f.billing_type, default_bill_rate: f.default_bill_rate ? Number(f.default_bill_rate) : undefined, cost_budget: f.cost_budget ? Number(f.cost_budget) : undefined }) }),
    onSuccess: () => { setMsg('✅ สร้างโครงการแล้ว'); setF({ name: '', customer_name: '', billing_type: 'TM', default_bill_rate: '', cost_budget: '' }); qc.invalidateQueries({ queryKey: ['projects'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">สร้างโครงการ</h3>
        <Input placeholder="ชื่อโครงการ" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input placeholder="ลูกค้า" value={f.customer_name} onChange={(e) => setF({ ...f, customer_name: e.target.value })} />
        <div className="flex flex-wrap gap-2">
          <select className={sel} value={f.billing_type} onChange={(e) => setF({ ...f, billing_type: e.target.value })}>{['TM', 'Fixed', 'Milestone'].map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <Input className="max-w-[130px]" type="number" placeholder="เรท/ชม." value={f.default_bill_rate} onChange={(e) => setF({ ...f, default_bill_rate: e.target.value })} />
          <Input className="max-w-[140px]" type="number" placeholder="งบต้นทุน" value={f.cost_budget} onChange={(e) => setF({ ...f, cost_budget: e.target.value })} />
          <Button disabled={!f.name || create.isPending} onClick={() => create.mutate()}><Plus className="size-4" /> สร้าง</Button>
        </div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.projects}
            onRowClick={(r: any) => onSelect(r.id)}
            columns={[
              { key: 'code', label: 'รหัส' }, { key: 'name', label: 'ชื่อ' },
              { key: 'billing_type', label: 'ตั้งเบิก' },
              { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status === 'Closed' ? 'paid' : 'open')}>{r.status}</Badge> },
            ]}
            emptyText="ยังไม่มีโครงการ"
          />
        )}
      </StateView>
    </div>
  );
}

function ProjectDetail({ id }: { id: number }) {
  const qc = useQueryClient();
  const sum = useQuery<any>({ queryKey: ['project-summary', id], queryFn: () => api(`/api/projects/${id}/summary`) });
  const ts = useQuery<any>({ queryKey: ['project-ts', id], queryFn: () => api(`/api/projects/${id}/timesheets`) });
  const [tf, setTf] = useState({ emp_code: '', hours: '', cost_rate: '', billable: true });
  const [ef, setEf] = useState({ description: '', amount: '', markup_pct: '' });
  const [mf, setMf] = useState({ name: '', amount: '' });
  const [msg, setMsg] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['project-summary', id] }); qc.invalidateQueries({ queryKey: ['project-ts', id] }); };
  const logTs = useMutation({ mutationFn: () => api('/api/projects/timesheets', { method: 'POST', body: JSON.stringify({ project_id: id, emp_code: tf.emp_code || undefined, hours: Number(tf.hours), cost_rate: tf.cost_rate ? Number(tf.cost_rate) : undefined, billable: tf.billable }) }), onSuccess: () => { setMsg('✅ ลงเวลาแล้ว'); setTf({ emp_code: '', hours: '', cost_rate: '', billable: true }); refresh(); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });
  const logExp = useMutation({ mutationFn: () => api('/api/projects/expenses', { method: 'POST', body: JSON.stringify({ project_id: id, description: ef.description, amount: Number(ef.amount), markup_pct: ef.markup_pct ? Number(ef.markup_pct) : undefined }) }), onSuccess: () => { setMsg('✅ บันทึกค่าใช้จ่าย'); setEf({ description: '', amount: '', markup_pct: '' }); refresh(); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });
  const addMs = useMutation({ mutationFn: () => api('/api/projects/milestones', { method: 'POST', body: JSON.stringify({ project_id: id, name: mf.name, amount: Number(mf.amount) }) }), onSuccess: () => { setMsg('✅ เพิ่มงวดงาน'); setMf({ name: '', amount: '' }); refresh(); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });
  const billTm = useMutation({ mutationFn: () => api(`/api/projects/${id}/bill-tm`, { method: 'POST' }), onSuccess: (r: any) => { setMsg(`✅ ตั้งเบิก T&M ${r.invoice_no} · ${baht(r.amount)}`); refresh(); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });
  const billMs = useMutation({ mutationFn: (msId: number) => api(`/api/projects/milestones/${msId}/bill`, { method: 'POST' }), onSuccess: () => { setMsg('✅ ตั้งเบิกงวดงานแล้ว'); refresh(); }, onError: (e: any) => setMsg(`❌ ${e.message}`) });
  const d = sum.data;
  return (
    <div className="space-y-4">
      <StateView q={sum}>
        {d && (
          <Card className="gap-3 p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">{d.project.code} · {d.project.name}</h3>
              <Button size="sm" onClick={() => billTm.mutate()}><Receipt className="size-4" /> ตั้งเบิก T&M</Button>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[['ชั่วโมง', d.hours], ['ต้นทุนจริง', baht(d.actual_cost)], ['ตั้งเบิกแล้ว', baht(d.billed)], ['กำไร', baht(d.margin)], ['ยังไม่เบิก', baht(d.unbilled)], ['งบต้นทุน', baht(d.cost_budget)], ['ใช้งบ %', d.cost_used_pct != null ? `${d.cost_used_pct}%` : '—']].map(([k, v]) => (
                <div key={k as string} className="rounded-md border p-3"><div className="text-xs text-muted-foreground">{k}</div><div className="text-lg font-semibold tabular">{v}</div></div>
              ))}
            </div>
            {d.milestones?.length > 0 && (
              <DataTable rows={d.milestones} columns={[
                { key: 'name', label: 'งวดงาน' }, { key: 'amount', label: 'ยอด', align: 'right', render: (r: any) => baht(r.amount) },
                { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status === 'Billed' ? 'paid' : 'open')}>{r.status}</Badge> },
                { key: 'act', label: '', render: (r: any) => r.status !== 'Billed' ? <Button size="sm" variant="outline" onClick={() => billMs.mutate(r.id)}>ตั้งเบิก</Button> : null },
              ]} />
            )}
            <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
          </Card>
        )}
      </StateView>
      <Card className="gap-3 p-5">
        <h3 className="text-sm font-semibold text-muted-foreground">บันทึกข้อมูล</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Clock className="size-4 text-muted-foreground" />
          <Input className="max-w-[120px]" placeholder="รหัสพนง." value={tf.emp_code} onChange={(e) => setTf({ ...tf, emp_code: e.target.value })} />
          <Input className="max-w-[90px]" type="number" placeholder="ชม." value={tf.hours} onChange={(e) => setTf({ ...tf, hours: e.target.value })} />
          <Input className="max-w-[110px]" type="number" placeholder="ต้นทุน/ชม." value={tf.cost_rate} onChange={(e) => setTf({ ...tf, cost_rate: e.target.value })} />
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={tf.billable} onChange={(e) => setTf({ ...tf, billable: e.target.checked })} /> เบิกได้</label>
          <Button size="sm" disabled={!tf.hours || logTs.isPending} onClick={() => logTs.mutate()}>ลงเวลา</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Receipt className="size-4 text-muted-foreground" />
          <Input className="max-w-[160px]" placeholder="ค่าใช้จ่าย" value={ef.description} onChange={(e) => setEf({ ...ef, description: e.target.value })} />
          <Input className="max-w-[100px]" type="number" placeholder="จำนวน" value={ef.amount} onChange={(e) => setEf({ ...ef, amount: e.target.value })} />
          <Input className="max-w-[100px]" type="number" placeholder="มาร์กอัป %" value={ef.markup_pct} onChange={(e) => setEf({ ...ef, markup_pct: e.target.value })} />
          <Button size="sm" disabled={!ef.amount || logExp.isPending} onClick={() => logExp.mutate()}>บันทึก</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Plus className="size-4 text-muted-foreground" />
          <Input className="max-w-[180px]" placeholder="งวดงาน" value={mf.name} onChange={(e) => setMf({ ...mf, name: e.target.value })} />
          <Input className="max-w-[110px]" type="number" placeholder="ยอด" value={mf.amount} onChange={(e) => setMf({ ...mf, amount: e.target.value })} />
          <Button size="sm" disabled={!mf.name || !mf.amount || addMs.isPending} onClick={() => addMs.mutate()}>เพิ่มงวดงาน</Button>
        </div>
      </Card>
      <StateView q={ts}>
        {ts.data && <DataTable rows={ts.data.timesheets} columns={[
          { key: 'emp_code', label: 'พนง.' }, { key: 'work_date', label: 'วันที่' }, { key: 'hours', label: 'ชม.', align: 'right' },
          { key: 'amount', label: 'มูลค่าเบิก', align: 'right', render: (r: any) => baht(r.amount) },
          { key: 'cost', label: 'ต้นทุน', align: 'right', render: (r: any) => baht(r.cost) },
          { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status === 'Billed' ? 'paid' : 'open')}>{r.status}</Badge> },
        ]} emptyText="ยังไม่มีการลงเวลา" />}
      </StateView>
    </div>
  );
}
