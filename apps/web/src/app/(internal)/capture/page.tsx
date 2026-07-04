'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Upload, Loader2, CheckCircle2, Receipt, FileText, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLang } from '@/lib/i18n';

type Intake = {
  intake_no: string; status: string; extract_source: string | null;
  vendor_name: string | null; invoice_no: string | null; invoice_date: string | null;
  amount: number | null; currency: string | null; created_at?: string | null;
};

// Machine status codes → i18n keys (resolved at render with a raw-code fallback).
const STATUS_KEY: Record<string, string> = { NeedsReview: 'iv.cap_status_needsreview', Mapped: 'iv.cap_status_mapped', Posted: 'iv.cap_status_posted' };
const statusVariant = (s: string) => (s === 'Posted' ? 'success' : s === 'Mapped' ? 'info' : 'warning');

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('READ_FAIL'));
    r.readAsDataURL(f);
  });
}

// Quick Capture lane (docs/34, paypers-style). Any staffer holding a bill snaps/uploads it; the AP-intake
// engine extracts the fields and files it as a NeedsReview draft for Accounting to book. Draft-only — this
// screen never books a bill or touches the GL (that stays a creditors action, SoD/EXP-06).
export default function CapturePage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [last, setLast] = useState<Intake | null>(null);
  const statusLabel = (s: string) => (STATUS_KEY[s] ? t(STATUS_KEY[s]) : s);

  const mine = useQuery({
    queryKey: ['ap-capture-mine'],
    queryFn: () => api<{ intakes: Intake[]; count: number }>('/api/procurement/ap-intake/mine?limit=20'),
  });

  const capture = useMutation({
    mutationFn: async (f: File) => {
      let dataUrl: string;
      try { dataUrl = await readAsDataUrl(f); } catch { throw new Error(t('iv.cap_read_fail')); }
      return api<Intake>('/api/procurement/ap-intake/capture', { method: 'POST', body: JSON.stringify({ file_name: f.name, data_url: dataUrl }) });
    },
    onSuccess: (r) => {
      setLast(r);
      notifySuccess(t('iv.cap_sent_toast', { no: r.intake_no }));
      qc.invalidateQueries({ queryKey: ['ap-capture-mine'] });
    },
    onError: (e) => notifyError((e as Error).message),
  });

  const pick = (f: File | undefined) => { if (f) capture.mutate(f); };

  return (
    <div>
      <PageHeader
        title={t('iv.cap_title')}
        description={t('iv.cap_desc')}
      />

      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4 text-primary" /> {t('iv.cap_snap_upload')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Button size="lg" className="h-24 flex-col gap-2" disabled={capture.isPending} onClick={() => cameraRef.current?.click()}>
                {capture.isPending ? <Loader2 className="size-6 animate-spin" /> : <Camera className="size-6" />}
                <span>{t('iv.cap_take_photo')}</span>
              </Button>
              <Button size="lg" variant="outline" className="h-24 flex-col gap-2" disabled={capture.isPending} onClick={() => fileRef.current?.click()}>
                <Upload className="size-6" />
                <span>{t('iv.cap_choose_file')}</span>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('iv.cap_formats_note')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">{t('iv.cap_latest_result')}</CardTitle></CardHeader>
          <CardContent>
            {last ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="size-4" /> {t('iv.cap_captured', { no: last.intake_no })}
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">{t('iv.cap_vendor')}</dt><dd>{last.vendor_name ?? '—'}</dd>
                  <dt className="text-muted-foreground">{t('iv.ap_invoice_no')}</dt><dd>{last.invoice_no ?? '—'}</dd>
                  <dt className="text-muted-foreground">{t('dash.col_date')}</dt><dd>{last.invoice_date ?? '—'}</dd>
                  <dt className="text-muted-foreground">{t('iv.ap_amount')}</dt><dd>{last.amount != null ? `${num(last.amount)} ${last.currency ?? 'THB'}` : '—'}</dd>
                  <dt className="text-muted-foreground">{t('fin.col_status')}</dt><dd><Badge variant={statusVariant(last.status)}>{statusLabel(last.status)}</Badge></dd>
                </dl>
                <p className="text-xs text-muted-foreground">
                  {last.extract_source === 'none'
                    ? t('iv.cap_extract_none')
                    : t('iv.cap_extract_ai')}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('iv.cap_empty_last')}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Receipt className="size-4 text-primary" /> {t('iv.cap_recent')}</CardTitle></CardHeader>
        <CardContent>
          {mine.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t('dash.loading')}</div>
          ) : (mine.data?.intakes.length ?? 0) === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
              <FileText className="size-8 opacity-40" />
              <p className="text-sm">{t('iv.cap_empty_recent')}</p>
            </div>
          ) : (
            <ul className="divide-y">
              {mine.data!.intakes.map((it) => (
                <li key={it.intake_no} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{it.vendor_name ?? t('iv.cap_unknown_vendor')}</div>
                    <div className="text-xs text-muted-foreground">{it.intake_no} · {it.invoice_no ?? t('iv.cap_no_invoice_no')} · {it.invoice_date ?? '—'}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="tabular-nums">{it.amount != null ? num(it.amount) : '—'}</span>
                    <Badge variant={statusVariant(it.status)}>{statusLabel(it.status)}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
