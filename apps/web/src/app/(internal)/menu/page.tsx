'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, FolderTree, Pencil, Plus, Power, Utensils } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useLang } from '@/lib/i18n';
import { useMe, hasPerm } from '@/lib/auth';
import { MasterIo } from '@/components/master-io';
import { Select } from '@/components/form-controls';

interface Item {
  id: number;
  sku: string;
  name: string;
  name_en: string | null;
  category_id: number | null;
  type: string;
  price: number;
  cost: number | null;
  station_code: string;
  prep_minutes: number;
  tax_type: string;
  track_stock: boolean;
  is_available: boolean;
  has_modifiers?: boolean;
  image_url?: string | null;
}
interface Category {
  id: number;
  code: string;
  name: string;
  name_en: string | null;
  color: string | null;
  sort: number;
}
interface MenuResp {
  categories: (Category & { items: Item[] })[];
  uncategorized: Item[];
  item_count: number;
}


export default function MenuPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('mf.menu_title')}
        description={t('mf.menu_desc')}
      />
      <Tabs
        tabs={[
          { key: 'items', label: t('mf.menu_tab_items'), content: <Items /> },
          { key: 'categories', label: t('mf.menu_tab_categories'), content: <Categories /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── รายการเมนู + สร้างเมนู ─────────────────────────
function Items() {
  const { t } = useLang();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const menu = useQuery<MenuResp>({ queryKey: ['menu'], queryFn: () => api('/api/menu') });
  const cats = useQuery<{ categories: Category[] }>({ queryKey: ['menu-categories'], queryFn: () => api('/api/menu/categories') });

  const items = useMemo<Item[]>(() => {
    const m = menu.data;
    if (!m) return [];
    return [...m.categories.flatMap((c) => c.items), ...m.uncategorized];
  }, [menu.data]);

  const catName = (id: number | null) => cats.data?.categories.find((c) => c.id === id)?.name ?? '—';

  const [editing, setEditing] = useState<Item | null>(null);

  // 86 / un-86 a dish — the core mid-service availability control. A quick, reversible toggle (no confirm):
  // POS re-reads menu availability, so a mistaken 86 is one tap to undo.
  const toggle = useMutation({
    mutationFn: (v: { sku: string; available: boolean }) =>
      api(`/api/menu/items/${encodeURIComponent(v.sku)}/availability`, {
        method: 'PATCH',
        body: JSON.stringify({ available: v.available }),
      }),
    onSuccess: (_d, v) => {
      const it = items.find((i) => i.sku === v.sku);
      notifySuccess(t(v.available ? 'mf.menu_reavail_ok' : 'mf.menu_86_ok', { name: it?.name ?? v.sku }));
      qc.invalidateQueries({ queryKey: ['menu'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [type, setType] = useState('food');
  const [taxType, setTaxType] = useState('standard');
  const [categoryId, setCategoryId] = useState('');
  const [startT, setStartT] = useState('');
  const [endT, setEndT] = useState('');
  const [days, setDays] = useState<boolean[]>([true, true, true, true, true, true, true]);

  const toMin = (t: string) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : undefined);

  const create = useMutation({
    mutationFn: () =>
      api<Item>('/api/menu/items', {
        method: 'POST',
        body: JSON.stringify({
          sku,
          name,
          price: Number(price),
          type,
          tax_type: taxType,
          category_id: categoryId ? Number(categoryId) : undefined,
          avail_start_min: toMin(startT),
          avail_end_min: toMin(endT),
          avail_days: days.every(Boolean) ? undefined : days.map((d) => (d ? '1' : '0')).join(''),
        }),
      }),
    onSuccess: (it) => {
      notifySuccess(t('mf.menu_added', { sku: it.sku, name: it.name }));
      setSku(''); setName(''); setPrice(''); setCategoryId(''); setStartT(''); setEndT(''); setDays([true, true, true, true, true, true, true]);
      qc.invalidateQueries({ queryKey: ['menu'] });
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const avgPrice = items.length ? items.reduce((s, i) => s + i.price, 0) / items.length : 0;
  const available = items.filter((i) => i.is_available).length;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t('mf.fc_total_dishes')} value={num(items.length)} icon={Utensils} tone="primary" />
        <StatCard label={t('mf.available')} value={num(available)} icon={BookOpen} tone="success" hint={t('mf.menu_disabled_hint', { n: num(items.length - available) })} />
        <StatCard label={t('mf.menu_tab_categories')} value={num(cats.data?.categories.length ?? 0)} icon={FolderTree} tone="info" />
        <StatCard label={t('mf.menu_avg_price')} value={baht(avgPrice)} icon={Utensils} tone="default" />
      </div>

      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('mf.menu_add_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="mi-sku">SKU</Label>
              <Input id="mi-sku" value={sku} onChange={(e) => setSku(e.target.value)} placeholder={t('mf.menu_sku_ph')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mi-name">{t('mf.menu_name_label')}</Label>
              <Input id="mi-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('mf.menu_name_ph')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mi-price">{t('mf.menu_price_label')}</Label>
              <Input id="mi-price" type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mi-cat">{t('mf.menu_tab_categories')}</Label>
              <Select id="mi-cat"  value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">{t('mf.menu_none_option')}</option>
                {cats.data?.categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mi-type">{t('mf.col_type')}</Label>
              <Select id="mi-type"  value={type} onChange={(e) => setType(e.target.value)}>
                <option value="food">{t('mf.menu_type_food')}</option>
                <option value="drink">{t('mf.menu_type_drink')}</option>
                <option value="retail">{t('mf.menu_type_retail')}</option>
                <option value="combo">{t('mf.menu_type_combo')}</option>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mi-tax">{t('mf.menu_tax_label')}</Label>
              <Select id="mi-tax"  value={taxType} onChange={(e) => setTaxType(e.target.value)}>
                <option value="standard">{t('mf.menu_tax_standard')}</option>
                <option value="exempt">{t('mf.menu_tax_exempt')}</option>
                <option value="zero">{t('mf.menu_tax_zero')}</option>
              </Select>
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label>{t('mf.menu_avail_time_label')}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input type="time" className="w-32" value={startT} onChange={(e) => setStartT(e.target.value)} />
                <span className="text-sm text-muted-foreground">{t('mf.to')}</span>
                <Input type="time" className="w-32" value={endT} onChange={(e) => setEndT(e.target.value)} />
              </div>
              <div className="flex flex-wrap gap-1">
                {t('mf.menu_dow').split(',').map((d, i) => (
                  <Button key={i} type="button" size="sm" variant={days[i] ? 'default' : 'outline'} onClick={() => setDays((p) => p.map((v, j) => (j === i ? !v : v)))}>{d}</Button>
                ))}
              </div>
            </div>
          </div>
          <Button disabled={!sku || !name || price === '' || create.isPending} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? t('mf.saving') : t('mf.menu_add_btn')}
          </Button>
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('mf.menu_tab_items')}</h3>
        <StateView q={menu}>
          <DataTable
            rows={items}
            rowKey={(r) => r.sku}
            columns={[
              { key: 'image_url', label: '', render: (r) => r.image_url
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={r.image_url} alt="" className="size-10 shrink-0 rounded-md object-cover" />
                : <div className="size-10 rounded-md bg-muted" /> },
              { key: 'sku', label: 'SKU' },
              { key: 'name', label: t('mf.menu_name_label') },
              { key: 'category_id', label: t('mf.menu_tab_categories'), render: (r) => catName(r.category_id) },
              { key: 'type', label: t('mf.col_type'), render: (r) => <Badge variant="secondary">{r.type}</Badge> },
              { key: 'price', label: t('mf.menu_col_price'), align: 'right', render: (r) => <span className="tabular">{baht(r.price)}</span> },
              { key: 'is_available', label: t('fin.col_status'), render: (r) => <Badge variant={r.is_available ? 'success' : 'muted'}>{r.is_available ? t('mf.available') : t('mf.menu_unavailable')}</Badge> },
              { key: 'actions', label: '', align: 'right', render: (r) => (
                <div className="flex items-center justify-end gap-1">
                  <Button size="sm" variant="outline" onClick={() => setEditing(r)}>
                    <Pencil className="size-3.5" /> {t('mf.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant={r.is_available ? 'outline' : 'default'}
                    disabled={toggle.isPending && toggle.variables?.sku === r.sku}
                    onClick={() => toggle.mutate({ sku: r.sku, available: !r.is_available })}
                  >
                    <Power className="size-3.5" /> {r.is_available ? t('mf.menu_86_btn') : t('mf.menu_reavail_btn')}
                  </Button>
                </div>
              ) },
            ]}
            emptyState={{ icon: Utensils, title: t('mf.menu_empty_title'), description: t('mf.menu_empty_desc') }}
          />
        </StateView>
      </div>

      {/* Bulk import/export of the POS menu catalog — reuses the master-data registry engine (entity
          `menu_items`); gated to the coarse `masterdata` setup duty the /api/admin/master-data endpoints require. */}
      {hasPerm(me, 'masterdata') && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground">{t('mdio.section_title')}</h3>
          <MasterIo entityKey="menu_items" base="admin" onImported={() => qc.invalidateQueries({ queryKey: ['menu'] })} />
        </div>
      )}

      {editing && <EditItemDialog item={editing} categories={cats.data?.categories ?? []} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ───────────────────────── แก้ไขเมนู ─────────────────────────
function EditItemDialog({ item, categories, onClose }: { item: Item; categories: Category[]; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [name, setName] = useState(item.name);
  const [nameEn, setNameEn] = useState(item.name_en ?? '');
  const [price, setPrice] = useState(String(item.price));
  const [cost, setCost] = useState(item.cost != null ? String(item.cost) : '');
  const [categoryId, setCategoryId] = useState(item.category_id != null ? String(item.category_id) : '');
  const [taxType, setTaxType] = useState(item.tax_type);

  const save = useMutation({
    mutationFn: () =>
      api<Item>(`/api/menu/items/${encodeURIComponent(item.sku)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          name_en: nameEn || undefined,
          price: Number(price),
          cost: cost === '' ? undefined : Number(cost),
          category_id: categoryId ? Number(categoryId) : undefined,
          tax_type: taxType,
        }),
      }),
    onSuccess: () => {
      notifySuccess(t('mf.menu_edit_ok', { sku: item.sku }));
      qc.invalidateQueries({ queryKey: ['menu'] });
      onClose();
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const invalid = !name || price === '' || Number.isNaN(Number(price)) || (cost !== '' && Number.isNaN(Number(cost)));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('mf.menu_edit_title', { sku: item.sku })}</DialogTitle>
          <DialogDescription>{t('mf.menu_edit_desc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="ei-name">{t('mf.menu_name_label')}</Label>
            <Input id="ei-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ei-name-en">{t('mf.menu_name_en_label')}</Label>
            <Input id="ei-name-en" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ei-price">{t('mf.menu_price_label')}</Label>
            <Input id="ei-price" type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ei-cost">{t('mf.menu_cost_label')}</Label>
            <Input id="ei-cost" type="number" min="0" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.00" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ei-cat">{t('mf.menu_tab_categories')}</Label>
            <Select id="ei-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">{t('mf.menu_none_option')}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ei-tax">{t('mf.menu_tax_label')}</Label>
            <Select id="ei-tax" value={taxType} onChange={(e) => setTaxType(e.target.value)}>
              <option value="standard">{t('mf.menu_tax_standard')}</option>
              <option value="exempt">{t('mf.menu_tax_exempt')}</option>
              <option value="zero">{t('mf.menu_tax_zero')}</option>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('fin.cancel')}</Button>
          <Button disabled={invalid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t('mf.saving') : t('mf.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── หมวดหมู่ ─────────────────────────
function Categories() {
  const { t } = useLang();
  const q = useQuery<{ categories: Category[]; count: number }>({ queryKey: ['menu-categories'], queryFn: () => api('/api/menu/categories') });
  const categories = q.data?.categories ?? [];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label={t('mf.menu_cat_total')} value={num(q.data?.count ?? 0)} icon={FolderTree} tone="primary" />
      </div>

      <StateView q={q}>
        <DataTable
          rows={categories}
          rowKey={(r) => r.id}
          columns={[
            { key: 'code', label: t('mf.col_code') },
            { key: 'name', label: t('mf.menu_col_catname') },
            { key: 'name_en', label: t('mf.menu_col_name_en'), render: (r) => r.name_en ?? '—' },
            { key: 'sort', label: t('mf.menu_col_sort'), align: 'right', render: (r) => num(r.sort) },
          ]}
          emptyState={{ icon: FolderTree, title: t('mf.menu_cat_empty_title'), description: t('mf.menu_cat_empty_desc') }}
        />
      </StateView>
    </div>
  );
}
