'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Send, Trophy, X, Rocket } from 'lucide-react';
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

// Tender / estimating → award (docs/35 P3, PROJ-17). Build a priced estimate, track win/loss, and on a win
// award it — which seeds a project + a draft BoQ from the winning bid.
const tone: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = { estimating: 'secondary', submitted: 'outline', won: 'default', lost: 'destructive' };

export default function TendersPage() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['tenders'], queryFn: () => api('/api/tenders') });
  const [f, setF] = useState({ title: '', customer_name: '', project_code: '', markup_pct: '20', description: '', qty: '', unit_cost: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['tenders'] });

  const create = useMutation({
    mutationFn: () => api('/api/tenders', { method: 'POST', body: JSON.stringify({
      title: f.title, customer_name: f.customer_name || undefined, project_code: f.project_code || undefined, markup_pct: Number(f.markup_pct) || 0,
      lines: f.qty ? [{ description: f.description || undefined, qty: Number(f.qty), unit_cost: Number(f.unit_cost) || 0 }] : [],
    }) }),
    onSuccess: () => { notifySuccess('สร้างใบประมูลแล้ว'); setF({ title: '', customer_name: '', project_code: '', markup_pct: '20', description: '', qty: '', unit_cost: '' }); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const act = useMutation({
    mutationFn: (v: { no: string; path: string; body?: any }) => api(`/api/tenders/${v.no}/${v.path}`, { method: 'POST', body: JSON.stringify(v.body ?? {}) }),
    onSuccess: (_d, v) => { notifySuccess(v.path === 'award' ? 'มอบงาน → สร้างโครงการ + BoQ (ร่าง)' : 'อัปเดตแล้ว'); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const d = q.data;
  return (
    <div>
      <PageHeader title="ประมูลงาน (Tenders)" description="ประเมินราคา → ยื่นซอง → ชนะ/แพ้ → มอบงาน (สร้างโครงการ + BoQ ร่าง)" />
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard label="ใบประมูลทั้งหมด" value={d?.count ?? '—'} />
        <StatCard label="อัตราชนะ (Win rate)" value={d ? `${d.win_rate_pct}%` : '—'} />
        <StatCard label="มูลค่าเสนอราคาที่รอผล" value={baht(d?.pipeline_bid_value ?? 0)} />
      </div>

      <Card className="mb-5 gap-3 p-5">
        <h3 className="text-base font-semibold">สร้างใบประมูล + ประเมินราคา</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-1.5"><Label>ชื่องาน</Label><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="อาคารสำนักงาน 3 ชั้น" /></div>
          <div className="grid gap-1.5"><Label>ลูกค้า</Label><Input value={f.customer_name} onChange={(e) => setF({ ...f, customer_name: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>รหัสโครงการ (เมื่อมอบงาน)</Label><Input value={f.project_code} onChange={(e) => setF({ ...f, project_code: e.target.value })} placeholder="PRJ-…" /></div>
          <div className="grid gap-1.5"><Label>Markup %</Label><Input type="number" min="0" value={f.markup_pct} onChange={(e) => setF({ ...f, markup_pct: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>รายการ (คำอธิบาย)</Label><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="ฐานราก" /></div>
          <div className="grid gap-1.5"><Label>จำนวน</Label><Input type="number" min="0" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>ต้นทุน/หน่วย</Label><Input type="number" min="0" value={f.unit_cost} onChange={(e) => setF({ ...f, unit_cost: e.target.value })} /></div>
        </div>
        <div><Button onClick={() => create.mutate()} disabled={!f.title || create.isPending}><Plus className="size-4" /> สร้างใบประมูล</Button></div>
      </Card>

      <StateView q={q}>{d && (
        <DataTable
          rows={d.tenders ?? []}
          rowKey={(r: any) => r.tender_no}
          columns={[
            { key: 'tender_no', label: 'เลขที่' },
            { key: 'title', label: 'ชื่องาน' },
            { key: 'customer_name', label: 'ลูกค้า' },
            { key: 'estimated_cost', label: 'ต้นทุนประเมิน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.estimated_cost)}</span> },
            { key: 'bid_price', label: 'ราคาเสนอ', align: 'right', render: (r: any) => <span className="tabular">{baht(r.bid_price)}</span> },
            { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={tone[r.status] ?? 'secondary'}>{r.status}</Badge> },
            { key: 'awarded_project_code', label: 'โครงการ', render: (r: any) => r.awarded_project_code ?? '—' },
            { key: 'actions', label: '', align: 'right', render: (r: any) => (
              <div className="flex justify-end gap-1.5">
                {r.status === 'estimating' && <Button size="sm" variant="outline" onClick={() => act.mutate({ no: r.tender_no, path: 'submit' })}><Send className="size-3.5" /> ยื่น</Button>}
                {(r.status === 'estimating' || r.status === 'submitted') && <Button size="sm" variant="outline" onClick={() => act.mutate({ no: r.tender_no, path: 'outcome', body: { outcome: 'won' } })}><Trophy className="size-3.5" /> ชนะ</Button>}
                {(r.status === 'estimating' || r.status === 'submitted') && <Button size="sm" variant="ghost" onClick={() => { const reason = prompt('เหตุผลที่แพ้'); if (reason) act.mutate({ no: r.tender_no, path: 'outcome', body: { outcome: 'lost', reason } }); }}><X className="size-3.5" /> แพ้</Button>}
                {r.status === 'won' && !r.awarded_project_code && <Button size="sm" onClick={() => act.mutate({ no: r.tender_no, path: 'award' })}><Rocket className="size-3.5" /> มอบงาน</Button>}
              </div>
            ) },
          ]}
        />
      )}</StateView>
    </div>
  );
}
