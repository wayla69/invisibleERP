'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SearchX, Truck } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { SearchInput } from '@/components/search-input';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function DeliveryPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['deliveries'], queryFn: () => api('/api/delivery') });
  const [f, setF] = useState({ order_no: '', driver: '', vehicle: '' });
  const [sel, setSel] = useState<string | null>(null);
  const detail = useQuery<any>({ queryKey: ['delivery', sel], queryFn: () => api(`/api/delivery/${sel}`), enabled: !!sel });
  const create = useMutation({
    mutationFn: () => api('/api/delivery', { method: 'POST', body: JSON.stringify({ order_no: f.order_no || undefined, driver: f.driver || undefined, vehicle: f.vehicle || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(t('hx.del.created', { no: r.do_no, lines: r.lines })); setF({ order_no: '', driver: '', vehicle: '' }); qc.invalidateQueries({ queryKey: ['deliveries'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const setStatus = useMutation({
    mutationFn: (v: { no: string; status: string }) => api(`/api/delivery/${v.no}/status`, { method: 'PATCH', body: JSON.stringify({ status: v.status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deliveries'] }),
  });

  // Client-side find/filter over the loaded delivery orders.
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const deliveries: any[] = q.data?.deliveries ?? [];
  const statuses = useMemo(() => Array.from(new Set(deliveries.map((d) => d.status).filter(Boolean))), [deliveries]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return deliveries.filter((d) => {
      if (statusFilter && d.status !== statusFilter) return false;
      if (!term) return true;
      return [d.do_no, d.driver, d.vehicle].some((v) => String(v ?? '').toLowerCase().includes(term));
    });
  }, [deliveries, search, statusFilter]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('hx.del.title')} description={t('hx.del.desc')} />
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.del.create_title')}</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5"><Label htmlFor="do-order">{t('hx.del.order_no')}</Label><Input id="do-order" placeholder="SO-…" value={f.order_no} onChange={(e) => setF({ ...f, order_no: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label htmlFor="do-driver">{t('hx.del.driver')}</Label><Input id="do-driver" placeholder={t('hx.del.driver_ph')} value={f.driver} onChange={(e) => setF({ ...f, driver: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label htmlFor="do-vehicle">{t('hx.del.vehicle')}</Label><Input id="do-vehicle" placeholder={t('hx.del.vehicle_ph')} value={f.vehicle} onChange={(e) => setF({ ...f, vehicle: e.target.value })} /></div>
        </div>
        <Button className="w-fit" disabled={!f.order_no || create.isPending} onClick={() => create.mutate()}>{t('hx.del.create_btn')}</Button>
      </Card>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder={t('hx.del.search_ph')}
                ariaLabel={t('hx.del.search_aria')}
                count={t('hx.common.count_items', { n: filtered.length })}
              />
              {statuses.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('hx.common.filter_status')}>
                  <Button variant={statusFilter === null ? 'secondary' : 'ghost'} size="sm" onClick={() => setStatusFilter(null)}>
                    {t('hx.common.all')}
                  </Button>
                  {statuses.map((s) => (
                    <Button key={s} variant={statusFilter === s ? 'secondary' : 'ghost'} size="sm" aria-pressed={statusFilter === s} onClick={() => setStatusFilter((c) => (c === s ? null : s))}>
                      {s}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <DataTable
              rows={filtered}
              rowKey={(r: any) => r.do_no}
              columns={[
              { key: 'do_no', label: t('dash.col_no') },
              { key: 'do_date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.do_date) },
              { key: 'driver', label: t('hx.del.col_driver'), render: (r: any) => r.driver || '—' },
              { key: 'vehicle', label: t('hx.del.col_vehicle'), render: (r: any) => r.vehicle || '—' },
              { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              {
                key: 'act', label: t('hx.common.update_status'), render: (r: any) => (
                  <select className={selectCls} value={r.status} onChange={(e) => setStatus.mutate({ no: r.do_no, status: e.target.value })}>
                    {['Pending', 'In Transit', 'Delivered', 'Cancelled'].map((st) => <option key={st} value={st}>{st}</option>)}
                  </select>
                ),
              },
              { key: 'view', label: '', render: (r: any) => <Button variant="ghost" size="sm" onClick={() => setSel(r.do_no)}>{t('hx.del.view_items')}</Button> },
              ]}
              emptyState={
                search || statusFilter
                  ? {
                      icon: SearchX,
                      title: t('hx.del.no_match_title'),
                      description: t('hx.common.filter_no_match_desc'),
                      action: (
                        <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatusFilter(null); }}>
                          {t('inv.clear_filter')}
                        </Button>
                      ),
                    }
                  : { icon: Truck, title: t('hx.del.empty_title'), description: t('hx.del.empty_desc') }
              }
            />
          </div>
        )}
      </StateView>
      {sel && (
        <Card className="gap-3 p-5">
          <div className="flex items-center justify-between"><h3 className="text-base font-semibold">{t('hx.del.items_in', { no: sel })}</h3><Button variant="ghost" size="sm" onClick={() => setSel(null)}>{t('hx.common.close')}</Button></div>
          <StateView q={detail}>
            {detail.data && (
              <DataTable
                rows={detail.data.items}
                columns={[
                  { key: 'item_id', label: t('hx.del.col_item') },
                  { key: 'item_description', label: t('hx.del.col_desc') },
                  { key: 'qty', label: t('hx.common.qty'), align: 'right' },
                  { key: 'uom', label: t('hx.del.col_uom') },
                ]}
                emptyText={t('hx.common.no_items')}
              />
            )}
          </StateView>
        </Card>
      )}
    </div>
  );
}
