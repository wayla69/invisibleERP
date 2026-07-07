'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, Search, Save, GitMerge, Copy } from 'lucide-react';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PartyRelationshipsSection } from '@/components/party-relationships';
import { ScheduledChangesSection } from '@/components/scheduled-changes-section';

const ITEM_REL_TYPES = ['substitute', 'complement', 'supersedes', 'kit_component', 'accessory'] as const;

type Profile = {
  item_id: string; item_description?: string; category?: string; category_id?: number | null;
  revenue_account?: string; cogs_account?: string; inventory_account?: string; valuation_account?: string;
  vat_code?: string; wht_income_type?: string; default_location_id?: string;
  barcode?: string | null; uom?: string | null; base_uom?: string | null; conversion_factor?: number | null;
  unit_price?: number | null; temperature_type?: string | null; bu_id?: string | null;
  min_stock?: number | null; max_stock?: number | null; avg_daily_usage?: number | null; lead_time_days?: number | null;
  min_order_qty?: number | null; order_multiple?: number | null; order_cost?: number | null; holding_cost?: number | null;
  is_fixed_asset?: boolean; default_asset_category_id?: number | null;
  status?: string; superseded_by?: number | null;
};

const NUM_FIELDS = ['conversion_factor', 'unit_price', 'min_stock', 'max_stock', 'avg_daily_usage', 'lead_time_days', 'min_order_qty', 'order_multiple', 'order_cost', 'holding_cost'] as const;
const TEXT_FIELDS = ['barcode', 'uom', 'base_uom', 'temperature_type', 'bu_id'] as const;

// ตั้งค่าบัญชีสินค้า — per-item posting-profile override (docs/33, GL-21). An item's own accounts take
// precedence over its category; leave a field blank to inherit the category / standard control account.
export default function ItemPostingSetupPage() {
  const { t } = useLang();
  const [search, setSearch] = useState('');
  const [itemId, setItemId] = useState('');
  const [form, setForm] = useState<Profile | null>(null);
  const cats = useQuery<any>({ queryKey: ['item-categories'], queryFn: () => api('/api/item-setup/categories') });
  const assetCats = useQuery<any>({ queryKey: ['asset-categories'], queryFn: () => api('/api/assets/categories') });

  const load = useMutation({
    mutationFn: (id: string) => api<Profile>(`/api/item-setup/items/${encodeURIComponent(id)}`),
    onSuccess: (r) => { setForm(r); setItemId(r.item_id); },
    onError: (e: any) => { setForm(null); notifyError(e.message); },
  });
  const set = (k: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => f && ({ ...f, [k]: e.target.value }));
  const setNum = (k: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => f && ({ ...f, [k]: e.target.value === '' ? null : Number(e.target.value) } as Profile));

  const save = useMutation({
    mutationFn: () => {
      const p: any = { category_id: form!.category_id ?? null, is_fixed_asset: !!form!.is_fixed_asset, default_asset_category_id: form!.default_asset_category_id ?? null };
      for (const k of ['revenue_account', 'cogs_account', 'inventory_account', 'valuation_account', 'vat_code', 'wht_income_type', 'default_location_id', ...TEXT_FIELDS] as const) p[k] = (form as any)[k] ? (form as any)[k] : null;
      for (const k of NUM_FIELDS) p[k] = (form as any)[k] ?? null;
      return api(`/api/item-setup/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', body: JSON.stringify(p) });
    },
    onSuccess: (r: any) => { setForm(r); notifySuccess(t('st.sitm_saved', { item_id: r.item_id })); },
    onError: (e: any) => notifyError(e.message),
  });

  // Item lifecycle (master-data audit Phase 10) — active | inactive | discontinued (+ replacement pointer).
  const setStatus = useMutation({
    mutationFn: (status: string) => api<Profile>(`/api/item-setup/items/${encodeURIComponent(itemId)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: (r) => { setForm(r); notifySuccess(t('mx.item_status_saved')); },
    onError: (e: any) => notifyError(e.message),
  });

  // Match-merge / DQM (master-data audit Phase 11). Detection is open to setup users; the merge itself is
  // gated server-side to the platform owner (items are a shared cross-tenant master), so the merge button
  // only renders for a god (`me.is_platform_owner`) — a non-god sees the review queue but no merge action.
  const me = useMe();
  const qc = useQueryClient();
  const [showDupes, setShowDupes] = useState(false);
  const dupes = useQuery<{ groups: any[]; count: number }>({ queryKey: ['item-duplicates'], queryFn: () => api('/api/item-setup/items-duplicates'), enabled: showDupes });
  const merge = useMutation({
    mutationFn: ({ survivor, duplicate }: { survivor: string; duplicate: string }) => api<any>('/api/item-setup/items-merge', { method: 'POST', body: JSON.stringify({ survivor_item_id: survivor, duplicate_item_id: duplicate }) }),
    onSuccess: () => { notifySuccess(t('mx.item_merged')); dupes.refetch(); qc.invalidateQueries({ queryKey: ['item-duplicates'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const categories = cats.data?.categories ?? [];
  const assetCategories = assetCats.data?.categories ?? [];

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
          <Button variant="outline" size="sm" className="w-fit" onClick={() => setShowDupes((v) => !v)}><Copy className="size-4" /> {t('mx.item_dedup_title')}</Button>
        </Card>

        {showDupes && (
          <Card className="max-w-4xl gap-3 p-5 text-sm">
            <div>
              <h3 className="text-base font-semibold">{t('mx.item_dedup_title')}</h3>
              <p className="text-muted-foreground">{t('mx.item_dedup_desc')}</p>
            </div>
            {dupes.isLoading ? <p className="text-muted-foreground">…</p> : (dupes.data?.groups.length ?? 0) === 0 ? (
              <p className="py-4 text-center text-muted-foreground">{t('mx.item_dedup_none')}</p>
            ) : (
              <div className="grid max-h-[55vh] gap-3 overflow-y-auto">
                {dupes.data!.groups.map((g) => (
                  <Card key={g.primary.item_id} className="gap-2 p-3">
                    <div className="flex items-center gap-2">
                      <Badge variant="success" className="text-xs">{t('mx.item_dedup_keep')}</Badge>
                      <span className="font-medium">{g.primary.item_description || g.primary.item_id}</span>
                      <span className="text-muted-foreground">{g.primary.item_id}</span>
                    </div>
                    <div className="grid gap-2">
                      {g.duplicates.map((d: any) => (
                        <div key={d.item_id} className="flex items-center gap-2 rounded-md border border-border/60 p-2">
                          <div className="flex-1">
                            <div className="font-medium">{d.item_description || d.item_id} <span className="font-normal text-muted-foreground">{d.item_id}</span></div>
                            <div className="mt-0.5 flex flex-wrap gap-1">
                              {d.reasons.map((r: string) => <Badge key={r} variant="secondary" className="text-xs">{t(`mx.item_dedup_reason_${r}` as any)}</Badge>)}
                              <Badge variant="outline" className="text-xs">{Math.round(d.score * 100)}%</Badge>
                            </div>
                          </div>
                          {me.data?.is_platform_owner && (
                            <Button size="sm" variant="outline" disabled={merge.isPending} onClick={() => { if (window.confirm(t('mx.item_merge_confirm', { dup: d.item_id, keep: g.primary.item_id }))) merge.mutate({ survivor: g.primary.item_id, duplicate: d.item_id }); }}>
                              <GitMerge className="size-4" /> {t('mx.item_merge')}
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </Card>
        )}

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

        {form && (
          <Card className="max-w-4xl gap-4 p-5">
            <h3 className="text-base font-semibold">{t('st.sitm_master_heading')}</h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('st.sitm_barcode')}><Input value={form.barcode ?? ''} onChange={set('barcode')} /></Field>
              <Field label={t('st.sitm_uom')}><Input value={form.uom ?? ''} onChange={set('uom')} placeholder="EA" /></Field>
              <Field label={t('st.sitm_base_uom')}><Input value={form.base_uom ?? ''} onChange={set('base_uom')} placeholder="EA" /></Field>
              <Field label={t('st.sitm_conversion_factor')}><Input type="number" min="0" step="any" value={form.conversion_factor ?? ''} onChange={setNum('conversion_factor')} /></Field>
              <Field label={t('st.sitm_unit_price')}><Input type="number" min="0" step="any" value={form.unit_price ?? ''} onChange={setNum('unit_price')} /></Field>
              <Field label={t('st.sitm_temperature_type')}><Input value={form.temperature_type ?? ''} onChange={set('temperature_type')} /></Field>
              <Field label={t('st.sitm_bu_id')}><Input value={form.bu_id ?? ''} onChange={set('bu_id')} /></Field>
              <Field label={t('st.sitm_min_stock')}><Input type="number" min="0" step="any" value={form.min_stock ?? ''} onChange={setNum('min_stock')} /></Field>
              <Field label={t('st.sitm_max_stock')}><Input type="number" min="0" step="any" value={form.max_stock ?? ''} onChange={setNum('max_stock')} /></Field>
              <Field label={t('st.sitm_avg_daily_usage')}><Input type="number" min="0" step="any" value={form.avg_daily_usage ?? ''} onChange={setNum('avg_daily_usage')} /></Field>
              <Field label={t('st.sitm_lead_time_days')}><Input type="number" min="0" step="any" value={form.lead_time_days ?? ''} onChange={setNum('lead_time_days')} /></Field>
              <Field label={t('st.sitm_min_order_qty')}><Input type="number" min="0" step="any" value={form.min_order_qty ?? ''} onChange={setNum('min_order_qty')} /></Field>
              <Field label={t('st.sitm_order_multiple')}><Input type="number" min="0" step="any" value={form.order_multiple ?? ''} onChange={setNum('order_multiple')} /></Field>
              <Field label={t('st.sitm_order_cost')}><Input type="number" min="0" step="any" value={form.order_cost ?? ''} onChange={setNum('order_cost')} /></Field>
              <Field label={t('st.sitm_holding_cost')}><Input type="number" min="0" step="any" value={form.holding_cost ?? ''} onChange={setNum('holding_cost')} /></Field>
              <div className="grid gap-2">
                <Label>{t('st.sitm_is_fixed_asset')}</Label>
                <Select value={form.is_fixed_asset ? '1' : '0'} onValueChange={(v) => setForm((f) => f && ({ ...f, is_fixed_asset: v === '1' }))}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">{t('st.sitm_no')}</SelectItem>
                    <SelectItem value="1">{t('st.sitm_yes')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.is_fixed_asset && (
                <div className="grid gap-2">
                  <Label>{t('st.sitm_default_asset_category')}</Label>
                  <Select value={form.default_asset_category_id != null ? String(form.default_asset_category_id) : 'none'} onValueChange={(v) => setForm((f) => f && ({ ...f, default_asset_category_id: v === 'none' ? null : Number(v) }))}>
                    <SelectTrigger className="w-full"><SelectValue placeholder={t('st.sitm_no_category')} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t('st.sitm_no_category_option')}</SelectItem>
                      {assetCategories.map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{c.code} — {c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <div>
              <Button disabled={save.isPending} onClick={() => save.mutate()}><Save className="size-4" /> {save.isPending ? t('st.sitm_saving') : t('st.sitm_save_btn')}</Button>
            </div>
          </Card>
        )}

        {form && (
          <Card className="max-w-4xl gap-4 p-5">
            <div className="grid gap-2 sm:max-w-xs">
              <Label>{t('mx.item_status')}</Label>
              <Select value={form.status ?? 'active'} onValueChange={(v) => setStatus.mutate(v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t('mx.item_status_active')}</SelectItem>
                  <SelectItem value="inactive">{t('mx.item_status_inactive')}</SelectItem>
                  <SelectItem value="discontinued">{t('mx.item_status_discontinued')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <PartyRelationshipsSection
              listUrl={`/api/item-setup/items/${encodeURIComponent(itemId)}/relationships`}
              addUrl={`/api/item-setup/items/${encodeURIComponent(itemId)}/relationships`}
              deleteBase={`/api/item-setup/items/${encodeURIComponent(itemId)}/relationships`}
              queryKey={['item-relationships', itemId]}
              relTypes={ITEM_REL_TYPES}
              targetPlaceholder={t('mx.item_rel_target')}
              buildBody={(target, relType) => ({ to_item_id: target, rel_type: relType })}
            />
            <ScheduledChangesSection entity="item" entityKey={itemId} fields={['unit_price', 'status']} />
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
