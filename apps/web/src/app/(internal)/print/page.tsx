'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Printer, RefreshCw, Send, FileText, Inbox } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { thaiDateTime } from '@/lib/format';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

interface Job {
  id: number; job_type: string; station: string | null; sale_no: string | null; order_no: string | null;
  format: string; status: string; attempts: number; error: string | null; created_at: string | null; printed_at: string | null;
}

const statusVariant: Record<string, 'success' | 'warning' | 'destructive' | 'muted' | 'info'> = {
  printed: 'success', queued: 'info', sent: 'warning', failed: 'destructive',
};

// Open the server-rendered receipt HTML in a new window (auth header → can't be a plain link).
async function openReceipt(saleNo: string, lang?: string) {
  const qs = lang ? `?lang=${encodeURIComponent(lang)}` : '';
  const res = await fetch(`${BASE}/api/print/receipt/${encodeURIComponent(saleNo)}${qs}`, { credentials: 'include' });
  const html = await res.text();
  const w = window.open('', '_blank', 'width=420,height=640');
  if (w) { w.document.open(); w.document.write(html); w.document.close(); }
}

type SendChannel = 'email' | 'line' | 'sms';
const CHANNELS: SendChannel[] = ['email', 'line', 'sms'];
const CHANNEL_PH: Record<SendChannel, string> = {
  email: 'guest@example.com',
  line: 'Uxxxxxxxxxxxxxxxx',
  sms: '08x-xxx-xxxx',
};

export default function PrintPage() {
  const { t } = useLang();
  const channelLabel = (c: SendChannel) => t(`px.print_ch_${c}`);
  const channelToLabel = (c: SendChannel) => t(`px.print_to_${c}`);
  const qc = useQueryClient();
  const [saleNo, setSaleNo] = useState('');
  const [channel, setChannel] = useState<SendChannel>('email');
  const [to, setTo] = useState('');
  const [lang, setLang] = useState('');   // '' = tenant default; th | en | both
  const q = useQuery<{ jobs: Job[] }>({ queryKey: ['print-jobs'], queryFn: () => api('/api/print/jobs?limit=100'), refetchInterval: 10_000 });

  const reprint = useMutation({
    mutationFn: (s: string) => api(`/api/print/reprint/${encodeURIComponent(s)}${lang ? `?lang=${lang}` : ''}`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('px.print_reprint_ok', { saleNo })); qc.invalidateQueries({ queryKey: ['print-jobs'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const send = useMutation({
    mutationFn: (b: { sale_no: string; channel: SendChannel; to: string }) => api(`/api/print/receipt/${encodeURIComponent(b.sale_no)}/send`, { method: 'POST', body: JSON.stringify({ channel: b.channel, to: b.to }) }),
    onSuccess: () => notifySuccess(t('px.print_sent_ok', { channel: channelLabel(channel), to })),
    onError: (e: Error) => notifyError(e.message),
  });

  return (
    <div>
      <PageHeader title={t('px.print_title')} description={t('px.print_desc')} />

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm">{t('px.print_card_reprint')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>{t('px.print_saleno_label')}</Label>
              <Input value={saleNo} onChange={(e) => setSaleNo(e.target.value.trim())} placeholder="SALE-T1-…" />
            </div>
            <div>
              <Label>{t('px.print_lang_label')}</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={lang} onChange={(e) => setLang(e.target.value)}>
                <option value="">{t('px.print_lang_default')}</option>
                <option value="th">{t('px.print_lang_th')}</option>
                <option value="en">English</option>
                <option value="both">{t('px.print_lang_both')}</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={!saleNo} onClick={() => openReceipt(saleNo, lang || undefined)}><FileText className="mr-1 h-4 w-4" />{t('px.print_open_btn')}</Button>
              <Button disabled={!saleNo || reprint.isPending} onClick={() => reprint.mutate(saleNo)}><Printer className="mr-1 h-4 w-4" />{t('px.print_reprint_btn')}</Button>
            </div>
            <div className="flex items-end gap-2">
              <div>
                <Label>{t('px.print_channel_label')}</Label>
                <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={channel} onChange={(e) => { setChannel(e.target.value as SendChannel); setTo(''); }}>
                  {CHANNELS.map((c) => <option key={c} value={c}>{channelLabel(c)}</option>)}
                </select>
              </div>
              <div className="flex-1">
                <Label>{channelToLabel(channel)}</Label>
                <Input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder={CHANNEL_PH[channel]} />
              </div>
              <Button variant="outline" disabled={!saleNo || !to || send.isPending} onClick={() => send.mutate({ sale_no: saleNo, channel, to })}><Send className="mr-1 h-4 w-4" />{t('px.print_send_btn')}</Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">{t('px.print_auto_title')}</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>{t('px.print_auto_p1a')} <b>{t('px.print_auto_pull')}</b> {t('px.print_auto_p1b')}</p>
            <p>{t('px.print_auto_p2')}</p>
          </CardContent>
        </Card>
      </div>

      <StateView q={q}>
        <DataTable
          rows={q.data?.jobs ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'id', label: '#', render: (r) => <span className="tabular">{r.id}</span> },
            { key: 'job_type', label: t('px.print_col_type'), render: (r) => r.job_type === 'receipt' ? t('px.print_type_receipt') : `${t('px.print_type_kitchen')}${r.station ? ` · ${r.station}` : ''}` },
            { key: 'sale_no', label: t('px.print_col_ref'), render: (r) => r.sale_no ?? r.order_no ?? '—' },
            { key: 'format', label: t('px.print_col_format'), render: (r) => <Badge variant="muted" className="uppercase text-[10px]">{r.format}</Badge> },
            { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant[r.status] ?? 'muted'}>{r.status}{r.attempts > 1 ? ` (${r.attempts})` : ''}</Badge> },
            { key: 'created_at', label: t('px.print_col_created'), render: (r) => thaiDateTime(r.created_at) },
            { key: 'act', label: '', align: 'right', render: (r) => r.sale_no ? <Button size="sm" variant="ghost" onClick={() => openReceipt(r.sale_no!)}><RefreshCw className="h-4 w-4" /></Button> : null },
          ]}
          emptyState={{
            icon: Inbox,
            title: t('px.print_empty_title'),
            description: t('px.print_empty_desc'),
          }}
        />
      </StateView>
    </div>
  );
}
