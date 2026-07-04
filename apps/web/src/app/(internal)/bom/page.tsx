'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardList, Inbox, Plus, SearchX, X } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { SearchInput } from '@/components/search-input';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FormField } from '@/components/form-field';
import { Tabs } from '@/components/tabs';
import { statusVariant } from '@/components/ui';
import { useLang } from '@/lib/i18n';

const g = (r: any, ...keys: string[]) => { for (const k of keys) if (r[k] != null) return r[k]; return ''; };

function Library() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['bom-master'], queryFn: () => api('/api/bom/master') });
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [sell, setSell] = useState(0); const [labor, setLabor] = useState(0);
  const [lines, setLines] = useState([{ item_id: '', qty_use_uom: 1, conv_factor: 1 }]);
  const [search, setSearch] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const setLine = (i: number, p: any) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  // Inline validation (shown after a save attempt). Numeric fields must be non-negative; a material line is
  // validated only once it has an Item ID, so the trailing empty row never nags.
  const nn = (v: unknown) => Number(v) >= 0;
  const codeErr = !code.trim() ? t('mf.bom_err_code') : null;
  const nameErr = !name.trim() ? t('mf.bom_err_name') : null;
  const sellErr = !nn(sell) ? t('mf.bom_err_sell_neg') : null;
  const laborErr = !nn(labor) ? t('mf.bom_err_labor_neg') : null;
  const lineErr = (l: { item_id: string; qty_use_uom: number; conv_factor: number }) => {
    if (!l.item_id.trim()) return null;
    if (!(Number(l.qty_use_uom) > 0)) return t('mf.bom_err_qty_gt0');
    if (!(Number(l.conv_factor) > 0)) return t('mf.bom_err_conv_gt0');
    return null;
  };
  const invalid = !!codeErr || !!nameErr || !!sellErr || !!laborErr || lines.some((l) => lineErr(l));
  const boms: any[] = q.data?.boms ?? [];
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return boms;
    return boms.filter((b) => [g(b, 'bomCode', 'bom_code'), g(b, 'productName', 'product_name')].some((v) => String(v ?? '').toLowerCase().includes(term)));
  }, [boms, search]);
  const add = useMutation({
    mutationFn: () => api<{ bom_code: string }>('/api/bom/master', { method: 'POST', body: JSON.stringify({ bom_code: code, product_name: name, selling_price: Number(sell), labor_cost: Number(labor), lines: lines.filter((l) => l.item_id).map((l) => ({ item_id: l.item_id, qty_use_uom: Number(l.qty_use_uom), conv_factor: Number(l.conv_factor) })) }) }),
    onSuccess: (r) => { notifySuccess(`บันทึก ${r.bom_code}`); qc.invalidateQueries({ queryKey: ['bom-master'] }); setCode(''); setName(''); setShowErrors(false); },
    onError: (e: any) => notifyError(e.message),
  });
  const submit = () => { setShowErrors(true); if (invalid) { notifyError('กรุณาแก้ไขข้อมูลที่ไม่ถูกต้องก่อนบันทึก'); return; } add.mutate(); };
  return (
    <div className="space-y-4">
      <Card className="max-w-3xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">สร้าง/แก้สูตร (BoM)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FormField htmlFor="bom-code" label="รหัสสูตร" required error={showErrors ? codeErr : undefined}>
              <Input id="bom-code" placeholder="เช่น BOM001" value={code} aria-invalid={showErrors && !!codeErr} onChange={(e) => setCode(e.target.value)} />
            </FormField>
            <FormField htmlFor="bom-name" label="ชื่อสินค้า" required error={showErrors ? nameErr : undefined}>
              <Input id="bom-name" placeholder="เช่น ก๋วยเตี๋ยวต้มยำ" value={name} aria-invalid={showErrors && !!nameErr} onChange={(e) => setName(e.target.value)} />
            </FormField>
            <FormField htmlFor="bom-sell" label="ราคาขาย (บาท)" error={showErrors ? sellErr : undefined}>
              <Input id="bom-sell" type="number" inputMode="decimal" value={sell} aria-invalid={showErrors && !!sellErr} onChange={(e) => setSell(+e.target.value)} />
            </FormField>
            <FormField htmlFor="bom-labor" label="ค่าแรง (บาท)" error={showErrors ? laborErr : undefined}>
              <Input id="bom-labor" type="number" inputMode="decimal" value={labor} aria-invalid={showErrors && !!laborErr} onChange={(e) => setLabor(+e.target.value)} />
            </FormField>
          </div>
          <p className="text-sm font-medium">วัตถุดิบ</p>
          <div className="space-y-2">
            <div className="hidden grid-cols-[2fr_1fr_1fr_auto] gap-2 px-1 text-xs font-medium text-muted-foreground sm:grid">
              <span>Item ID</span><span>จำนวนใช้</span><span>อัตราแปลง</span><span className="w-9" />
            </div>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[2fr_1fr_1fr_auto] gap-2">
                <Input placeholder="Item ID" aria-label={`รหัสวัตถุดิบ แถวที่ ${i + 1}`} value={l.item_id} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { item_id: e.target.value })} />
                <Input type="number" inputMode="decimal" aria-label={`จำนวนใช้ แถวที่ ${i + 1}`} value={l.qty_use_uom} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { qty_use_uom: +e.target.value })} />
                <Input type="number" inputMode="decimal" aria-label={`อัตราแปลง แถวที่ ${i + 1}`} value={l.conv_factor} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { conv_factor: +e.target.value })} />
                <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" aria-label={`ลบวัตถุดิบ แถวที่ ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  <X className="size-4" />
                </Button>
                {showErrors && lineErr(l) && <p className="col-span-full -mt-1 text-xs text-destructive" role="alert">{lineErr(l)}</p>}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setLines((ls) => [...ls, { item_id: '', qty_use_uom: 1, conv_factor: 1 }])}>
              <Plus className="size-4" /> วัตถุดิบ
            </Button>
            <Button disabled={add.isPending} onClick={submit}>บันทึกสูตร</Button>
          </div>
        </CardContent>
      </Card>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-3">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="ค้นหารหัสสูตร / ชื่อสินค้า…"
              ariaLabel="ค้นหาสูตรการผลิต"
              count={`${filtered.length} สูตร`}
            />
            <DataTable
              rows={filtered}
              rowKey={(r) => String(g(r, 'bomCode', 'bom_code'))}
              emptyState={
                search
                  ? {
                      icon: SearchX,
                      title: 'ไม่พบสูตรที่ตรงกับการค้นหา',
                      description: 'ลองปรับคำค้นหา หรือล้างตัวกรองเพื่อดูทั้งหมด',
                      action: (
                        <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                          ล้างตัวกรอง
                        </Button>
                      ),
                    }
                  : { icon: ClipboardList, title: 'ยังไม่มีสูตรการผลิต', description: 'สร้างสูตร (BoM) แรกของคุณจากแบบฟอร์มด้านบน' }
              }
              columns={[
                { key: 'code', label: 'รหัส', render: (r) => g(r, 'bomCode', 'bom_code') },
                { key: 'product', label: 'สินค้า', render: (r) => g(r, 'productName', 'product_name') },
                { key: 'sell', label: 'ราคาขาย', align: 'right', render: (r) => baht(g(r, 'sellingPrice', 'selling_price')) },
                { key: 'cost', label: 'ต้นทุน/หน่วย', align: 'right', render: (r) => baht(g(r, 'costPerUnit', 'cost_per_unit')) },
                { key: 'margin', label: 'กำไร %', align: 'right', render: (r) => <span className="tabular">{`${Number(g(r, 'marginPct', 'margin_pct') || 0).toFixed(1)}%`}</span> },
              ]}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

function Submissions() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['bom-sub'], queryFn: () => api('/api/bom/submissions') });
  const approve = useMutation({ mutationFn: (id: number) => api(`/api/bom/submissions/${id}/approve`, { method: 'PATCH' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['bom-sub'] }) });
  return (
    <StateView q={q}>
      {q.data && <DataTable rows={q.data.submissions} emptyState={{ icon: Inbox, title: 'ยังไม่มีคำขออนุมัติ', description: 'คำขออนุมัติสูตรจากลูกค้าจะปรากฏที่นี่' }} columns={[
        { key: 'code', label: 'รหัส', render: (r) => g(r, 'bomCode', 'bom_code') },
        { key: 'product', label: 'สินค้า', render: (r) => g(r, 'productName', 'product_name') },
        { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(g(r, 'status') || 'Pending')}>{g(r, 'status') || 'Pending'}</Badge> },
        { key: 'x', label: '', sortable: false, render: (r) => (g(r, 'status') === 'Approved' ? <Check className="size-4 text-success" /> : <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate(g(r, 'id'))}>อนุมัติ</Button>) },
      ]} />}
    </StateView>
  );
}

export default function Bom() {
  return (
    <div>
      <PageHeader title="สูตรผลิตกลาง (BoM Master)" description="คลังสูตรการผลิตและคำขออนุมัติ" />
      <Tabs tabs={[{ key: 'lib', label: 'คลังสูตร', content: <Library /> }, { key: 'sub', label: 'คำขออนุมัติจากลูกค้า', content: <Submissions /> }]} />
    </div>
  );
}
