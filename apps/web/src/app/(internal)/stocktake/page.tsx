'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, ClipboardList, FileText, Plus, ScanLine, Trash2 } from 'lucide-react';
// Note: post.mutate() removed from this page (wh_adjust duty). Posting variance is on /stock-adjustment.
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { num, thaiDate } from '@/lib/format';
import { scanCodeId } from '@/lib/qr';
import { QrScanButton } from '@/components/qr-scanner';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';
import { Select } from '@/components/form-controls';


interface CountLine { item_id: string; item_description?: string; uom?: string; system_qty: number; physical_qty: number }

export default function StocktakePage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('iv.stk_title')} description={t('iv.stk_desc')} />
      <Tabs tabs={[{ key: 'new', label: t('iv.stk_tab_new'), content: <NewCount /> }, { key: 'history', label: t('iv.stk_tab_history'), content: <History /> }]} />
    </div>
  );
}

function NewCount() {
  const { t } = useLang();
  const qc = useQueryClient();
  const stock = useQuery<any>({ queryKey: ['stock', 'all'], queryFn: () => api('/api/inventory/stock?limit=500') });
  const items: any[] = stock.data?.items ?? [];
  const byId = useMemo(() => Object.fromEntries(items.map((i) => [i.Item_ID, i])), [items]);

  const [lines, setLines] = useState<CountLine[]>([]);
  const [itemId, setItemId] = useState('');
  const [phys, setPhys] = useState('');
  const [scan, setScan] = useState('');
  const [savedNo, setSavedNo] = useState('');

  function applyScan(v: string) {
    setScan(v);
    const code = scanCodeId(v);
    if (code) setItemId(code);
  }
  function add() {
    if (!itemId || phys === '') return;
    const it = byId[itemId];
    setLines((ls) => [
      ...ls.filter((l) => l.item_id !== itemId),
      { item_id: itemId, item_description: it?.Item_Description, uom: it?.UOM, system_qty: Number(it?.AV_QTY ?? 0), physical_qty: Number(phys) },
    ]);
    setItemId(''); setPhys(''); setScan('');
  }

  const save = useMutation({
    mutationFn: () => api<any>('/api/stocktake', { method: 'POST', body: JSON.stringify({ lines }) }),
    // SoD R11: count is saved here (wh_count); posting the variance to the GL is a separate
    // wh_adjust action on /stock-adjustment — the counter cannot also approve their own count.
    onSuccess: (r) => { setSavedNo(r.st_no); notifySuccess(t('iv.stk_save_success', { stNo: r.st_no, n: r.variance_lines })); setLines([]); qc.invalidateQueries({ queryKey: ['stocktakes'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <div className="grid gap-1.5">
          <Label htmlFor="st-scan"><ScanLine className="mr-1 inline size-4" /> {t('iv.stk_scan_label')}</Label>
          <div className="flex items-center gap-2">
            <Input id="st-scan" className="flex-1" placeholder="ITEM_ID:P001|…" value={scan} onChange={(e) => applyScan(e.target.value)} />
            <QrScanButton onScan={applyScan} />
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5 min-w-[220px] flex-1">
            <Label htmlFor="st-item">{t('iv.stk_item')}</Label>
            <Select id="st-item"  value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">{t('iv.stk_select')}</option>
              {items.map((i) => <option key={i.Item_ID} value={i.Item_ID}>{i.Item_ID} — {i.Item_Description}</option>)}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="st-phys">{t('iv.stk_phys')}</Label>
            <Input id="st-phys" type="number" className="max-w-[140px]" value={phys} onChange={(e) => setPhys(e.target.value)} />
          </div>
          <Button disabled={!itemId || phys === ''} onClick={add}><Plus className="size-4" /> {t('iv.stk_add')}</Button>
        </div>
        {savedNo && <p className="text-sm text-muted-foreground"><ClipboardCheck className="mr-1 inline size-4 text-success" />{t('iv.stk_saved_note', { savedNo })}<a href="/stock-adjustment" className="text-primary underline">/stock-adjustment</a></p>}
      </Card>

      {lines.length > 0 && (
        <Card className="gap-3 p-5">
          <DataTable
            rows={lines.map((l) => ({ ...l, difference: l.physical_qty - l.system_qty }))}
            columns={[
              { key: 'item_id', label: t('inv.col_code') },
              { key: 'item_description', label: t('iv.stk_item') },
              { key: 'system_qty', label: t('iv.stk_col_system'), align: 'right', render: (r: any) => <span className="tabular">{num(r.system_qty)}</span> },
              { key: 'physical_qty', label: t('iv.stk_col_physical'), align: 'right', render: (r: any) => <span className="tabular">{num(r.physical_qty)}</span> },
              { key: 'difference', label: t('iv.stk_col_diff'), align: 'right', render: (r: any) => <span className={`tabular ${r.difference === 0 ? '' : r.difference > 0 ? 'text-success' : 'text-destructive'}`}>{r.difference > 0 ? '+' : ''}{num(r.difference)}</span> },
              { key: 'act', label: '', render: (r: any) => <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((x) => x.item_id !== r.item_id))}><Trash2 className="size-4" /></Button> },
            ]}
          />
          <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? t('iv.stk_saving') : t('iv.stk_save_btn', { n: lines.length })}</Button>
        </Card>
      )}
      {stock.isError && <StateView q={stock}><div /></StateView>}
    </div>
  );
}

function History() {
  const { t } = useLang();
  const q = useQuery<any>({ queryKey: ['stocktakes'], queryFn: () => api('/api/stocktake') });
  const [sel, setSel] = useState<string | null>(null);
  const detail = useQuery<any>({ queryKey: ['stocktake', sel], queryFn: () => api(`/api/stocktake/${sel}`), enabled: !!sel });
  return (
    <div className="space-y-4">
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.stocktakes}
            columns={[
              { key: 'st_no', label: t('dash.col_no') },
              { key: 'st_date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.st_date) },
              { key: 'counted_by', label: t('iv.stk_col_counted_by') },
              { key: 'lines', label: t('iv.stk_col_lines'), align: 'right', render: (r: any) => <span className="tabular">{num(r.lines)}</span> },
              { key: 'variance_lines', label: t('iv.stk_col_diff'), align: 'right', render: (r: any) => <span className="tabular">{num(r.variance_lines)}</span> },
              { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              { key: 'view', label: '', render: (r: any) => <Button variant="ghost" size="sm" onClick={() => setSel(r.st_no)}>{t('iv.stk_view')}</Button> },
            ]}
            emptyState={{
              icon: ClipboardList,
              title: t('iv.stk_empty_title'),
              description: t('iv.stk_empty_desc'),
            }}
          />
        )}
      </StateView>
      {sel && (
        <Card className="gap-3 p-5">
          <div className="flex items-center justify-between"><h3 className="text-base font-semibold">{t('iv.stk_lines_in', { sel })}</h3><Button variant="ghost" size="sm" onClick={() => setSel(null)}>{t('iv.stk_close')}</Button></div>
          <StateView q={detail}>
            {detail.data && (
              <DataTable
                rows={detail.data.lines}
                columns={[
                  { key: 'item_id', label: t('inv.col_code') },
                  { key: 'item_description', label: t('iv.stk_item') },
                  { key: 'system_qty', label: t('iv.stk_col_system'), align: 'right', render: (r: any) => num(r.system_qty) },
                  { key: 'physical_qty', label: t('iv.stk_col_physical'), align: 'right', render: (r: any) => num(r.physical_qty) },
                  { key: 'difference', label: t('iv.stk_col_diff'), align: 'right', render: (r: any) => num(r.difference) },
                ]}
                emptyState={{ icon: FileText, title: t('iv.stk_empty_lines') }}
              />
            )}
          </StateView>
        </Card>
      )}
    </div>
  );
}
