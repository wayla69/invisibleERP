'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, FileWarning, SearchX } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { SearchInput } from '@/components/search-input';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { statusVariant } from '@/components/ui';

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
      <PageHeader title={t('hx.cl.title')} description={t('hx.cl.desc')} />
      <Tabs tabs={[{ key: 'sales', label: t('hx.cl.tab_sales'), content: <SalesClaims /> }, { key: 'gr', label: t('hx.cl.tab_gr'), content: <GrClaims /> }]} />
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
            <FilterBar search={search} onSearch={setSearch} statuses={statuses} statusFilter={statusFilter} onStatus={setStatusFilter} placeholder="ค้นหาออเดอร์ / สินค้า / เหตุผล…" count={`${num(filtered.length)} รายการ`} />
            <DataTable
              rows={filtered}
              rowKey={(r: any) => r.id}
              columns={[
                { key: 'order_no', label: 'ออเดอร์' },
                { key: 'item_description', label: 'สินค้า' },
                { key: 'claimed_qty', label: 'จำนวน', align: 'right', render: (r: any) => num(r.claimed_qty) },
                { key: 'reason', label: 'เหตุผล' },
                { key: 'admin_status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.admin_status)}>{r.admin_status}</Badge> },
                {
                  key: 'act', label: 'ดำเนินการ', sortable: false, render: (r: any) => r.admin_status === 'Waiting' ? (
                    <div className="flex items-center gap-1">
                      <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'approve' })}>อนุมัติ</Button>
                      <Input className="h-8 w-32" placeholder="เหตุผลปฏิเสธ" aria-label="เหตุผลปฏิเสธ" value={reason[r.id] ?? ''} onChange={(e) => setReason((s) => ({ ...s, [r.id]: e.target.value }))} />
                      <Button size="sm" variant="destructive" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'reject' })}>ปฏิเสธ</Button>
                    </div>
                  ) : '—',
                },
              ]}
              emptyState={
                search || statusFilter
                  ? {
                      icon: SearchX,
                      title: 'ไม่พบเคลมที่ตรงกับตัวกรอง',
                      description: 'ลองปรับคำค้นหา หรือล้างตัวกรองเพื่อดูทั้งหมด',
                      action: (
                        <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatusFilter(null); }}>
                          ล้างตัวกรอง
                        </Button>
                      ),
                    }
                  : { icon: FileWarning, title: 'ไม่มีรายการเคลม', description: 'เคลมจากลูกค้าที่รอพิจารณาจะแสดงที่นี่' }
              }
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

function GrClaims() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['gr-claims'], queryFn: () => api('/api/claims/gr') });
  const [f, setF] = useState({ gr_no: '', item_id: '', claim_qty: '', reason: '' });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api('/api/claims/gr', { method: 'POST', body: JSON.stringify({ gr_no: f.gr_no || undefined, item_id: f.item_id || undefined, claim_qty: f.claim_qty ? Number(f.claim_qty) : undefined, reason: f.reason || undefined }) }),
    onSuccess: (r: any) => { notifySuccess(`สร้างเคลม ${r.claim_no}`); setF({ gr_no: '', item_id: '', claim_qty: '', reason: '' }); qc.invalidateQueries({ queryKey: ['gr-claims'] }); },
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
        <h3 className="text-base font-semibold">แจ้งเคลมผู้ขาย</h3>
        <div className="grid gap-2 sm:grid-cols-4">
          <Input placeholder="GR No." aria-label="เลขที่ GR" value={f.gr_no} onChange={(e) => setF({ ...f, gr_no: e.target.value })} />
          <Input placeholder="รหัสสินค้า" aria-label="รหัสสินค้า" value={f.item_id} onChange={(e) => setF({ ...f, item_id: e.target.value })} />
          <Input type="number" inputMode="numeric" placeholder="จำนวนเคลม" aria-label="จำนวนเคลม" value={f.claim_qty} onChange={(e) => setF({ ...f, claim_qty: e.target.value })} />
          <Input placeholder="เหตุผล" aria-label="เหตุผล" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </div>
        <Button className="w-fit" disabled={create.isPending} onClick={() => create.mutate()}>สร้างเคลม</Button>
      </Card>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-3">
            <FilterBar search={search} onSearch={setSearch} statuses={statuses} statusFilter={statusFilter} onStatus={setStatusFilter} placeholder="ค้นหาเลขที่ / GR / สินค้า…" count={`${num(filtered.length)} รายการ`} />
            <DataTable
              rows={filtered}
              rowKey={(r: any) => r.claim_no}
              columns={[
                { key: 'claim_no', label: 'เลขที่' },
                { key: 'gr_no', label: 'GR' },
                { key: 'item_id', label: 'สินค้า' },
                { key: 'claim_qty', label: 'จำนวน', align: 'right', render: (r: any) => num(r.claim_qty) },
                { key: 'reason', label: 'เหตุผล' },
                { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                { key: 'act', label: '', sortable: false, render: (r: any) => r.status === 'Open' ? <div className="flex gap-1"><Button size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate({ no: r.claim_no, status: 'Resolved' })}>ปิดเคลม</Button><Button size="sm" variant="destructive" disabled={resolve.isPending} onClick={() => resolve.mutate({ no: r.claim_no, status: 'Rejected' })}>ปฏิเสธ</Button></div> : '—' },
              ]}
              emptyState={
                search || statusFilter
                  ? {
                      icon: SearchX,
                      title: 'ไม่พบเคลมที่ตรงกับตัวกรอง',
                      description: 'ลองปรับคำค้นหา หรือล้างตัวกรองเพื่อดูทั้งหมด',
                      action: (
                        <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatusFilter(null); }}>
                          ล้างตัวกรอง
                        </Button>
                      ),
                    }
                  : { icon: ClipboardList, title: 'ไม่มีเคลมผู้ขาย', description: 'แจ้งเคลมผู้ขายด้วยฟอร์มด้านบนเพื่อเริ่มต้น' }
              }
            />
          </div>
        )}
      </StateView>
    </div>
  );
}
