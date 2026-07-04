'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Users, Hourglass, BellRing } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { FormField } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { notifySuccess, notifyError } from '@/lib/notify';

// B1 — table reservations + walk-in waitlist. Book a table for a time or queue a walk-in; notify the
// guest (LINE/SMS) when ready; seat them (table → occupied); cancel / no-show.
interface Resv {
  id: number; kind: string; table_id: number | null; reserved_for: string | null; party_size: number;
  customer_name: string | null; customer_phone: string | null; status: string;
  quoted_wait_min: number | null; notes: string | null; notified_at: string | null; created_at: string;
}
interface Resp { reservations: Resv[]; count: number; waiting: number; booked: number; covers_pending: number }

const STATUS: Record<string, { tone: 'success' | 'warning' | 'info' | 'muted' | 'destructive' }> = {
  booked: { tone: 'info' }, waiting: { tone: 'warning' }, ready: { tone: 'success' },
  seated: { tone: 'muted' }, cancelled: { tone: 'muted' }, no_show: { tone: 'destructive' },
};
const KNOWN_ACTIONS = ['notify', 'seat', 'cancel', 'no-show'];

export default function ReservationsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<Resp>({ queryKey: ['reservations'], queryFn: () => api('/api/restaurant/reservations'), refetchInterval: 30_000 });
  const d = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['reservations'] });

  const [kind, setKind] = useState<'reservation' | 'waitlist'>('waitlist');
  const [form, setForm] = useState({ customer_name: '', customer_phone: '', party_size: '2', reserved_for: '', table_id: '', quoted_wait_min: '' });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: () => api('/api/restaurant/reservations', { method: 'POST', body: JSON.stringify({
      kind,
      customer_name: form.customer_name || undefined,
      customer_phone: form.customer_phone || undefined,
      party_size: Number(form.party_size) || 2,
      reserved_for: kind === 'reservation' && form.reserved_for ? new Date(form.reserved_for).toISOString() : undefined,
      table_id: form.table_id ? Number(form.table_id) : undefined,
      quoted_wait_min: kind === 'waitlist' && form.quoted_wait_min ? Number(form.quoted_wait_min) : undefined,
    }) }),
    onSuccess: () => { notifySuccess(kind === 'waitlist' ? t('px.resv_added_queue') : t('px.resv_booked_ok')); setForm({ customer_name: '', customer_phone: '', party_size: '2', reserved_for: '', table_id: '', quoted_wait_min: '' }); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: number; action: string }) => api(`/api/restaurant/reservations/${id}/${action}`, { method: 'POST' }),
    onSuccess: (_r, v) => { notifySuccess(KNOWN_ACTIONS.includes(v.action) ? t(`px.resv_act_${v.action}`) : t('px.resv_updated')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const open = (r: Resv) => ['booked', 'waiting', 'ready'].includes(r.status);

  return (
    <ModulePage
      title={t('px.resv_title')}
      description={t('px.resv_desc')}
      query={q}
      stats={d && (
        <>
          <StatCard label={t('px.resv_stat_waiting')} value={num(d.waiting)} icon={Hourglass} tone={d.waiting > 0 ? 'warning' : 'default'} />
          <StatCard label={t('px.resv_stat_booked')} value={num(d.booked)} icon={CalendarClock} tone="primary" />
          <StatCard label={t('px.resv_stat_covers')} value={num(d.covers_pending)} icon={Users} tone="default" hint={t('px.resv_stat_covers_hint')} />
          <StatCard label={t('px.resv_stat_total')} value={num(d.count)} icon={BellRing} tone="default" />
        </>
      )}
      statsClassName="xl:grid-cols-4"
    >
      {/* create form */}
      <div className="mb-4 rounded-xl border bg-card p-4">
        <div className="mb-3 inline-flex rounded-lg border p-0.5 text-sm">
          {(['waitlist', 'reservation'] as const).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)}
              className={`rounded-md px-3 py-1.5 font-medium transition-colors ${kind === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              {k === 'waitlist' ? t('px.resv_tab_waitlist') : t('px.resv_tab_reservation')}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FormField label={t('px.resv_name')}><Input value={form.customer_name} onChange={(e) => set('customer_name', e.target.value)} placeholder={t('px.resv_name_ph')} /></FormField>
          <FormField label={t('px.resv_phone')}><Input value={form.customer_phone} onChange={(e) => set('customer_phone', e.target.value)} placeholder="08x-xxx-xxxx" /></FormField>
          <FormField label={t('px.resv_party')}><Input type="number" min={1} value={form.party_size} onChange={(e) => set('party_size', e.target.value)} /></FormField>
          <FormField label={t('px.resv_table')}><Input type="number" value={form.table_id} onChange={(e) => set('table_id', e.target.value)} placeholder={t('px.resv_table_ph')} /></FormField>
          {kind === 'reservation'
            ? <FormField label={t('px.resv_time')}><Input type="datetime-local" value={form.reserved_for} onChange={(e) => set('reserved_for', e.target.value)} /></FormField>
            : <FormField label={t('px.resv_wait_est')}><Input type="number" min={0} value={form.quoted_wait_min} onChange={(e) => set('quoted_wait_min', e.target.value)} placeholder="20" /></FormField>}
          <div className="flex items-end">
            <Button disabled={create.isPending} onClick={() => create.mutate()}>{kind === 'waitlist' ? t('px.resv_queue_btn') : t('px.resv_book_btn')}</Button>
          </div>
        </div>
      </div>

      {d && (
        <DataTable
          rows={d.reservations}
          rowKey={(r) => r.id}
          emptyState={{ icon: CalendarClock, title: 'ยังไม่มีรายการจอง/คิว', description: 'เพิ่มการจองล่วงหน้าหรือรับลูกค้าเข้าคิวจากฟอร์มด้านบน' }}
          columns={[
            { key: 'kind', label: 'ประเภท', render: (r) => <Badge variant="outline">{r.kind === 'waitlist' ? 'รอคิว' : 'จอง'}</Badge> },
            { key: 'customer_name', label: 'ลูกค้า', render: (r) => <div><div className="font-medium">{r.customer_name || '—'}</div><div className="text-xs text-muted-foreground">{r.customer_phone || ''}</div></div> },
            { key: 'party_size', label: 'คน', align: 'right', render: (r) => num(r.party_size) },
            { key: 'reserved_for', label: 'เวลา', render: (r) => r.reserved_for ? thaiDate(r.reserved_for) : (r.quoted_wait_min != null ? `รอ ~${r.quoted_wait_min} นาที` : '—') },
            { key: 'table_id', label: 'โต๊ะ', render: (r) => r.table_id ?? '—' },
            { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={STATUS[r.status]?.tone ?? 'muted'}>{STATUS[r.status]?.th ?? r.status}</Badge> },
            { key: 'actions', label: '', align: 'right', render: (r) => open(r) ? (
              <div className="flex justify-end gap-1.5">
                {r.status !== 'ready' && <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: 'notify' })}>แจ้งโต๊ะพร้อม</Button>}
                <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: 'seat' })}>รับเข้านั่ง</Button>
                <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: r.kind === 'reservation' ? 'no-show' : 'cancel' })}>{r.kind === 'reservation' ? 'ไม่มา' : 'ออกคิว'}</Button>
              </div>
            ) : null },
          ]}
        />
      )}
    </ModulePage>
  );
}
