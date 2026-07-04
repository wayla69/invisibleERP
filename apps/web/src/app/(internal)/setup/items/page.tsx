'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Boxes, Search, Save } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Profile = {
  item_id: string; item_description?: string; category?: string; category_id?: number | null;
  revenue_account?: string; cogs_account?: string; inventory_account?: string; valuation_account?: string;
  vat_code?: string; wht_income_type?: string; default_location_id?: string;
};

// ตั้งค่าบัญชีสินค้า — per-item posting-profile override (docs/33, GL-21). An item's own accounts take
// precedence over its category; leave a field blank to inherit the category / standard control account.
export default function ItemPostingSetupPage() {
  const [search, setSearch] = useState('');
  const [itemId, setItemId] = useState('');
  const [form, setForm] = useState<Profile | null>(null);
  const cats = useQuery<any>({ queryKey: ['item-categories'], queryFn: () => api('/api/item-setup/categories') });

  const load = useMutation({
    mutationFn: (id: string) => api<Profile>(`/api/item-setup/items/${encodeURIComponent(id)}`),
    onSuccess: (r) => { setForm(r); setItemId(r.item_id); },
    onError: (e: any) => { setForm(null); notifyError(e.message); },
  });
  const set = (k: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => f && ({ ...f, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      const p: any = { category_id: form!.category_id ?? null };
      for (const k of ['revenue_account', 'cogs_account', 'inventory_account', 'valuation_account', 'vat_code', 'wht_income_type', 'default_location_id'] as const) p[k] = (form as any)[k] ? (form as any)[k] : null;
      return api(`/api/item-setup/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', body: JSON.stringify(p) });
    },
    onSuccess: (r: any) => { setForm(r); notifySuccess(`บันทึกบัญชีสินค้า ${r.item_id}`); },
    onError: (e: any) => notifyError(e.message),
  });

  const categories = cats.data?.categories ?? [];

  return (
    <div>
      <PageHeader title="ตั้งค่าบัญชีสินค้า (Item Posting Setup)" description="ผูกสินค้าเข้ากับหมวด และกำหนดบัญชี GL / รหัสภาษีเฉพาะรายสินค้า (มีผลเหนือระดับหมวด) — เว้นว่างไว้เพื่อสืบทอดจากหมวดหรือบัญชีคุมมาตรฐาน" />
      <div className="space-y-5">
        <Card className="max-w-2xl gap-4 p-5">
          <h3 className="text-base font-semibold">ค้นหาสินค้า</h3>
          <div className="flex gap-2">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="รหัสสินค้า เช่น SUGAR" onKeyDown={(e) => { if (e.key === 'Enter' && search.trim()) load.mutate(search.trim()); }} />
            <Button disabled={!search.trim() || load.isPending} onClick={() => load.mutate(search.trim())}><Search className="size-4" /> ค้นหา</Button>
          </div>
        </Card>

        {form && (
          <Card className="max-w-4xl gap-4 p-5">
            <div>
              <h3 className="text-base font-semibold">{form.item_id} — {form.item_description || '—'}</h3>
              <p className="text-sm text-muted-foreground">หมวด (ข้อความเดิม): {form.category || '—'}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label>หมวดสินค้า</Label>
                <Select value={form.category_id != null ? String(form.category_id) : 'none'} onValueChange={(v) => setForm((f) => f && ({ ...f, category_id: v === 'none' ? null : Number(v) }))}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="ไม่ผูกหมวด" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— ไม่ผูกหมวด —</SelectItem>
                    {categories.map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{c.code} — {c.name_th || c.name || ''}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Field label="บัญชีรายได้"><Input value={form.revenue_account ?? ''} onChange={set('revenue_account')} placeholder="สืบทอดจากหมวด" /></Field>
              <Field label="บัญชีต้นทุนขาย (COGS)"><Input value={form.cogs_account ?? ''} onChange={set('cogs_account')} placeholder="สืบทอด / 5000" /></Field>
              <Field label="บัญชีสินค้าคงคลัง"><Input value={form.inventory_account ?? ''} onChange={set('inventory_account')} placeholder="สืบทอด / 1200" /></Field>
              <Field label="บัญชีมูลค่า"><Input value={form.valuation_account ?? ''} onChange={set('valuation_account')} placeholder="เว้นว่างได้" /></Field>
              <Field label="รหัส VAT"><Input value={form.vat_code ?? ''} onChange={set('vat_code')} placeholder="VAT7" /></Field>
              <Field label="ประเภทเงินได้ (หัก ณ ที่จ่าย)"><Input value={form.wht_income_type ?? ''} onChange={set('wht_income_type')} placeholder="เช่น 40(7-8)" /></Field>
              <Field label="คลังปริยาย"><Input value={form.default_location_id ?? ''} onChange={set('default_location_id')} placeholder="WH-MAIN" /></Field>
            </div>
            <div>
              <Button disabled={save.isPending} onClick={() => save.mutate()}><Save className="size-4" /> {save.isPending ? 'กำลังบันทึก…' : 'บันทึกบัญชีสินค้า'}</Button>
            </div>
          </Card>
        )}

        {!form && !load.isPending && (
          <Card className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <Boxes className="size-8 opacity-40" />
            ค้นหารหัสสินค้าด้านบนเพื่อกำหนดบัญชี GL / ภาษีรายสินค้า
          </Card>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-2"><Label>{label}</Label>{children}</div>;
}
