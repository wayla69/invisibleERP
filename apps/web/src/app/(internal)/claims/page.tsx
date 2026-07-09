'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, FileWarning, SearchX } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { ModulePage } from '@/components/module-page';
import { DataTable } from '@/components/data-table';
import { SearchInput } from '@/components/search-input';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { statusVariant } from '@/components/ui';
import { DocSelect } from '@/components/doc-select';

/** Shared find + status-filter toolbar for the claim lists. */
function FilterBar({
  search, onSearch, statuses, statusFilter, onStatus, placeholder, count,
}: {
  search: string; onSearch: (v: string) => void; statuses: string[];
  statusFilter: string | null; onStatus: (v: string | null) => void; placeholder: string;
  count?: string;
}) {
  const { t } = useLang();
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <SearchInput value={search} onChange={onSearch} placeholder={placeholder} ariaLabel={t('hx.cl.search_aria')} count={count} />
      {statuses.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('hx.common.filter_status')}>
          <Button variant={statusFilter === null ? 'secondary' : 'ghost'} size="sm" onClick={() => onStatus(null)}>{t('hx.common.all')}</Button>
          {statuses.map((s) => (
            <Button key={s} variant={statusFilter === s ? 'secondary' : 'ghost'} size="sm" aria-pressed={statusFilter === s} onClick={() => onStatus(statusFilter === s ? null : s)}>{s}</Button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ClaimsPage() {
  const { t } = useLang();
  return (
    <div>
      <ModulePage title={t('hx.cl.title')} description={t('hx.cl.desc')} tabs={[{ key: 'sales', label: t('hx.cl.tab_sales'), content: <SalesClaims /> }, { key: 'gr', label: t('hx.cl.tab_gr'), content: <GrClaims /> }]} />
    </div>
  );
}

function SalesClaims() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['sales-claims'], queryFn: () => api('/api/claims/sales') });
  const [reason, setReason] = useState<Record<number, string>>({});
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (v: { id: number; decision: 'approve' | 'reject' }) => api(`/api/claims/sales/${v.id}`, { method: 'PATCH', body: JSON.stringify({ decision: v.decision, reject_reason: reason[v.id] }) }),
    onSuccess: () => { notifySuccess(t('hx.cl.saved')); qc.invalidateQueries({ queryKey: ['sales-claims'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const claims: any[] = q.data?.claims ?? [];
  const statuses = useMemo(() => Array.from(new Set(claims.map((c) => c.admin_status).filter(Boolean))), [claims]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return claims.filter((c) => {
      if (statusFilter && c.admin_status !== statusFilter) return false;
      if (!term) return true;
      return [c.order_no, c.item_description, c.reason].some((v) => String(v ?? '').toLowerCase().includes(term));
    });
  }, [claims, search, statusFilter]);

  return (
    <div className="space-y-3">
      <StateView q={q}>
        {q.data && (
          <div className="space-y-3">
            <FilterBar search={search} onSearch={setSearch} statuses={statuses} statusFilter={statusFilter} onStatus={setStatusFilter} placeholder={t('hx.cl.search_sales_ph')} count={t('hx.common.count_items', { n: num(filtered.length) })} />
            <DataTable
              rows={filtered}
              rowKey={(r: any) => r.id}
              columns={[
                { key: 'order_no', label: t('hx.cl.col_order') },
                { key: 'item_description', label: t('hx.cl.col_item') },
                { key: 'claimed_qty', label: t('hx.common.qty'), align: 'right', render: (r: any) => num(r.claimed_qty) },
                { key: 'reason', label: t('hx.cl.col_reason') },
                { key: 'admin_status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.admin_status)}>{r.admin_status}</Badge> },
                {
                  key: 'act', label: t('hx.common.actions'), sortable: false, render: (r: any) => r.admin_status === 'Waiting' ? (
                    <div className="flex items-center gap-1">
                      <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'approve' })}>{t('fin.approve')}</Button>
                      <Input className="h-8 w-32" placeholder={t('hx.cl.reject_reason')} aria-label={t('hx.cl.reject_reason')} value={reason[r.id] ?? ''} onChange={(e) => setReason((s) => ({ ...s, [r.id]: e.target.value }))} />
                      <Button size="sm" variant="destructive" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'reject' })}>{t('fin.rejected')}</Button>
                    </div>
                  ) : '—',
                },
              ]}
              emptyState={
                search || statusFilter
                  ? {
                      icon: SearchX,
                      title: t('hx.cl.no_match_title'),
                      description: t('hx.common.filter_no_match_desc'),
                      action: (
                        <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatusFilter(null); }}>
                          {t('inv.clear_filter')}
                        </Button>
                      ),
                    }
                  : { icon: FileWarning, title: t('hx.cl.sales_empty_title'), description: t('hx.cl.sales_empty_desc') }
              }
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

function GrClaims() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['gr-claims'], queryFn: () => api('/api/claims/gr') });
  const [f, setF] = useState({ gr_no: '', item_id: '', claim_qty: '', reason: '' });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  // Recent GRs — the claimed receipt is picked from a dropdown, not typed.
  const grsQ = useQuery<any>({ queryKey: ['grs-for-claims'], queryFn: () => api('/api/procurement/grs?limit=100') });
  const grOptions = (grsQ.data?.grs ?? []).map((g: any) => ({ value: g.gr_no, label: [g.po_no, g.vendor_name].filter(Boolean).join(' · ') || undefined }));
  const create = useMutation({
    mutationFn: () => api('/api/claims/gr', { method: 'POST', body: JSON.stringify({ gr_no: f.gr_no || undefined, item_id: f.item_id || undefined, claim_qty: f.claim_qty ? Number(f.claim_qty) : undefined, reason: f.reason || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(t('hx.cl.created', { no: r.claim_no })); setF({ gr_no: '', item_id: '', claim_qty: '', reason: '' }); qc.invalidateQueries({ queryKey: ['gr-claims'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const resolve = useMutation({
    mutationFn: (v: { no: string; status: string }) => api(`/api/claims/gr/${v.no}`, { method: 'PATCH', body: JSON.stringify({ status: v.status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gr-claims'] }),
  });

  const claims: any[] = q.data?.claims ?? [];
  const statuses = useMemo(() => Array.from(new Set(claims.map((c) => c.status).filter(Boolean))), [claims]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return claims.filter((c) => {
      if (statusFilter && c.status !== statusFilter) return false;
      if (!term) return true;
      return [c.claim_no, c.gr_no, c.item_id, c.reason].some((v) => String(v ?? '').toLowerCase().includes(term));
    });
  }, [claims, search, statusFilter]);

  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.cl.gr_form_title')}</h3>
        <div className="grid gap-2 sm:grid-cols-4">
          <DocSelect value={f.gr_no} onValueChange={(v) => setF({ ...f, gr_no: v })} options={grOptions} placeholder={t('common.doc_select_ph')} emptyText={t('common.doc_none')} allowManual manualPlaceholder="GR No." />
          <Input placeholder={t('hx.cl.item_id')} aria-label={t('hx.cl.item_id')} value={f.item_id} onChange={(e) => setF({ ...f, item_id: e.target.value })} />
          <Input type="number" inputMode="numeric" placeholder={t('hx.cl.claim_qty')} aria-label={t('hx.cl.claim_qty')} value={f.claim_qty} onChange={(e) => setF({ ...f, claim_qty: e.target.value })} />
          <Input placeholder={t('hx.cl.reason')} aria-label={t('hx.cl.reason')} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </div>
        <Button className="w-fit" disabled={create.isPending} onClick={() => create.mutate()}>{t('hx.cl.create_btn')}</Button>
      </Card>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-3">
            <FilterBar search={search} onSearch={setSearch} statuses={statuses} statusFilter={statusFilter} onStatus={setStatusFilter} placeholder={t('hx.cl.search_gr_ph')} count={t('hx.common.count_items', { n: num(filtered.length) })} />
            <DataTable
              rows={filtered}
              rowKey={(r: any) => r.claim_no}
              columns={[
                { key: 'claim_no', label: t('dash.col_no') },
                { key: 'gr_no', label: 'GR' },
                { key: 'item_id', label: t('hx.cl.col_item') },
                { key: 'claim_qty', label: t('hx.common.qty'), align: 'right', render: (r: any) => num(r.claim_qty) },
                { key: 'reason', label: t('hx.cl.col_reason') },
                { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                { key: 'act', label: '', sortable: false, render: (r: any) => r.status === 'Open' ? <div className="flex gap-1"><Button size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate({ no: r.claim_no, status: 'Resolved' })}>{t('hx.cl.close_claim')}</Button><Button size="sm" variant="destructive" disabled={resolve.isPending} onClick={() => resolve.mutate({ no: r.claim_no, status: 'Rejected' })}>{t('fin.rejected')}</Button></div> : '—' },
              ]}
              emptyState={
                search || statusFilter
                  ? {
                      icon: SearchX,
                      title: t('hx.cl.no_match_title'),
                      description: t('hx.common.filter_no_match_desc'),
                      action: (
                        <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatusFilter(null); }}>
                          {t('inv.clear_filter')}
                        </Button>
                      ),
                    }
                  : { icon: ClipboardList, title: t('hx.cl.gr_empty_title'), description: t('hx.cl.gr_empty_desc') }
              }
            />
          </div>
        )}
      </StateView>
    </div>
  );
}
