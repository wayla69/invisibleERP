'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Boxes, Search, Save } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
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
  const { t } = useLang();
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
    onSuccess: (r: any) => { setForm(r); notifySuccess(t('st.sitm_saved', { item_id: r.item_id })); },
    onError: (e: any) => notifyError(e.message),
  });

  const categories = cats.data?.categories ?? [];

  return (
    <div>
      <PageHeader title={t('st.sitm_title')} description={t('st.sitm_desc')} />
      <div className="space-y-5">
        <Card className="max-w-2xl gap-4 p-5">
          <h3 className="text-base font-semibold">{t('st.sitm_search_heading')}</h3>
          <div className="flex gap-2">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('st.sitm_search_ph')} onKeyDown={(e) => { if (e.key === 'Enter' && search.trim()) load.mutate(search.trim()); }} />
            <Button disabled={!search.trim() || load.isPending} onClick={() => load.mutate(search.trim())}><Search className="size-4" /> {t('st.sitm_search_btn')}</Button>
          </div>
        </Card>

        {form && (
          <Card className="max-w-4xl gap-4 p-5">
            <div>
              <h3 className="text-base font-semibold">{form.item_id} — {form.item_description || '—'}</h3>
              <p className="text-sm text-muted-foreground">{t('st.sitm_category_legacy')}: {form.category || '—'}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label>{t('st.sitm_category')}</Label>
                <Select value={form.category_id != null ? String(form.category_id) : 'none'} onValueChange={(v) => setForm((f) => f && ({ ...f, category_id: v === 'none' ? null : Number(v) }))}>
                  <SelectTrigger className="w-full"><SelectValue placeholder={t('st.sitm_no_category')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('st.sitm_no_category_option')}</SelectItem>
                    {categories.map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{c.code} — {c.name_th || c.name || ''}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Field label={t('st.sitm_revenue')}><Input value={form.revenue_account ?? ''} onChange={set('revenue_account')} placeholder={t('st.sitm_ph_inherit')} /></Field>
              <Field label={t('st.sitm_cogs')}><Input value={form.cogs_account ?? ''} onChange={set('cogs_account')} placeholder={t('st.sitm_ph_inherit_5000')} /></Field>
              <Field label={t('st.sitm_inventory')}><Input value={form.inventory_account ?? ''} onChange={set('inventory_account')} placeholder={t('st.sitm_ph_inherit_1200')} /></Field>
              <Field label={t('st.sitm_valuation')}><Input value={form.valuation_account ?? ''} onChange={set('valuation_account')} placeholder={t('st.sitm_ph_optional')} /></Field>
              <Field label={t('st.sitm_vat')}><Input value={form.vat_code ?? ''} onChange={set('vat_code')} placeholder="VAT7" /></Field>
              <Field label={t('st.sitm_wht')}><Input value={form.wht_income_type ?? ''} onChange={set('wht_income_type')} placeholder={t('st.sitm_ph_wht')} /></Field>
              <Field label={t('st.sitm_location')}><Input value={form.default_location_id ?? ''} onChange={set('default_location_id')} placeholder="WH-MAIN" /></Field>
            </div>
            <div>
              <Button disabled={save.isPending} onClick={() => save.mutate()}><Save className="size-4" /> {save.isPending ? t('st.sitm_saving') : t('st.sitm_save_btn')}</Button>
            </div>
          </Card>
        )}

        {!form && !load.isPending && (
          <Card className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <Boxes className="size-8 opacity-40" />
            {t('st.sitm_prompt')}
          </Card>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-2"><Label>{label}</Label>{children}</div>;
}
