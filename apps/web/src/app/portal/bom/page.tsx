'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Play, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Line { item_id: string; use_uom?: string; qty_use_uom: number; unit_cost?: number }

export default function PortalBomPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const list = useQuery<any>({ queryKey: ['portal-bom'], queryFn: () => api('/api/portal/bom') });
  const [hdr, setHdr] = useState({ bom_code: '', product_name: '', yield_qty: '1', yield_uom: '', selling_price: '' });
  const [lines, setLines] = useState<Line[]>([]);
  const [ln, setLn] = useState({ item_id: '', use_uom: '', qty_use_uom: '', unit_cost: '' });
  const [msg, setMsg] = useState('');

  const create = useMutation({
    mutationFn: () => api('/api/portal/bom', {
      method: 'POST',
      body: JSON.stringify({
        bom_code: hdr.bom_code, product_name: hdr.product_name || undefined,
        yield_qty: hdr.yield_qty ? Number(hdr.yield_qty) : undefined, yield_uom: hdr.yield_uom || undefined,
        selling_price: hdr.selling_price ? Number(hdr.selling_price) : undefined, lines,
      }),
    }),
    onSuccess: () => { setMsg(t('pt.bom.saved', { code: hdr.bom_code })); setHdr({ bom_code: '', product_name: '', yield_qty: '1', yield_uom: '', selling_price: '' }); setLines([]); qc.invalidateQueries({ queryKey: ['portal-bom'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const run = useMutation({
    mutationFn: (code: string) => { const q = prompt(t('pt.bom.batch_prompt', { code })); return q ? api(`/api/portal/bom/${encodeURIComponent(code)}/production-runs`, { method: 'POST', body: JSON.stringify({ batch_qty: Number(q) }) }) : Promise.resolve(null); },
    onSuccess: (r) => { if (r) { setMsg(t('pt.bom.run_saved')); qc.invalidateQueries({ queryKey: ['portal-bom'] }); } },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  function addLine() {
    if (!ln.item_id || !ln.qty_use_uom) return;
    setLines((ls) => [...ls, { item_id: ln.item_id, use_uom: ln.use_uom || undefined, qty_use_uom: Number(ln.qty_use_uom), unit_cost: ln.unit_cost ? Number(ln.unit_cost) : undefined }]);
    setLn({ item_id: '', use_uom: '', qty_use_uom: '', unit_cost: '' });
  }
  const g = (r: any, a: string, b: string) => r[a] ?? r[b];

  return (
    <div className="space-y-4">
      <PageHeader title={t('pt.bom.title')} description={t('pt.bom.desc')} />
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('pt.bom.create_title')}</h3>
        <div className="grid gap-2 sm:grid-cols-5">
          <Input placeholder={t('pt.bom.ph_code')} value={hdr.bom_code} onChange={(e) => setHdr({ ...hdr, bom_code: e.target.value })} />
          <Input placeholder={t('pt.bom.ph_product')} value={hdr.product_name} onChange={(e) => setHdr({ ...hdr, product_name: e.target.value })} />
          <Input type="number" placeholder={t('pt.bom.ph_yield')} value={hdr.yield_qty} onChange={(e) => setHdr({ ...hdr, yield_qty: e.target.value })} />
          <Input placeholder={t('pt.bom.ph_uom')} value={hdr.yield_uom} onChange={(e) => setHdr({ ...hdr, yield_uom: e.target.value })} />
          <Input type="number" placeholder={t('pt.bom.ph_price')} value={hdr.selling_price} onChange={(e) => setHdr({ ...hdr, selling_price: e.target.value })} />
        </div>
        <Label>{t('pt.bom.ingredients')}</Label>
        <div className="grid gap-2 sm:grid-cols-5">
          <Input placeholder={t('pt.bom.ph_material')} value={ln.item_id} onChange={(e) => setLn({ ...ln, item_id: e.target.value })} />
          <Input placeholder={t('pt.bom.ph_use_uom')} value={ln.use_uom} onChange={(e) => setLn({ ...ln, use_uom: e.target.value })} />
          <Input type="number" placeholder={t('pt.bom.ph_use_qty')} value={ln.qty_use_uom} onChange={(e) => setLn({ ...ln, qty_use_uom: e.target.value })} />
          <Input type="number" placeholder={t('pt.bom.ph_unit_cost')} value={ln.unit_cost} onChange={(e) => setLn({ ...ln, unit_cost: e.target.value })} />
          <Button variant="outline" onClick={addLine}><Plus className="size-4" /> {t('pt.bom.add_ing')}</Button>
        </div>
        {lines.length > 0 && (
          <DataTable
            rows={lines.map((l, i) => ({ ...l, _i: i }))}
            columns={[
              { key: 'item_id', label: t('pt.bom.col_material') },
              { key: 'qty_use_uom', label: t('pt.bom.col_qty'), align: 'right', render: (r: any) => num(r.qty_use_uom) },
              { key: 'use_uom', label: t('pt.bom.col_uom') },
              { key: 'unit_cost', label: t('pt.bom.col_cost'), align: 'right', render: (r: any) => r.unit_cost != null ? baht(r.unit_cost) : '—' },
              { key: 'act', label: '', render: (r: any) => <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== r._i))}><Trash2 className="size-4" /></Button> },
            ]}
            dense
          />
        )}
        <Button className="w-fit" disabled={!hdr.bom_code || create.isPending} onClick={() => create.mutate()}>{t('pt.bom.save_recipe')}</Button>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={list}>
        {list.data && (
          <DataTable
            rows={list.data.boms ?? list.data.bom ?? list.data.items ?? []}
            columns={[
              { key: 'bom_code', label: t('pt.bom.col_recipe'), render: (r: any) => g(r, 'bom_code', 'bomCode') },
              { key: 'product_name', label: t('pt.bom.col_product'), render: (r: any) => g(r, 'product_name', 'productName') ?? '—' },
              { key: 'yield_qty', label: t('pt.bom.col_yield'), align: 'right', render: (r: any) => num(g(r, 'yield_qty', 'yieldQty')) },
              { key: 'selling_price', label: t('pt.bom.col_price'), align: 'right', render: (r: any) => baht(g(r, 'selling_price', 'sellingPrice')) },
              { key: 'act', label: '', render: (r: any) => <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate(g(r, 'bom_code', 'bomCode'))}><Play className="size-4" /> {t('pt.bom.produce')}</Button> },
            ]}
            emptyText={t('pt.bom.empty')}
          />
        )}
      </StateView>
    </div>
  );
}
