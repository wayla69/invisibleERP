'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Cable, DollarSign, Scale, MonitorSmartphone } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
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

interface Device { id: number; device_code: string; kind: string; terminal: string | null; printer_id: string | null; status: string; last_seen_at: string | null }
interface DrawerEvt { id: number; reason: string; terminal: string | null; sale_no: string | null; amount: number | null; opened_by: string | null; created_at: string | null }

export default function PeripheralsPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('px.periph_page_title')} description={t('px.periph_page_desc')} />
      <Tabs tabs={[
        { key: 'devices', label: t('px.periph_tab_devices'), content: <Devices /> },
        { key: 'drawer', label: t('px.periph_tab_drawer'), content: <Drawer /> },
        { key: 'scale', label: t('px.periph_tab_scale'), content: <ScaleTab /> },
        { key: 'display', label: t('px.periph_tab_display'), content: <Display /> },
      ]} />
    </div>
  );
}

function Devices() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [code, setCode] = useState(''); const [kind, setKind] = useState('cash_drawer'); const [terminal, setTerminal] = useState(''); const [printerId, setPrinterId] = useState('');
  const q = useQuery<{ devices: Device[] }>({ queryKey: ['pos-devices'], queryFn: () => api('/api/peripherals/devices') });
  const create = useMutation({
    mutationFn: () => api('/api/peripherals/devices', { method: 'POST', body: JSON.stringify({ device_code: code, kind, terminal: terminal || undefined, printer_id: printerId || undefined }) }),
    onSuccess: () => { notifySuccess(t('px.periph_registered', { code })); setCode(''); qc.invalidateQueries({ queryKey: ['pos-devices'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-sm">{t('px.periph_register')}</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-4">
          <div><Label>{t('px.periph_device_code')}</Label><Input value={code} onChange={(e) => setCode(e.target.value.trim())} placeholder="DRW1" /></div>
          <div><Label>{t('px.periph_kind')}</Label>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="cash_drawer">{t('px.periph_kind_cash_drawer')}</option><option value="printer">{t('px.periph_kind_printer')}</option><option value="display">{t('px.periph_kind_display')}</option><option value="scale">{t('px.periph_kind_scale')}</option>
            </select>
          </div>
          <div><Label>{t('px.periph_terminal')}</Label><Input value={terminal} onChange={(e) => setTerminal(e.target.value.trim())} placeholder="T01" /></div>
          <div><Label>{t('px.periph_printer_via')}</Label><Input value={printerId} onChange={(e) => setPrinterId(e.target.value.trim())} placeholder="PRN1" /></div>
          <div className="sm:col-span-4 flex items-center gap-3">
            <Button disabled={!code || create.isPending} onClick={() => create.mutate()}>{t('px.periph_register_btn')}</Button>
          </div>
        </CardContent>
      </Card>
      <StateView q={q}>
        <DataTable
          rows={q.data?.devices ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'device_code', label: t('px.periph_col_code') },
            { key: 'kind', label: t('px.periph_col_kind'), render: (r) => <Badge variant="muted">{r.kind}</Badge> },
            { key: 'terminal', label: t('px.periph_col_terminal'), render: (r) => r.terminal ?? '—' },
            { key: 'printer_id', label: t('px.periph_col_printer_via'), render: (r) => r.printer_id ?? '—' },
            { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={r.status === 'active' ? 'success' : 'muted'}>{r.status}</Badge> },
            { key: 'last_seen_at', label: t('px.periph_col_last_seen'), render: (r) => r.last_seen_at ? new Date(r.last_seen_at).toLocaleString('th-TH') : '—' },
          ]}
          emptyState={{
            icon: MonitorSmartphone,
            title: t('px.periph_devices_empty_title'),
            description: t('px.periph_devices_empty_desc'),
          }}
        />
      </StateView>
    </div>
  );
}

function Drawer() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [terminal, setTerminal] = useState('T01');
  const evts = useQuery<{ events: DrawerEvt[] }>({ queryKey: ['drawer-events'], queryFn: () => api('/api/peripherals/drawer/events'), refetchInterval: 15_000 });
  const recon = useQuery<{ total_opens: number; no_sale_opens: number; by_reason: Record<string, number> }>({ queryKey: ['drawer-recon'], queryFn: () => api('/api/peripherals/drawer/reconciliation') });
  const noSale = useMutation({
    mutationFn: () => api('/api/peripherals/drawer/kick', { method: 'POST', body: JSON.stringify({ terminal, reason: 'no_sale' }) }),
    onSuccess: () => { notifySuccess(t('px.periph_kick_saved')); qc.invalidateQueries({ queryKey: ['drawer-events'] }); qc.invalidateQueries({ queryKey: ['drawer-recon'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={t('px.periph_stat_total_opens')} value={num(recon.data?.total_opens ?? 0)} icon={DollarSign} tone="info" />
        <StatCard label={t('px.periph_stat_no_sale')} value={num(recon.data?.no_sale_opens ?? 0)} icon={DollarSign} tone={(recon.data?.no_sale_opens ?? 0) > 0 ? 'warning' : 'success'} hint={t('px.periph_stat_no_sale_hint')} />
        <StatCard label={t('px.periph_stat_sale')} value={num(recon.data?.by_reason?.sale ?? 0)} icon={DollarSign} tone="default" />
      </div>
      <Card>
        <CardHeader><CardTitle className="text-sm">{t('px.periph_no_sale_title')}</CardTitle></CardHeader>
        <CardContent className="flex items-end gap-3">
          <div><Label>{t('px.periph_terminal_short')}</Label><Input value={terminal} onChange={(e) => setTerminal(e.target.value.trim())} className="w-32" /></div>
          <Button variant="outline" disabled={noSale.isPending} onClick={() => noSale.mutate()}>{t('px.periph_open_drawer')}</Button>
        </CardContent>
      </Card>
      <StateView q={evts}>
        <DataTable
          rows={evts.data?.events ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'created_at', label: t('px.periph_col_time'), render: (r) => r.created_at ? new Date(r.created_at).toLocaleString('th-TH') : '—' },
            { key: 'reason', label: t('px.periph_col_reason'), render: (r) => <Badge variant={r.reason === 'no_sale' ? 'warning' : 'muted'}>{r.reason}</Badge> },
            { key: 'terminal', label: t('px.periph_col_terminal'), render: (r) => r.terminal ?? '—' },
            { key: 'sale_no', label: t('px.periph_col_sale'), render: (r) => r.sale_no ?? '—' },
            { key: 'amount', label: t('inv.col_qty'), align: 'right', render: (r) => r.amount != null ? baht(r.amount) : '—' },
            { key: 'opened_by', label: t('px.periph_col_by'), render: (r) => r.opened_by ?? '—' },
          ]}
          emptyState={{
            icon: DollarSign,
            title: t('px.periph_drawer_empty_title'),
            description: t('px.periph_drawer_empty_desc'),
          }}
        />
      </StateView>
    </div>
  );
}

function ScaleTab() {
  const { t } = useLang();
  const [sku, setSku] = useState(''); const [gross, setGross] = useState(''); const [tare, setTare] = useState(''); const [res, setRes] = useState<any>(null);
  const read = useMutation({
    mutationFn: () => api<any>('/api/peripherals/scale/read', { method: 'POST', body: JSON.stringify({ sku, gross_weight: Number(gross), tare_weight: tare ? Number(tare) : undefined }) }),
    onSuccess: (r) => { setRes(r); },
    onError: (e: Error) => { setRes(null); notifyError(e.message); },
  });
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Scale className="h-4 w-4" />{t('px.periph_scale_title')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div><Label>{t('px.periph_scale_sku')}</Label><Input value={sku} onChange={(e) => setSku(e.target.value.trim())} placeholder="WGH1" /></div>
          <div><Label>{t('px.periph_gross')}</Label><Input value={gross} onChange={(e) => setGross(e.target.value)} placeholder="1.25" /></div>
          <div><Label>{t('px.periph_tare')}</Label><Input value={tare} onChange={(e) => setTare(e.target.value)} placeholder="0.05" /></div>
        </div>
        <Button disabled={!sku || !gross || read.isPending} onClick={() => read.mutate()}>{t('px.periph_calc_price')}</Button>
        {res && (
          <div className="rounded-md border p-3 text-sm">
            <div className="font-medium">{res.name}</div>
            <div className="text-muted-foreground">{t('px.periph_net_weight_line', { net: res.net_weight, unit: res.weight_unit, price: baht(res.unit_price) })}</div>
            <div className="mt-1 text-lg font-semibold tabular">{baht(res.amount)}</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Display() {
  const { t } = useLang();
  const [terminal, setTerminal] = useState('T01');
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm flex items-center gap-2"><MonitorSmartphone className="h-4 w-4" />{t('px.periph_display_title')}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>{t('px.periph_display_desc')}</p>
        <div className="flex items-end gap-3">
          {/* terminal is a device code — restrict to a safe charset so it can never carry markup into the href */}
          <div><Label>{t('px.periph_terminal_short')}</Label><Input value={terminal} onChange={(e) => setTerminal(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))} className="w-32" /></div>
          <a href={`/display/${encodeURIComponent(terminal)}`} target="_blank" rel="noreferrer"><Button variant="outline" disabled={!terminal}>{t('px.periph_open_display')}</Button></a>
        </div>
      </CardContent>
    </Card>
  );
}
