'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, FolderTree, Plus, Utensils } from 'lucide-react';
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

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function MenuPage() {
  return (
    <div>
      <PageHeader
        title="เมนูอาหาร (Menu)"
        description="จัดการรายการเมนู หมวดหมู่ และราคา — ใช้แสดงผลบนหน้า POS"
      />
      <Tabs
        tabs={[
          { key: 'items', label: 'รายการเมนู', content: <Items /> },
          { key: 'categories', label: 'หมวดหมู่', content: <Categories /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── รายการเมนู + สร้างเมนู ─────────────────────────
function Items() {
  const qc = useQueryClient();
  const menu = useQuery<MenuResp>({ queryKey: ['menu'], queryFn: () => api('/api/menu') });
  const cats = useQuery<{ categories: Category[] }>({ queryKey: ['menu-categories'], queryFn: () => api('/api/menu/categories') });

  const items = useMemo<Item[]>(() => {
    const m = menu.data;
    if (!m) return [];
    return [...m.categories.flatMap((c) => c.items), ...m.uncategorized];
  }, [menu.data]);

  const catName = (id: number | null) => cats.data?.categories.find((c) => c.id === id)?.name ?? '—';

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
      notifySuccess(`เพิ่มเมนู ${it.sku} · ${it.name}`);
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
        <StatCard label="เมนูทั้งหมด" value={num(items.length)} icon={Utensils} tone="primary" />
        <StatCard label="พร้อมขาย" value={num(available)} icon={BookOpen} tone="success" hint={`ปิดการขาย ${num(items.length - available)} รายการ`} />
        <StatCard label="หมวดหมู่" value={num(cats.data?.categories.length ?? 0)} icon={FolderTree} tone="info" />
        <StatCard label="ราคาเฉลี่ย" value={baht(avgPrice)} icon={Utensils} tone="default" />
      </div>

      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">เพิ่มเมนูใหม่</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="mi-sku">SKU</Label>
              <Input id="mi-sku" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="เช่น TOM-001" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mi-name">ชื่อเมนู</Label>
              <Input id="mi-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น ต้มยำกุ้ง" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mi-price">ราคา (บาท)</Label>
              <Input id="mi-price" type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mi-cat">หมวดหมู่</Label>
              <select id="mi-cat" className={selectCls} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">— ไม่ระบุ —</option>
                {cats.data?.categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mi-type">ประเภท</Label>
              <select id="mi-type" className={selectCls} value={type} onChange={(e) => setType(e.target.value)}>
                <option value="food">อาหาร (food)</option>
                <option value="drink">เครื่องดื่ม (drink)</option>
                <option value="retail">สินค้า (retail)</option>
                <option value="combo">ชุด (combo)</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mi-tax">ภาษี</Label>
              <select id="mi-tax" className={selectCls} value={taxType} onChange={(e) => setTaxType(e.target.value)}>
                <option value="standard">มาตรฐาน (standard)</option>
                <option value="exempt">ยกเว้น (exempt)</option>
                <option value="zero">ศูนย์ (zero)</option>
              </select>
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label>ช่วงเวลาขาย (เว้นว่าง = ขายทั้งวัน)</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input type="time" className="w-32" value={startT} onChange={(e) => setStartT(e.target.value)} />
                <span className="text-sm text-muted-foreground">ถึง</span>
                <Input type="time" className="w-32" value={endT} onChange={(e) => setEndT(e.target.value)} />
              </div>
              <div className="flex flex-wrap gap-1">
                {['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'].map((d, i) => (
                  <Button key={i} type="button" size="sm" variant={days[i] ? 'default' : 'outline'} onClick={() => setDays((p) => p.map((v, j) => (j === i ? !v : v)))}>{d}</Button>
                ))}
              </div>
            </div>
          </div>
          <Button disabled={!sku || !name || price === '' || create.isPending} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? 'กำลังบันทึก…' : 'เพิ่มเมนู'}
          </Button>
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">รายการเมนู</h3>
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
              { key: 'name', label: 'ชื่อเมนู' },
              { key: 'category_id', label: 'หมวดหมู่', render: (r) => catName(r.category_id) },
              { key: 'type', label: 'ประเภท', render: (r) => <Badge variant="secondary">{r.type}</Badge> },
              { key: 'price', label: 'ราคา', align: 'right', render: (r) => <span className="tabular">{baht(r.price)}</span> },
              { key: 'is_available', label: 'สถานะ', render: (r) => <Badge variant={r.is_available ? 'success' : 'muted'}>{r.is_available ? 'พร้อมขาย' : 'ปิดขาย'}</Badge> },
            ]}
            emptyState={{ icon: Utensils, title: 'ยังไม่มีเมนู', description: 'เพิ่มเมนูใหม่ด้วยฟอร์มด้านบนเพื่อเริ่มแสดงผลบนหน้า POS' }}
          />
        </StateView>
      </div>
    </div>
  );
}

// ───────────────────────── หมวดหมู่ ─────────────────────────
function Categories() {
  const q = useQuery<{ categories: Category[]; count: number }>({ queryKey: ['menu-categories'], queryFn: () => api('/api/menu/categories') });
  const categories = q.data?.categories ?? [];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="หมวดหมู่ทั้งหมด" value={num(q.data?.count ?? 0)} icon={FolderTree} tone="primary" />
      </div>

      <StateView q={q}>
        <DataTable
          rows={categories}
          rowKey={(r) => r.id}
          columns={[
            { key: 'code', label: 'รหัส' },
            { key: 'name', label: 'ชื่อหมวด' },
            { key: 'name_en', label: 'ชื่อ (EN)', render: (r) => r.name_en ?? '—' },
            { key: 'sort', label: 'ลำดับ', align: 'right', render: (r) => num(r.sort) },
          ]}
          emptyState={{ icon: FolderTree, title: 'ยังไม่มีหมวดหมู่', description: 'เพิ่มหมวดหมู่เพื่อจัดกลุ่มเมนูให้ค้นหาง่ายขึ้นบนหน้า POS' }}
        />
      </StateView>
    </div>
  );
}
