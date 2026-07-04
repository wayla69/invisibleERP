'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Layers, Plus, Save, X } from 'lucide-react';
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

type Cat = {
  code: string; name?: string; name_th?: string;
  revenue_account?: string; cogs_account?: string; inventory_account?: string; valuation_account?: string;
  vat_code?: string; wht_income_type?: string; default_location_id?: string; active?: boolean;
};
const BLANK: Cat = { code: '', active: true };

// หมวดสินค้า — item category master carrying the default GL account-set + tax profile a family of items posts
// to (docs/33, GL-21). The posting engine resolves item → this category → the standard control account.
export default function ItemCategoriesPage() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['item-categories'], queryFn: () => api('/api/item-setup/categories') });
  const [form, setForm] = useState<Cat>(BLANK);
  const [editing, setEditing] = useState(false);
  const set = (k: keyof Cat) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const reset = () => { setForm(BLANK); setEditing(false); };
  const payload = () => {
    const p: any = {}; for (const [k, v] of Object.entries(form)) p[k] = v === '' ? null : v; p.code = form.code.trim(); return p;
  };
  const save = useMutation({
    mutationFn: () => editing
      ? api(`/api/item-setup/categories/${encodeURIComponent(form.code.trim())}`, { method: 'PATCH', body: JSON.stringify(payload()) })
      : api('/api/item-setup/categories', { method: 'POST', body: JSON.stringify(payload()) }),
    onSuccess: (r: any) => { notifySuccess(`บันทึกหมวด ${r.code}`); reset(); qc.invalidateQueries({ queryKey: ['item-categories'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const edit = (c: Cat) => { setForm({ ...BLANK, ...c }); setEditing(true); };

  return (
    <div>
      <PageHeader title="หมวดสินค้า (Item Categories)" description="กำหนดผังบัญชีปริยาย (รายได้ / ต้นทุนขาย / สินค้าคงคลัง / มูลค่า) และรหัสภาษี VAT/หัก ณ ที่จ่าย ต่อกลุ่มสินค้า — เครื่องยนต์บัญชีจะเลือก สินค้า → หมวด → บัญชีคุมมาตรฐาน" />
      <div className="space-y-5">
        <Card className="max-w-4xl gap-4 p-5">
          <h3 className="text-base font-semibold">{editing ? `แก้ไขหมวด ${form.code}` : 'เพิ่มหมวดสินค้า'}</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="รหัส"><Input value={form.code} onChange={set('code')} disabled={editing} placeholder="เช่น BEV" /></Field>
            <Field label="ชื่อ (EN)"><Input value={form.name ?? ''} onChange={set('name')} placeholder="Beverages" /></Field>
            <Field label="ชื่อ (TH)"><Input value={form.name_th ?? ''} onChange={set('name_th')} placeholder="เครื่องดื่ม" /></Field>
            <Field label="บัญชีรายได้"><Input value={form.revenue_account ?? ''} onChange={set('revenue_account')} placeholder="4000" /></Field>
            <Field label="บัญชีต้นทุนขาย (COGS)"><Input value={form.cogs_account ?? ''} onChange={set('cogs_account')} placeholder="5000" /></Field>
            <Field label="บัญชีสินค้าคงคลัง"><Input value={form.inventory_account ?? ''} onChange={set('inventory_account')} placeholder="1200" /></Field>
            <Field label="บัญชีมูลค่า"><Input value={form.valuation_account ?? ''} onChange={set('valuation_account')} placeholder="เว้นว่างได้" /></Field>
            <Field label="รหัส VAT"><Input value={form.vat_code ?? ''} onChange={set('vat_code')} placeholder="VAT7" /></Field>
            <Field label="ประเภทเงินได้ (หัก ณ ที่จ่าย)"><Input value={form.wht_income_type ?? ''} onChange={set('wht_income_type')} placeholder="เช่น 40(7-8)" /></Field>
            <Field label="คลังปริยาย"><Input value={form.default_location_id ?? ''} onChange={set('default_location_id')} placeholder="WH-MAIN" /></Field>
          </div>
          <div className="flex gap-2">
            <Button disabled={save.isPending || !form.code.trim()} onClick={() => save.mutate()}>
              {editing ? <Save className="size-4" /> : <Plus className="size-4" />} {save.isPending ? 'กำลังบันทึก…' : editing ? 'บันทึกการแก้ไข' : 'เพิ่มหมวด'}
            </Button>
            {editing && <Button variant="outline" onClick={reset}><X className="size-4" /> ยกเลิก</Button>}
          </div>
        </Card>

        <StateView q={q}>
          {q.data && (
            <div className="space-y-5">
              <StatCard label="จำนวนหมวด" value={q.data.count ?? 0} icon={Layers} tone="primary" className="max-w-xs" />
              <DataTable
                rows={q.data.categories ?? []}
                rowKey={(r: Cat) => r.code}
                onRowClick={(r: Cat) => edit(r)}
                columns={[
                  { key: 'code', label: 'รหัส' },
                  { key: 'name', label: 'ชื่อ', render: (r: Cat) => r.name_th || r.name || '—' },
                  { key: 'revenue_account', label: 'รายได้', render: (r: Cat) => r.revenue_account ?? '—' },
                  { key: 'cogs_account', label: 'ต้นทุนขาย', render: (r: Cat) => r.cogs_account ?? '—' },
                  { key: 'inventory_account', label: 'สินค้าคงคลัง', render: (r: Cat) => r.inventory_account ?? '—' },
                  { key: 'vat_code', label: 'VAT', render: (r: Cat) => r.vat_code ?? '—' },
                  { key: 'active', label: 'สถานะ', render: (r: Cat) => <Badge variant={r.active === false ? 'destructive' : 'success'}>{r.active === false ? 'ปิด' : 'ใช้งาน'}</Badge> },
                ]}
                emptyState={{ icon: Layers, title: 'ยังไม่มีหมวดสินค้า', description: 'เพิ่มหมวดแรกด้านบนเพื่อกำหนดผังบัญชี/ภาษีปริยายของกลุ่มสินค้า' }}
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
