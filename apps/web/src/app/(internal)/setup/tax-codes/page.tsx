'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Coins, Plus, Save, X } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Tax = {
  code: string; name?: string; name_th?: string; kind?: 'vat' | 'wht'; rate?: number;
  output_account?: string; input_account?: string; wht_account?: string; wht_income_type?: string;
  inclusive?: boolean; active?: boolean;
};
const BLANK: Tax = { code: '', kind: 'vat', rate: 0, active: true };

// รหัสภาษี — VAT + WHT tax-code master (rate + GL accounts). The configurable tax surface behind item posting
// determination (docs/33, GL-21) replacing the single tenant vat_rate column.
export default function TaxCodesPage() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['tax-codes'], queryFn: () => api('/api/item-setup/tax-codes') });
  const [form, setForm] = useState<Tax>(BLANK);
  const [ratePct, setRatePct] = useState('0');
  const [editing, setEditing] = useState(false);
  const set = (k: keyof Tax) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const reset = () => { setForm(BLANK); setRatePct('0'); setEditing(false); };
  const payload = () => {
    const p: any = { code: form.code.trim(), kind: form.kind, rate: (Number(ratePct) || 0) / 100 };
    for (const k of ['name', 'name_th', 'output_account', 'input_account', 'wht_account', 'wht_income_type'] as const) p[k] = (form as any)[k] ? (form as any)[k] : null;
    p.inclusive = !!form.inclusive; p.active = form.active !== false; return p;
  };
  const save = useMutation({
    mutationFn: () => editing
      ? api(`/api/item-setup/tax-codes/${encodeURIComponent(form.code.trim())}`, { method: 'PATCH', body: JSON.stringify(payload()) })
      : api('/api/item-setup/tax-codes', { method: 'POST', body: JSON.stringify(payload()) }),
    onSuccess: (r: any) => { notifySuccess(`บันทึกรหัสภาษี ${r.code}`); reset(); qc.invalidateQueries({ queryKey: ['tax-codes'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const edit = (t: Tax) => { setForm({ ...BLANK, ...t }); setRatePct(String(((t.rate ?? 0) * 100).toFixed(2)).replace(/\.00$/, '')); setEditing(true); };

  return (
    <div>
      <PageHeader title="รหัสภาษี (VAT / หัก ณ ที่จ่าย)" description="กำหนดรหัสภาษีมูลค่าเพิ่มและภาษีหัก ณ ที่จ่าย พร้อมอัตราและบัญชี GL — ใช้ผูกกับสินค้า/หมวดเพื่อคำนวณและลงบัญชีภาษีอัตโนมัติ" />
      <div className="space-y-5">
        <Card className="max-w-4xl gap-4 p-5">
          <h3 className="text-base font-semibold">{editing ? `แก้ไขรหัสภาษี ${form.code}` : 'เพิ่มรหัสภาษี'}</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="รหัส"><Input value={form.code} onChange={set('code')} disabled={editing} placeholder="เช่น VAT7 / WHT3" /></Field>
            <Field label="ชนิด">
              <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v as 'vat' | 'wht' }))}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="vat">ภาษีมูลค่าเพิ่ม (VAT)</SelectItem>
                  <SelectItem value="wht">หัก ณ ที่จ่าย (WHT)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="อัตรา (%)"><Input type="number" value={ratePct} onChange={(e) => setRatePct(e.target.value)} placeholder="7" /></Field>
            <Field label="ชื่อ (EN)"><Input value={form.name ?? ''} onChange={set('name')} placeholder="VAT 7%" /></Field>
            <Field label="ชื่อ (TH)"><Input value={form.name_th ?? ''} onChange={set('name_th')} placeholder="ภาษีมูลค่าเพิ่ม 7%" /></Field>
            {form.kind === 'vat' ? (
              <>
                <Field label="บัญชี VAT ขาย (Output)"><Input value={form.output_account ?? ''} onChange={set('output_account')} placeholder="2100" /></Field>
                <Field label="บัญชี VAT ซื้อ (Input)"><Input value={form.input_account ?? ''} onChange={set('input_account')} placeholder="2100" /></Field>
              </>
            ) : (
              <>
                <Field label="บัญชีภาษีหัก ณ ที่จ่าย"><Input value={form.wht_account ?? ''} onChange={set('wht_account')} placeholder="2361" /></Field>
                <Field label="ประเภทเงินได้"><Input value={form.wht_income_type ?? ''} onChange={set('wht_income_type')} placeholder="เช่น 40(7-8)" /></Field>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button disabled={save.isPending || !form.code.trim()} onClick={() => save.mutate()}>
              {editing ? <Save className="size-4" /> : <Plus className="size-4" />} {save.isPending ? 'กำลังบันทึก…' : editing ? 'บันทึกการแก้ไข' : 'เพิ่มรหัสภาษี'}
            </Button>
            {editing && <Button variant="outline" onClick={reset}><X className="size-4" /> ยกเลิก</Button>}
          </div>
        </Card>

        <StateView q={q}>
          {q.data && (
            <div className="space-y-5">
              <StatCard label="จำนวนรหัสภาษี" value={q.data.count ?? 0} icon={Coins} tone="primary" className="max-w-xs" />
              <DataTable
                rows={q.data.tax_codes ?? []}
                rowKey={(r: Tax) => r.code}
                onRowClick={(r: Tax) => edit(r)}
                columns={[
                  { key: 'code', label: 'รหัส' },
                  { key: 'kind', label: 'ชนิด', render: (r: Tax) => <Badge variant={r.kind === 'wht' ? 'warning' : 'success'}>{r.kind === 'wht' ? 'หัก ณ ที่จ่าย' : 'VAT'}</Badge> },
                  { key: 'rate', label: 'อัตรา', align: 'right', render: (r: Tax) => `${((r.rate ?? 0) * 100).toFixed(2).replace(/\.00$/, '')}%` },
                  { key: 'name', label: 'ชื่อ', render: (r: Tax) => r.name_th || r.name || '—' },
                  { key: 'acct', label: 'บัญชี', sortable: false, render: (r: Tax) => r.kind === 'wht' ? (r.wht_account ?? '—') : `${r.output_account ?? '—'} / ${r.input_account ?? '—'}` },
                  { key: 'active', label: 'สถานะ', render: (r: Tax) => <Badge variant={r.active === false ? 'destructive' : 'success'}>{r.active === false ? 'ปิด' : 'ใช้งาน'}</Badge> },
                ]}
                emptyState={{ icon: Coins, title: 'ยังไม่มีรหัสภาษี', description: 'เพิ่มรหัส VAT7 (7%) หรือรหัสหัก ณ ที่จ่ายด้านบน' }}
              />
            </div>
          )}
        </StateView>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-2"><Label>{label}</Label>{children}</div>;
}
