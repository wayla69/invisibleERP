'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ScanLine, PackageCheck, ClipboardList, PackageSearch } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { statusVariant } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { QrScanButton } from '@/components/qr-scanner';
import { submitScan, newUuid, useOnline, useScanOutbox } from '@/lib/scan-outbox';
import { WifiOff } from 'lucide-react';
import { Select } from '@/components/form-controls';

const TYPES = ['GR', 'Issue', 'Transfer', 'Count'];

export default function MobileScanPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [sessionNo, setSessionNo] = useState('');
  const [type, setType] = useState('Count');
  const [loc, setLoc] = useState('WH-MAIN');
  const [scan, setScan] = useState('');
  const [qty, setQty] = useState('1');
  const online = useOnline();
  const outbox = useScanOutbox();

  const session = useQuery<any>({ queryKey: ['scan-session', sessionNo], queryFn: () => api(`/api/scan/sessions/${sessionNo}`), enabled: !!sessionNo });
  const recent = useQuery<any>({ queryKey: ['scan-sessions'], queryFn: () => api('/api/scan/sessions?limit=20'), enabled: !sessionNo });

  const open = useMutation({
    mutationFn: () => api<any>('/api/scan/sessions', { method: 'POST', body: JSON.stringify({ session_type: type, location_id: loc }) }),
    onSuccess: (r) => { setSessionNo(r.session_no); notifySuccess(t('iv.scan_toast_opened', { no: r.session_no })); },
    onError: (e: any) => notifyError(e.message),
  });
  const addLine = useMutation({
    mutationFn: (vars: { code: string; qty: number }) => api(`/api/scan/sessions/${sessionNo}/lines`, { method: 'POST', body: JSON.stringify({ qr_data: vars.code, qty: vars.qty, client_uuid: newUuid() }) }),
    onSuccess: () => { setScan(''); setQty('1'); qc.invalidateQueries({ queryKey: ['scan-session', sessionNo] }); },
    onError: (e: any) => notifyError(e.message),
  });
  // Continuous camera scanning is offline-capable: each read is queued (idempotent on client_uuid) and
  // replayed on reconnect. Falls back to a direct add when online.
  async function scanLine(code: string) {
    const r = await submitScan(`/api/scan/sessions/${sessionNo}/lines`, { qr_data: code, qty: 1 }, `scan ${sessionNo}`);
    outbox.refresh();
    if (!r.queued) qc.invalidateQueries({ queryKey: ['scan-session', sessionNo] });
  }
  const close = useMutation({
    mutationFn: () => api<any>(`/api/scan/sessions/${sessionNo}/close`, { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(t('iv.scan_toast_closed', { count: r.committed })); setSessionNo(''); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-4">
      <PageHeader title={t('iv.scan_title')} description={t('iv.scan_desc')} />
      {!sessionNo ? (
        <div className="space-y-4">
          <Card className="max-w-md gap-3 p-5">
            <h3 className="text-base font-semibold">{t('iv.scan_open_new')}</h3>
            <div className="grid gap-1.5"><Label>{t('iv.scan_type')}</Label><Select value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((tx) => <option key={tx} value={tx}>{tx}</option>)}</Select></div>
            <div className="grid gap-1.5"><Label>{t('iv.scan_location')}</Label><Input value={loc} onChange={(e) => setLoc(e.target.value)} /></div>
            <Button disabled={open.isPending} onClick={() => open.mutate()}><ScanLine className="size-4" /> {t('iv.scan_open_session')}</Button>
          </Card>
          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('iv.scan_recent')}</h3>
            <StateView q={recent}>
              {recent.data && (
                <DataTable
                  rows={recent.data.sessions}
                  columns={[
                    { key: 'session_no', label: t('dash.col_no') },
                    { key: 'session_type', label: t('iv.scan_type') },
                    { key: 'location_id', label: t('iv.scan_location') },
                    { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                    { key: 'act', label: '', render: (r: any) => r.status === 'Open' ? <Button size="sm" variant="outline" onClick={() => setSessionNo(r.session_no)}>{t('iv.scan_resume')}</Button> : null },
                  ]}
                  emptyState={{
                    icon: ClipboardList,
                    title: t('iv.scan_empty_title'),
                    description: t('iv.scan_empty_desc'),
                  }}
                />
              )}
            </StateView>
          </div>
        </div>
      ) : (
        <Card className="gap-3 p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold">{sessionNo} · {session.data?.session_type}</h3>
            <div className="flex items-center gap-2">
              {!online && <Badge variant="warning"><WifiOff className="mr-1 size-3" /> {t('qr.offline')}</Badge>}
              {outbox.count > 0 && <Badge variant="info">{t('qr.pending_sync', { n: outbox.count })}</Badge>}
              <Button variant="default" disabled={close.isPending} onClick={() => close.mutate()}><PackageCheck className="size-4" /> {t('iv.scan_close_commit')}</Button>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5 flex-1 min-w-[220px]"><Label>{t('iv.scan_scan_qr')}</Label><div className="flex items-center gap-2"><Input className="flex-1" value={scan} onChange={(e) => setScan(e.target.value)} placeholder="ITEM_ID:A|…" /><QrScanButton continuous onScan={scanLine} /></div></div>
            <div className="grid gap-1.5"><Label>{t('inv.col_qty')}</Label><Input type="number" className="max-w-[120px]" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
            <Button disabled={!scan || addLine.isPending} onClick={() => addLine.mutate({ code: scan, qty: Number(qty) })}>{t('iv.scan_add')}</Button>
          </div>
          <DataTable
            rows={session.data?.lines ?? []}
            columns={[
              { key: 'item_id', label: t('iv.scan_item') },
              { key: 'qty', label: t('inv.col_qty'), align: 'right', render: (r: any) => num(r.qty) },
              { key: 'action', label: t('iv.scan_action') },
            ]}
            emptyState={{
              icon: PackageSearch,
              title: t('iv.scan_lines_empty_title'),
              description: t('iv.scan_lines_empty_desc'),
            }}
          />
        </Card>
      )}
    </div>
  );
}
