'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { CheckCheck, FileScan, FileText, ListChecks, Loader2, Paperclip, ScanLine, Send, ShieldAlert, ShieldCheck, Link2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
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
import { DocSelect } from '@/components/doc-select';

type Candidate = { po_no: string; vendor_name: string | null; total_amount: number; score: number };
type Intake = {
  intake_no: string; status: string; extract_source: string | null;
  vendor_name: string | null; vendor_tax_id: string | null; invoice_no: string | null; invoice_date: string | null;
  amount: number | null; currency: string | null; po_no: string | null; map_method: string | null;
  map_confidence: number; candidates: Candidate[]; dup_of: string | null;
  file_name: string | null; has_file: boolean;
  txn_no: string | null; match_status: string | null; payable: boolean | null; auto_posted?: boolean;
};

// Open the stored source document (object-store URL, or the inline data: URL via a blob URL).
async function openIntakeFile(intakeNo: string) {
  const f = await api<{ url: string | null; data_url: string | null }>(`/api/procurement/ap-intake/${encodeURIComponent(intakeNo)}/file`);
  const src = f.url ?? f.data_url;
  if (!src) return;
  if (src.startsWith('data:')) {
    const blob = await (await fetch(src)).blob();
    window.open(URL.createObjectURL(blob), '_blank');
  } else window.open(src, '_blank');
}

const statusVariant = (s: string) => (s === 'Posted' ? 'success' : s === 'Mapped' ? 'info' : 'warning');
const matchVariant = (s: string | null) => (s === 'matched' ? 'success' : s == null ? 'muted' : 'destructive');

// AP invoice intake (EXP-10): scan/paste a vendor invoice → auto-extract → auto-map to the PO →
// post the bill + run the 3-way match in one step. Payment stays behind the AP-PAY maker-checker.
export default function ApIntakePage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('iv.ap_title')}
        description={t('iv.ap_desc')}
      />
      <Tabs
        tabs={[
          { key: 'scan', label: t('iv.ap_tab_scan'), content: <ScanTab /> },
          { key: 'worklist', label: t('iv.ap_tab_worklist'), content: <WorklistTab /> },
        ]}
      />
    </div>
  );
}

function ScanTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [file, setFile] = useState<{ name: string; dataUrl: string } | null>(null);
  const [res, setRes] = useState<Intake | null>(null);

  const done = (r: Intake, msg: string) => {
    setRes(r);
    notifySuccess(`${msg} · ${r.intake_no}`);
    qc.invalidateQueries({ queryKey: ['ap-intake-list'] });
  };
  // With a file attached the upload endpoints take over; otherwise the pasted text is used.
  const body = () => (file ? { url: '/api/procurement/ap-intake/upload', payload: { file_name: file.name, data_url: file.dataUrl } } : { url: '/api/procurement/ap-intake', payload: { text } });
  const scan = useMutation({
    mutationFn: () => { const b = body(); return api<Intake>(b.url, { method: 'POST', body: JSON.stringify(b.payload) }); },
    onSuccess: (r) => done(r, r.po_no ? t('iv.ap_matched_po', { po: r.po_no }) : t('iv.ap_needs_review')),
    onError: (e) => notifyError((e as Error).message),
  });
  const auto = useMutation({
    mutationFn: () => { const b = body(); return api<Intake>(`${b.url}/auto`, { method: 'POST', body: JSON.stringify(b.payload) }); },
    onSuccess: (r) => done(r, r.auto_posted ? t('iv.ap_bill_posted_matched', { txn: r.txn_no ?? '' }) : t('iv.ap_not_posted_review')),
    onError: (e) => notifyError((e as Error).message),
  });
  const pickFile = (f: File | undefined) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setFile({ name: f.name, dataUrl: String(reader.result) });
    reader.readAsDataURL(f);
  };
  const ready = file != null || !!text.trim();

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="gap-4">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ScanLine className="size-4 text-primary" /> {t('iv.ap_doc_title')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent">
              <Paperclip className="size-4" /> {t('iv.ap_attach')}
              <input type="file" className="hidden" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => pickFile(e.target.files?.[0])} />
            </label>
            {file && (
              <span className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs">
                <FileText className="size-3" /> {file.name}
                <button aria-label={t('iv.ap_remove_file')} onClick={() => setFile(null)}><X className="size-3" /></button>
              </span>
            )}
          </div>
          <textarea className="min-h-44 w-full rounded-md border bg-transparent p-3 text-sm disabled:opacity-50" placeholder={t('iv.ap_paste_placeholder')} value={text} onChange={(e) => setText(e.target.value)} disabled={file != null} />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={scan.isPending || !ready} onClick={() => scan.mutate()}>
              {scan.isPending ? <Loader2 className="size-4 animate-spin" /> : <FileScan className="size-4" />} {t('iv.ap_extract_match')}
            </Button>
            <Button disabled={auto.isPending || !ready} onClick={() => auto.mutate()}>
              {auto.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t('iv.ap_full_auto')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('iv.ap_auto_hint')}</p>
        </CardContent>
      </Card>
      {res ? <IntakeDetail intake={res} onChanged={setRes} /> : (
        <Card><CardHeader><CardTitle className="text-base">{t('iv.ap_intake_result')}</CardTitle></CardHeader>
          <CardContent><p className="text-sm text-muted-foreground">{t('iv.ap_scan_hint')}</p></CardContent></Card>
      )}
    </div>
  );
}

function IntakeDetail({ intake: r, onChanged }: { intake: Intake; onChanged: (r: Intake) => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [manualPo, setManualPo] = useState('');
  // Full PO pending list for when the scored candidates above miss the right PO — pick, don't type.
  const posQ = useQuery<any>({ queryKey: ['ap-intake-pos'], queryFn: () => api('/api/inventory/purchase-orders?limit=50'), enabled: r.status !== 'Posted' });
  const poOptions = (posQ.data?.purchase_orders ?? []).map((p: any) => ({ value: p.PO_No, label: p.Supplier_Name || undefined }));
  const refresh = (x: Intake) => { onChanged(x); qc.invalidateQueries({ queryKey: ['ap-intake-list'] }); };

  const mapPo = useMutation({
    mutationFn: (po: string) => api<Intake>(`/api/procurement/ap-intake/${encodeURIComponent(r.intake_no)}/map`, { method: 'PUT', body: JSON.stringify({ po_no: po }) }),
    onSuccess: (x) => { refresh(x); notifySuccess(t('iv.ap_matched_po', { po: x.po_no ?? '' })); },
    onError: (e) => notifyError((e as Error).message),
  });
  const post = useMutation({
    mutationFn: () => api<Intake>(`/api/procurement/ap-intake/${encodeURIComponent(r.intake_no)}/post`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (x) => { refresh(x); notifySuccess(t('iv.ap_bill_posted', { txn: x.txn_no ?? '' })); },
    onError: (e) => notifyError((e as Error).message),
  });

  const rows: [string, any][] = [
    [t('fin.col_status'), <Badge key="s" variant={statusVariant(r.status)}>{r.status}</Badge>],
    [t('iv.ap_row_source_doc'), r.has_file ? (
      <button key="f" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline" onClick={() => openIntakeFile(r.intake_no)}>
        <FileText className="size-3.5" /> {r.file_name ?? t('iv.ap_open_file')}
      </button>
    ) : null],
    [t('inv.col_supplier'), r.vendor_name], [t('iv.ap_tax_id'), r.vendor_tax_id],
    [t('iv.ap_invoice_no'), r.invoice_no], [t('dash.col_date'), r.invoice_date],
    [t('iv.ap_amount'), r.amount != null ? num(r.amount) : null],
    [t('iv.ap_matched_po_label'), r.po_no ? `${r.po_no} (${r.map_method}, ${num(r.map_confidence)}%)` : null],
    [t('iv.ap_bill'), r.txn_no],
    [t('iv.ap_match_result_3way'), r.match_status ? <Badge key="m" variant={matchVariant(r.match_status)}>{r.match_status}</Badge> : null],
    [t('iv.ap_payable'), r.payable == null ? null : <Badge key="p" variant={r.payable ? 'success' : 'destructive'}>{r.payable ? t('iv.ap_payable') : t('iv.ap_on_hold')}</Badge>],
  ];

  return (
    <Card className="gap-4">
      <CardHeader><CardTitle className="text-base">{t('iv.ap_intake_result')} {r.intake_no} <span className="ml-1 text-xs text-muted-foreground">({r.extract_source})</span></CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {r.dup_of && (
          <p className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
            <ShieldAlert className="size-4 shrink-0" /> {t('iv.ap_dup_warn', { dup: r.dup_of })}
          </p>
        )}
        <table className="w-full text-sm"><tbody>
          {rows.map(([k, v]) => <tr key={k as string} className="border-b"><td className="px-2 py-1 text-muted-foreground">{k}</td><td className="px-2 py-1 text-right">{v == null || v === '' ? '—' : v}</td></tr>)}
        </tbody></table>

        {r.status !== 'Posted' && r.candidates.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('iv.ap_near_po')}</p>
            {r.candidates.map((c) => (
              <button key={c.po_no} className="flex w-full items-center justify-between rounded-md border p-2 text-sm hover:bg-accent" onClick={() => mapPo.mutate(c.po_no)} disabled={mapPo.isPending}>
                <span className="flex items-center gap-2"><Link2 className="size-4 text-primary" /> {c.po_no} · {c.vendor_name ?? '—'}</span>
                <span className="text-muted-foreground">{num(c.total_amount)} · {t('iv.ap_score', { score: c.score })}</span>
              </button>
            ))}
          </div>
        )}

        {r.status !== 'Posted' && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor="ai-po">{t('iv.ap_manual_po')}</Label>
              <DocSelect id="ai-po" className="w-56" value={manualPo} onValueChange={setManualPo} options={poOptions} placeholder={t('common.doc_select_ph')} emptyText={t('common.doc_none')} allowManual manualPlaceholder="PO-20260701-001" />
            </div>
            <Button variant="outline" disabled={mapPo.isPending || !manualPo.trim()} onClick={() => mapPo.mutate(manualPo.trim())}><Link2 className="size-4" /> {t('iv.ap_match')}</Button>
            <Button disabled={post.isPending} onClick={() => post.mutate()}>
              <CheckCheck className="size-4" /> {post.isPending ? t('iv.ap_saving') : r.po_no ? t('iv.ap_post_bill_match') : t('iv.ap_post_bill_no_po')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WorklistTab() {
  const { t } = useLang();
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<Intake | null>(null);
  const q = useQuery<{ intakes: Intake[]; count: number }>({
    queryKey: ['ap-intake-list', status],
    queryFn: () => api(`/api/procurement/ap-intake?limit=200${status ? `&status=${status}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const counts = (s: string) => (d?.intakes ?? []).filter((i) => i.status === s).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {['', 'NeedsReview', 'Mapped', 'Posted'].map((s) => (
          <Button key={s || 'all'} variant={status === s ? 'default' : 'outline'} onClick={() => setStatus(s)}>{s === '' ? t('iv.ap_all') : s}</Button>
        ))}
      </div>
      <StateView q={q}>
        {d && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <StatCard label={t('iv.ap_needs_review')} value={num(counts('NeedsReview'))} icon={ShieldAlert} tone={counts('NeedsReview') > 0 ? 'warning' : 'success'} />
              <StatCard label={t('iv.ap_stat_mapped')} value={num(counts('Mapped'))} icon={Link2} tone="info" />
              <StatCard label={t('iv.ap_stat_posted')} value={num(counts('Posted'))} icon={ShieldCheck} tone="primary" />
            </div>
            <DataTable
              rows={d.intakes}
              rowKey={(r: Intake) => r.intake_no}
              onRowClick={(r: Intake) => setSelected(r)}
              emptyState={{ icon: ListChecks, title: t('iv.ap_empty_title'), description: t('iv.ap_empty_desc') }}
              columns={[
                { key: 'intake_no', label: t('iv.ap_col_intake_no'), render: (r: Intake) => <span className="font-medium">{r.intake_no}</span> },
                { key: 'vendor_name', label: t('inv.col_supplier'), render: (r: Intake) => r.vendor_name ?? '—' },
                { key: 'invoice_no', label: t('iv.ap_col_invoice'), render: (r: Intake) => r.invoice_no ?? '—' },
                { key: 'amount', label: t('iv.ap_amount'), align: 'right', render: (r: Intake) => <span className="tabular">{r.amount != null ? num(r.amount) : '—'}</span> },
                { key: 'po_no', label: 'PO', render: (r: Intake) => r.po_no ?? '—' },
                { key: 'status', label: t('fin.col_status'), render: (r: Intake) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                { key: 'match_status', label: t('iv.ap_col_match_result'), render: (r: Intake) => r.match_status ? <Badge variant={matchVariant(r.match_status)}>{r.match_status}</Badge> : '—' },
                { key: 'txn_no', label: t('iv.ap_bill'), render: (r: Intake) => r.txn_no ?? '—' },
              ]}
            />
          </>
        )}
      </StateView>
      {selected && <IntakeDetail intake={selected} onChanged={setSelected} />}
    </div>
  );
}
