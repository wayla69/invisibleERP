'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PieChart, Plus, TrendingUp, TrendingDown, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const startOfYear = () => `${new Date().getFullYear()}-01-01`;
const today = () => new Date().toISOString().slice(0, 10);

const CC_TYPES = [
  { value: 'department', label: 'แผนก (Department)' },
  { value: 'branch', label: 'สาขา (Branch)' },
  { value: 'project', label: 'โครงการ (Project)' },
] as const;
const typeLabel = (t: string) => CC_TYPES.find((x) => x.value === t)?.label ?? t;

// ศูนย์ต้นทุน / มิติบัญชี — master (create/list) + per-cost-centre dimensional P&L over the GL.
export default function CostCentersPage() {
  return (
    <div>
      <PageHeader
        title="ศูนย์ต้นทุน & กำไร-ขาดทุนตามมิติ (Cost Centres)"
        description="กำหนดศูนย์ต้นทุน (แผนก / สาขา / โครงการ) และดูงบกำไร-ขาดทุนแยกตามมิติที่เลือกในช่วงเวลาที่กำหนด"
      />
      <Tabs
        urlParam="tab"
        tabs={[
          { key: 'master', label: 'ศูนย์ต้นทุน (Master)', content: <Master /> },
          { key: 'pl', label: 'กำไร-ขาดทุนตามมิติ', content: <DimensionalPL /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── cost-centre master: create + list ─────────────────────────
function Master() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['cost-centers'], queryFn: () => api('/api/ledger/cost-centers') });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('department');
  const [parentCode, setParentCode] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api<any>('/api/ledger/cost-centers', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim(), name: name.trim(), type, ...(parentCode.trim() ? { parent_code: parentCode.trim() } : {}) }),
      }),
    onSuccess: (r) => {
      notifySuccess(`เพิ่มศูนย์ต้นทุน ${r.code} — ${r.name}`);
      setCode('');
      setName('');
      setParentCode('');
      qc.invalidateQueries({ queryKey: ['cost-centers'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4 p-5">
        <h3 className="text-base font-semibold">เพิ่มศูนย์ต้นทุน</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="cc-code">รหัส</Label>
            <Input id="cc-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="เช่น SALES-01" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cc-name">ชื่อ</Label>
            <Input id="cc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น ฝ่ายขาย" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cc-type">ประเภท</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="cc-type" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CC_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cc-parent">รหัสศูนย์ต้นทุนแม่ (ถ้ามี)</Label>
            <Input id="cc-parent" value={parentCode} onChange={(e) => setParentCode(e.target.value)} placeholder="เว้นว่างได้" />
          </div>
        </div>
        <div>
          <Button disabled={create.isPending || !code.trim() || !name.trim()} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? 'กำลังบันทึก…' : 'เพิ่มศูนย์ต้นทุน'}
          </Button>
        </div>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <StatCard label="จำนวนศูนย์ต้นทุน" value={q.data.count ?? 0} icon={PieChart} tone="primary" className="max-w-xs" />
            <DataTable
              rows={q.data.cost_centers ?? []}
              rowKey={(r: any) => r.id}
              columns={[
                { key: 'code', label: 'รหัส' },
                { key: 'name', label: 'ชื่อ' },
                { key: 'type', label: 'ประเภท', render: (r: any) => typeLabel(r.type) },
                { key: 'parent_code', label: 'ศูนย์ต้นทุนแม่', render: (r: any) => r.parent_code ?? '—' },
                { key: 'active', label: 'สถานะ', render: (r: any) => <Badge variant={r.active === false ? 'destructive' : 'success'}>{r.active === false ? 'ปิดใช้งาน' : 'ใช้งาน'}</Badge> },
              ]}
              emptyState={{
                icon: PieChart,
                title: 'ยังไม่มีศูนย์ต้นทุน',
                description: 'กรอกรหัสและชื่อด้านบนเพื่อเพิ่มศูนย์ต้นทุน (แผนก / สาขา / โครงการ) รายการแรก',
              }}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── dimensional P&L (pick cost centre + date range) ─────────────────────────
function DimensionalPL() {
  const centers = useQuery<any>({ queryKey: ['cost-centers'], queryFn: () => api('/api/ledger/cost-centers') });

  const [code, setCode] = useState('');
  const [from, setFrom] = useState(startOfYear());
  const [to, setTo] = useState(today());

  const pl = useQuery<any>({
    queryKey: ['cost-center-pl', code, from, to],
    queryFn: () => api(`/api/ledger/cost-centers/${encodeURIComponent(code)}/pl?from=${from}&to=${to}`),
    enabled: !!code && !!from && !!to,
  });

  const list = centers.data?.cost_centers ?? [];

  return (
    <div className="space-y-5">
      <Card className="gap-4 p-5">
        <h3 className="text-base font-semibold">เลือกมิติและช่วงเวลา</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="pl-cc">ศูนย์ต้นทุน</Label>
            <Select value={code} onValueChange={setCode}>
              <SelectTrigger id="pl-cc" className="w-full">
                <SelectValue placeholder={list.length ? 'เลือกศูนย์ต้นทุน' : 'ยังไม่มีศูนย์ต้นทุน'} />
              </SelectTrigger>
              <SelectContent>
                {list.map((c: any) => <SelectItem key={c.id} value={c.code}>{c.code} — {c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pl-from">ตั้งแต่วันที่</Label>
            <Input id="pl-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pl-to">ถึงวันที่</Label>
            <Input id="pl-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      </Card>

      {!code ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          เลือกศูนย์ต้นทุนด้านบนเพื่อดูงบกำไร-ขาดทุนตามมิติ
        </Card>
      ) : (
        <StateView q={pl}>
          {pl.data && (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-3">
                <StatCard label="รายได้" value={baht(pl.data.revenue)} icon={TrendingUp} tone="success" />
                <StatCard label="ค่าใช้จ่าย" value={baht(pl.data.expense)} icon={TrendingDown} tone="danger" />
                <StatCard label="กำไร (ขาดทุน) สุทธิ" value={baht(pl.data.net_income)} icon={Wallet} tone={Number(pl.data.net_income) >= 0 ? 'primary' : 'danger'} />
              </div>
              <DataTable
                rows={pl.data.lines ?? []}
                rowKey={(r: any) => r.account_code}
                columns={[
                  { key: 'account_code', label: 'รหัสบัญชี' },
                  { key: 'account_name', label: 'ชื่อบัญชี', render: (r: any) => r.account_name ?? '—' },
                  { key: 'account_type', label: 'ประเภท', render: (r: any) => <Badge variant={r.account_type === 'Revenue' ? 'success' : 'warning'}>{r.account_type === 'Revenue' ? 'รายได้' : 'ค่าใช้จ่าย'}</Badge> },
                  { key: 'debit', label: 'เดบิต', align: 'right', render: (r: any) => <span className="tabular">{baht(r.debit)}</span> },
                  { key: 'credit', label: 'เครดิต', align: 'right', render: (r: any) => <span className="tabular">{baht(r.credit)}</span> },
                  {
                    key: 'net', label: 'สุทธิ', align: 'right', sortable: false,
                    render: (r: any) => {
                      const net = r.account_type === 'Revenue' ? Number(r.credit) - Number(r.debit) : Number(r.debit) - Number(r.credit);
                      return <span className="tabular">{baht(net)}</span>;
                    },
                  },
                ]}
                emptyState={{
                  icon: PieChart,
                  title: 'ไม่มีรายการรายได้หรือค่าใช้จ่าย',
                  description: 'ศูนย์ต้นทุนนี้ยังไม่มีรายการในช่วงเวลาที่เลือก',
                }}
              />
            </div>
          )}
        </StateView>
      )}
    </div>
  );
}
