'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderKanban, Plus, Clock, Receipt } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

type Project = {
  project_code: string; name: string; customer_name: string | null; billing_type: string; status: string;
  contract_amount: number; cost_to_date: number; billed_to_date: number; wip: number; margin: number;
  non_billable_cost: number; total_cost: number;
};
const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function ProjectsPage() {
  const qc = useQueryClient();
  const q = useQuery<{ projects: Project[]; count: number }>({ queryKey: ['projects'], queryFn: () => api('/api/projects') });
  const [f, setF] = useState({ project_code: '', name: '', customer_name: '', billing_type: 'TM', contract_amount: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['projects'] });

  const create = useMutation({
    mutationFn: () => api<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name: f.name, project_code: f.project_code || undefined, customer_name: f.customer_name || undefined, billing_type: f.billing_type, contract_amount: Number(f.contract_amount) || 0 }) }),
    onSuccess: (r) => { notifySuccess(`สร้างโครงการ ${r.project_code}`); setF({ project_code: '', name: '', customer_name: '', billing_type: 'TM', contract_amount: '' }); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  // cost / bill dialog
  const [dlg, setDlg] = useState<{ mode: 'cost' | 'bill'; code: string } | null>(null);
  const [amount, setAmount] = useState('');
  const [ctype, setCtype] = useState<'time' | 'expense'>('time');
  const [billable, setBillable] = useState(true);
  const openDlg = (mode: 'cost' | 'bill', code: string) => { setDlg({ mode, code }); setAmount(''); setCtype('time'); setBillable(true); };
  const submit = useMutation({
    mutationFn: () => api<any>(`/api/projects/${dlg!.code}/${dlg!.mode}`, { method: 'POST', body: JSON.stringify(dlg!.mode === 'cost' ? { entry_type: ctype, amount: Number(amount) || 0, billable } : { amount: Number(amount) || 0 }) }),
    onSuccess: (r) => { notifySuccess(dlg!.mode === 'cost' ? `บันทึกต้นทุน (รวม ${baht(r.cost_to_date)})` : `วางบิล — กำไร ${baht(r.margin)} (${r.entry_no})`); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const projects = q.data?.projects ?? [];
  const wip = projects.reduce((a, p) => a + p.wip, 0);
  const margin = projects.reduce((a, p) => a + p.margin, 0);

  return (
    <div>
      <PageHeader title="โครงการ (Projects)" description="บัญชีโครงการ · ลงต้นทุน→งานระหว่างทำ (WIP) · วางบิล→รับรู้รายได้+ตัดต้นทุน · ลงบัญชีอัตโนมัติ" />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard label="โครงการ" value={q.data?.count ?? 0} icon={FolderKanban} tone="primary" />
        <StatCard label="ต้นทุนค้างรับรู้ (WIP)" value={baht(wip)} tone="primary" />
        <StatCard label="กำไรสะสม" value={baht(margin)} tone="primary" />
      </div>

      <Card className="mb-5 gap-3 p-5">
        <h3 className="text-base font-semibold">สร้างโครงการ</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="grid gap-1.5"><Label>ชื่อโครงการ</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>รหัส (ถ้าเว้นว่างจะสร้างให้)</Label><Input value={f.project_code} onChange={(e) => setF({ ...f, project_code: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>ลูกค้า</Label><Input value={f.customer_name} onChange={(e) => setF({ ...f, customer_name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>รูปแบบ</Label>
            <select className={selectCls} value={f.billing_type} onChange={(e) => setF({ ...f, billing_type: e.target.value })}>
              <option value="TM">ตามเวลา/วัสดุ (T&M)</option>
              <option value="Fixed">เหมารวม (Fixed)</option>
            </select>
          </div>
          <div className="grid gap-1.5"><Label>มูลค่าสัญญา</Label><Input type="number" min="0" value={f.contract_amount} onChange={(e) => setF({ ...f, contract_amount: e.target.value })} /></div>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={() => create.mutate()} disabled={!f.name || create.isPending}><Plus className="size-4" /> สร้าง</Button>
        </div>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={projects}
            columns={[
              { key: 'project_code', label: 'รหัส' },
              { key: 'name', label: 'โครงการ', render: (r: Project) => `${r.name}${r.customer_name ? ` · ${r.customer_name}` : ''}` },
              { key: 'billing_type', label: 'รูปแบบ' },
              { key: 'cost_to_date', label: 'ต้นทุนสะสม', align: 'right', render: (r: Project) => <span className="tabular">{baht(r.cost_to_date)}</span> },
              { key: 'billed_to_date', label: 'วางบิลแล้ว', align: 'right', render: (r: Project) => <span className="tabular">{baht(r.billed_to_date)}</span> },
              { key: 'wip', label: 'WIP', align: 'right', render: (r: Project) => <span className="tabular">{baht(r.wip)}</span> },
              { key: 'non_billable_cost', label: 'เบิกลูกค้าไม่ได้', align: 'right', render: (r: Project) => <span className={`tabular ${r.non_billable_cost > 0 ? 'text-destructive' : 'text-muted-foreground'}`} title="ต้นทุนที่เบิกลูกค้าไม่ได้ — ลงเป็นค่าใช้จ่ายทันที (5800) ไม่เข้า WIP">{baht(r.non_billable_cost)}</span> },
              { key: 'margin', label: 'กำไร', align: 'right', render: (r: Project) => <span className={`tabular ${r.margin < 0 ? 'text-destructive' : ''}`}>{baht(r.margin)}</span> },
              { key: 'status', label: 'สถานะ', render: (r: Project) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              {
                key: 'action', label: 'ดำเนินการ', sortable: false,
                render: (r: Project) => (
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" title="ลงต้นทุน" onClick={() => openDlg('cost', r.project_code)}><Clock className="size-4" /></Button>
                    <Button variant="ghost" size="sm" title="วางบิล" onClick={() => openDlg('bill', r.project_code)}><Receipt className="size-4" /></Button>
                  </div>
                ),
              },
            ]}
            emptyState={{ icon: FolderKanban, title: 'ยังไม่มีโครงการ', description: 'สร้างโครงการแรกจากแบบฟอร์มด้านบนเพื่อเริ่มลงต้นทุนและวางบิล' }}
          />
        )}
      </StateView>

      <Dialog open={!!dlg} onOpenChange={(o) => !o && setDlg(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dlg?.mode === 'cost' ? 'ลงต้นทุนโครงการ' : 'วางบิลลูกค้า'} — {dlg?.code}</DialogTitle>
            <DialogDescription>{dlg?.mode === 'cost' ? 'ต้นทุนจะเข้างานระหว่างทำ (WIP)' : 'รับรู้รายได้ และตัดต้นทุน WIP เป็นต้นทุนงานบริการ'}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {dlg?.mode === 'cost' && (
              <div className="grid gap-1.5"><Label>ประเภท</Label>
                <select className={selectCls} value={ctype} onChange={(e) => setCtype(e.target.value as 'time' | 'expense')}>
                  <option value="time">ค่าแรง (time)</option>
                  <option value="expense">ค่าใช้จ่าย (expense)</option>
                </select>
              </div>
            )}
            <div className="grid gap-1.5"><Label>จำนวนเงิน</Label><Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
            {dlg?.mode === 'cost' && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
                <span>เบิกลูกค้าได้ (billable)<span className="block text-xs text-muted-foreground">ติ๊กออก = เบิกไม่ได้ → ลงเป็นค่าใช้จ่ายทันที (5800) ไม่เข้า WIP และไม่นำไปวางบิล</span></span>
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDlg(null)}>ปิด</Button>
            <Button onClick={() => submit.mutate()} disabled={!(Number(amount) > 0) || submit.isPending}>{dlg?.mode === 'cost' ? 'บันทึกต้นทุน' : 'วางบิล'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
