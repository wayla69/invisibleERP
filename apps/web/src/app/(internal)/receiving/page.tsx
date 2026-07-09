'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PackageCheck, Printer, Mail, Camera, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { baht, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FormField } from '@/components/form-field';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { statusVariant } from '@/components/ui';

const PO_LIST_KEY = ['receiving-pos'];
const GR_LIST_KEY = ['receiving-grs'];
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

// A PO can still take stock until every line is fully received — i.e. once it clears approval
// (Approved) and while it is only part-received (Received). Pending/Draft/Closed/Cancelled cannot.
function isReceivable(status: string): boolean {
  return status === 'Approved' || status === 'Received' || status === 'รับบางส่วน';
}

// Quantities can be fractional (weight lines) — show up to 3 decimals without trailing noise.
const fq = (x: number) => (Math.round(Number(x) * 1000) / 1000).toLocaleString('th-TH', { maximumFractionDigits: 3 });

// One quantity figure with its label — a labelled chip on the phone; on sm+ the label can hide because the
// desktop grid carries a column header instead. tabular-nums keeps the columns visually aligned.
function QtyStat({ label, value, className = '', labelOnDesktop = false }: { label: string; value: string; className?: string; labelOnDesktop?: boolean }) {
  // labelOnDesktop keeps the labelled-chip look at every size (summary dialog); without it the label and
  // chip styling drop away on sm+ where the form grid's column header takes over.
  const chip = labelOnDesktop
    ? 'rounded-md bg-muted/60 px-2 py-1 text-center'
    : 'rounded-md bg-muted/60 px-2 py-1 text-center sm:bg-transparent sm:px-0 sm:py-0 sm:text-right';
  return (
    <div className={`min-w-0 ${chip}`}>
      <p className={`truncate text-[10px] leading-tight text-muted-foreground ${labelOnDesktop ? '' : 'sm:hidden'}`}>{label}</p>
      <p className={`truncate text-sm font-semibold tabular-nums ${className}`}>{value}</p>
    </div>
  );
}

interface ReceiveLine {
  item_id: string; item_description: string | null; uom: string | null;
  order_qty: number; received_qty: number; remaining_qty: number; is_weight: boolean;
}
interface SummaryLine {
  item_id: string; item_description: string | null; uom: string | null;
  order_qty: number; received_now: number; received_total: number; shortage_qty: number; over_qty: number; is_weight: boolean;
}
interface GrResult {
  gr_no: string; po_no: string; po_status: string;
  summary: { claim_window_hours: number; claim_deadline: string; lines: SummaryLine[] };
}

// One-tap "รับครบ" — receive ALL outstanding qty on an approved PO in a single click (mirrors the LINE
// chat `receive <PO>` command). Uses POST /pos/:poNo/receive-all, which builds the GR lines from each
// PO line's remaining (order − received) and runs the ordinary GR path (EXP-03 gate + auto-close bind).
function ReceiveAllButton({ poNo }: { poNo: string }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: () => api(`/api/procurement/pos/${encodeURIComponent(poNo)}/receive-all`, { method: 'POST' }),
    onSuccess: (r: any) => {
      notifySuccess(r?.po_status === 'Closed' ? t('iv.recv_toast_closed', { po: poNo, gr: r.gr_no }) : t('iv.recv_toast_received', { gr: r?.gr_no ?? '' }));
      qc.invalidateQueries({ queryKey: PO_LIST_KEY });
      qc.invalidateQueries({ queryKey: GR_LIST_KEY });
    },
    onError: (e: any) => notifyError(e?.message ?? t('iv.recv_toast_failed')),
  });
  return (
    <Button size="sm" variant="secondary" disabled={mut.isPending} onClick={() => mut.mutate()}>
      {mut.isPending ? t('iv.recv_receiving') : t('iv.recv_receive_all')}
    </Button>
  );
}

// Warehouse / receiving surface (perm: wh_receive) — confirm goods receipt (GR) against an approved PO.
// Deliberately separate from the buyer's PO page so the person who orders cannot also confirm receipt
// (SoD R04 — preserves the 3-way match). The PO list below lets you look up the PO number, or receive
// the whole order in one tap with "รับครบ".
export default function ReceivingPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const pos = useQuery<any>({ queryKey: PO_LIST_KEY, queryFn: () => api('/api/inventory/purchase-orders?limit=50') });

  return (
    <div>
      <PageHeader title={t('iv.recv_title')} description={t('iv.recv_desc')} />

      <Card className="mb-6 gap-4">
        <CardHeader>
          <CardTitle className="text-base">{t('iv.recv_card_title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <PoReceiveForm
            pos={(pos.data?.purchase_orders ?? []).filter((r: any) => isReceivable(String(r.Status)))}
            onDone={() => { qc.invalidateQueries({ queryKey: PO_LIST_KEY }); qc.invalidateQueries({ queryKey: GR_LIST_KEY }); }}
          />
        </CardContent>
      </Card>

      <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('iv.recv_pending_pos')}</h3>
      <StateView q={pos}>
        {pos.data && (
          <DataTable
            rows={pos.data.purchase_orders}
            emptyState={{
              icon: PackageCheck,
              title: t('iv.recv_empty_title'),
              description: t('iv.recv_empty_desc'),
            }}
            columns={[
              { key: 'PO_No', label: t('iv.col_po_no') },
              { key: 'PO_Date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.PO_Date) },
              { key: 'Supplier_Name', label: t('inv.col_supplier') },
              { key: 'Total_Amount', label: t('fin.col_amount'), align: 'right', render: (r: any) => baht(r.Total_Amount) },
              { key: 'Status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.Status)}>{r.Status}</Badge> },
              { key: 'receive', label: '', align: 'right', render: (r: any) => (isReceivable(String(r.Status)) ? <ReceiveAllButton poNo={r.PO_No} /> : null) },
            ]}
          />
        )}
      </StateView>

      <GrListSection />
    </div>
  );
}

// PO-driven blind-count receiving (EXP-12): selecting the PO loads its lines (ordered / received /
// outstanding) so the receiver checks the delivery against the order — but the counted quantity is NEVER
// pre-filled, so a receipt requires an actual count. Over-receipt is blocked client-side (mirrored by the
// server gate); weight lines get the configurable % headroom. After confirming, the summary dialog shows
// ordered-vs-received, opens supplier claims (photo, within the claim window), and — on a shortage — asks
// whether to keep the PO open for a later delivery or close it short.
function PoReceiveForm({ pos = [], onDone }: { pos?: { PO_No: string; Supplier_Name?: string }[]; onDone?: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [poNo, setPoNo] = useState('');
  const [remarks, setRemarks] = useState('');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [result, setResult] = useState<GrResult | null>(null);

  const linesQ = useQuery<any>({
    queryKey: ['receiving-po-lines', poNo],
    queryFn: () => api(`/api/procurement/pos/${encodeURIComponent(poNo)}/receive-lines`),
    enabled: !!poNo,
  });
  const lines: ReceiveLine[] = linesQ.data?.lines ?? [];
  const weightPct = Number(linesQ.data?.over_receipt_weight_pct ?? 5);

  // Max receivable for a line: outstanding qty; a weight line additionally gets the tolerance headroom
  // above the ordered qty (matches the server's OVER_RECEIPT gate).
  const maxFor = (l: ReceiveLine) => (l.is_weight ? Math.max(l.order_qty * (1 + weightPct / 100) - l.received_qty, 0) : l.remaining_qty);
  const allDone = lines.length > 0 && lines.every((l) => maxFor(l) <= 0);
  const lineErr = (l: ReceiveLine): string | null => {
    const v = counts[l.item_id];
    if (v == null || v.trim() === '') return null;
    const q = Number(v);
    if (!(q > 0)) return t('proc.err_recv_gt0');
    if (q > maxFor(l) + 1e-9) return t('iv.recv_err_over', { max: fq(maxFor(l)) });
    return null;
  };
  const entered = lines.filter((l) => Number(counts[l.item_id]) > 0);
  const formErr = !poNo ? t('proc.err_po_no') : entered.length === 0 ? t('iv.recv_err_none') : null;
  const invalid = !!formErr || lines.some((l) => lineErr(l));

  const mut = useMutation({
    mutationFn: () => api<GrResult>('/api/procurement/grs', {
      method: 'POST',
      body: JSON.stringify({
        po_no: poNo,
        remarks: remarks || undefined,
        items: entered.map((l) => ({ item_id: l.item_id, received_qty: Number(counts[l.item_id]), uom: l.uom ?? undefined })),
      }),
    }),
    onSuccess: (d) => {
      notifySuccess(t('proc.gr_created', { no: d.gr_no }), t('proc.gr_created_desc', { po: d.po_no, status: d.po_status, n: String(d.summary?.lines?.filter((l) => l.received_now > 0).length ?? '') }));
      setResult(d);
      setCounts({});
      setRemarks('');
      setShowErrors(false);
      qc.invalidateQueries({ queryKey: ['receiving-po-lines', poNo] });
      onDone?.();
    },
    onError: (e: any) => notifyError(e?.message ?? t('proc.gr_failed')),
  });

  const submit = () => { setShowErrors(true); if (invalid) { notifyError(t('proc.fix_errors')); return; } mut.mutate(); };

  return (
    <div className="space-y-4">
      <FormField htmlFor="gr-po" label={t('proc.gr_po_no')} required error={showErrors && !poNo ? t('proc.err_po_no') : undefined} className="sm:max-w-sm">
        <Select value={poNo || undefined} onValueChange={(v) => { setPoNo(v); setCounts({}); setShowErrors(false); }}>
          <SelectTrigger id="gr-po" className="w-full" aria-invalid={showErrors && !poNo}>
            <SelectValue placeholder={t('proc.gr_po_select_ph')} />
          </SelectTrigger>
          <SelectContent>
            {pos.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">{t('proc.gr_po_none')}</div>
            ) : (
              pos.map((p) => (
                <SelectItem key={p.PO_No} value={p.PO_No}>
                  {p.PO_No}{p.Supplier_Name ? ` — ${p.Supplier_Name}` : ''}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </FormField>
      <FormField htmlFor="gr-remarks" label={t('proc.remarks')}>
        <Input id="gr-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={t('proc.remarks_ph')} />
      </FormField>

      {poNo && (
        <StateView q={linesQ}>
          {linesQ.data && (
            <div className="space-y-2">
              <Label>{t('iv.recv_lines_heading')}</Label>
              <p className="text-xs text-muted-foreground">{t('iv.recv_lines_hint')}</p>
              {allDone && <p className="text-sm text-muted-foreground">{t('iv.recv_no_outstanding')}</p>}
              {/* column header (sm+ only) — the phone layout labels every figure inline instead */}
              {lines.length > 0 && (
                <div className="hidden items-center gap-x-3 px-3 text-[11px] font-medium text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1fr)_repeat(3,4.5rem)_10rem]">
                  <span />
                  <span className="text-right">{t('iv.recv_col_ordered')}</span>
                  <span className="text-right">{t('iv.recv_col_received')}</span>
                  <span className="text-right">{t('iv.recv_col_remaining')}</span>
                  <span className="text-right">{t('iv.recv_col_count')}</span>
                </div>
              )}
              {lines.map((l) => {
                const err = lineErr(l);
                const done = maxFor(l) <= 0;
                return (
                  <div key={l.item_id} className={`rounded-md border p-3 ${done ? 'bg-muted/40' : ''}`}>
                    <div className="grid grid-cols-3 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_repeat(3,4.5rem)_10rem] sm:gap-x-3">
                      <div className="col-span-3 min-w-0 sm:col-span-1">
                        <p className="truncate text-sm font-medium">{l.item_description || l.item_id}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {l.item_id}{l.uom ? ` · ${l.uom}` : ''}
                          {l.is_weight && <span className="ml-1 text-amber-600 dark:text-amber-500">· {t('iv.recv_weight_hint', { pct: fq(weightPct) })}</span>}
                        </p>
                      </div>
                      <QtyStat label={t('iv.recv_col_ordered')} value={fq(l.order_qty)} />
                      <QtyStat label={t('iv.recv_col_received')} value={fq(l.received_qty)} />
                      <QtyStat label={t('iv.recv_col_remaining')} value={fq(l.remaining_qty)} className={l.remaining_qty > 0 ? '' : 'text-emerald-600'} />
                      <div className="col-span-3 sm:col-span-1">
                        {done ? (
                          <Badge variant="outline" className="w-full justify-center border-emerald-500 py-1.5 text-emerald-600 sm:w-auto sm:justify-end sm:border-0 sm:py-0">
                            ✓ {t('iv.recv_line_done')}
                          </Badge>
                        ) : (
                          <Input
                            type="number" min="0" step="any" inputMode="decimal"
                            className="h-11 text-base sm:h-9 sm:text-sm sm:text-right"
                            placeholder={t('iv.recv_count_ph')}
                            aria-label={`${t('iv.recv_col_count')} ${l.item_id}`}
                            value={counts[l.item_id] ?? ''}
                            aria-invalid={showErrors && !!err}
                            onChange={(e) => setCounts((c) => ({ ...c, [l.item_id]: e.target.value }))}
                          />
                        )}
                      </div>
                    </div>
                    {showErrors && err && <p className="mt-1 text-xs text-destructive" role="alert">{err}</p>}
                  </div>
                );
              })}
              {showErrors && formErr && <p className="text-xs text-destructive" role="alert">{formErr}</p>}
            </div>
          )}
        </StateView>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <Button size="lg" className="w-full sm:w-auto" disabled={mut.isPending || !poNo} onClick={submit}>
          {mut.isPending ? t('proc.saving') : t('iv.recv_confirm_btn')}
        </Button>
        {poNo && lines.length > 0 && (
          <p className="text-center text-xs text-muted-foreground sm:text-left">
            {t('iv.recv_entered_hint', { n: fq(entered.length), total: fq(lines.length) })}
          </p>
        )}
      </div>

      {result && <ReceiveSummaryDialog result={result} onClose={() => setResult(null)} onDone={onDone} />}
    </div>
  );
}

// Post-receipt summary (EXP-12): ordered vs received per line with shortage/overage badges, the claim
// window + per-line photo claims, and — when something is short — the keep-open / close-short decision.
function ReceiveSummaryDialog({ result, onClose, onDone }: { result: GrResult; onClose: () => void; onDone?: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const s = result.summary;
  const hasShortage = s.lines.some((l) => l.shortage_qty > 0);
  const [closedShort, setClosedShort] = useState(false);
  const deadline = new Date(s.claim_deadline).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });

  const closeShort = useMutation({
    mutationFn: () => api(`/api/procurement/pos/${encodeURIComponent(result.po_no)}/close-short`, { method: 'POST', body: JSON.stringify({ reason: `ของขาดส่ง — ตัดสินใจที่หน้ารับของ (GR ${result.gr_no})` }) }),
    onSuccess: () => {
      notifySuccess(t('iv.recv_closed_short', { po: result.po_no }));
      setClosedShort(true);
      qc.invalidateQueries({ queryKey: PO_LIST_KEY });
      onDone?.();
    },
    onError: (e: any) => notifyError(e?.message ?? t('iv.recv_toast_failed')),
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('iv.recv_sum_title', { gr: result.gr_no })}</DialogTitle>
          <DialogDescription>{t('iv.recv_sum_desc')}</DialogDescription>
        </DialogHeader>

        <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
          <Camera className="mr-1 inline size-3.5" />
          {t('iv.recv_claim_note', { h: String(s.claim_window_hours), when: deadline })}
        </p>

        <div className="space-y-2">
          {s.lines.map((l) => (
            <SummaryLineRow key={l.item_id} line={l} grNo={result.gr_no} poNo={result.po_no} />
          ))}
        </div>

        {hasShortage && !closedShort && result.po_status !== 'Closed' && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40">
            <p className="flex items-center gap-1 text-sm font-medium"><TriangleAlert className="size-4 text-amber-600" /> {t('iv.recv_short_title')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('iv.recv_short_desc')}</p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <Button size="sm" variant="secondary" className="w-full sm:w-auto" onClick={onClose}>{t('iv.recv_keep_open')}</Button>
              <Button size="sm" variant="destructive" className="w-full sm:w-auto" disabled={closeShort.isPending} onClick={() => closeShort.mutate()}>
                {closeShort.isPending ? t('proc.saving') : t('iv.recv_close_po')}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button className="w-full sm:w-auto" onClick={onClose}>{t('iv.recv_done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryLineRow({ line, grNo, poNo }: { line: SummaryLine; grNo: string; poNo: string }) {
  const { t } = useLang();
  const [claiming, setClaiming] = useState(false);
  const [claimedNo, setClaimedNo] = useState<string | null>(null);
  const statusBadge = line.shortage_qty > 0 ? (
    <Badge variant="destructive">{t('iv.recv_sum_short', { n: fq(line.shortage_qty) })}</Badge>
  ) : line.over_qty > 0 ? (
    <Badge variant="outline" className="border-amber-500 text-amber-600">{t('iv.recv_sum_over', { n: fq(line.over_qty) })}</Badge>
  ) : (
    <Badge variant="outline" className="border-emerald-500 text-emerald-600">✓ {t('iv.recv_sum_complete')}</Badge>
  );
  return (
    <div className="rounded-md border p-3">
      {/* name + verdict on their own row, figures on the next, actions last — nothing competes for width */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{line.item_description || line.item_id}</p>
          <p className="truncate text-xs text-muted-foreground">{line.item_id}{line.uom ? ` · ${line.uom}` : ''}</p>
        </div>
        <div className="shrink-0">{statusBadge}</div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 sm:max-w-sm">
        <QtyStat label={t('iv.recv_col_ordered')} value={fq(line.order_qty)} labelOnDesktop />
        <QtyStat label={t('iv.recv_sum_received_now')} value={fq(line.received_now)} labelOnDesktop />
        <QtyStat label={t('iv.recv_sum_total')} value={fq(line.received_total)} labelOnDesktop />
      </div>
      <div className="mt-2">
        {claimedNo ? (
          <Badge variant="secondary">{t('iv.recv_claim_created', { no: claimedNo })}</Badge>
        ) : (
          <Button size="sm" variant={claiming ? 'secondary' : 'outline'} className="w-full sm:w-auto" onClick={() => setClaiming((v) => !v)}>
            <Camera className="size-4" /> {t('iv.recv_claim_btn')}
          </Button>
        )}
      </div>
      {claiming && !claimedNo && (
        <GrClaimForm grNo={grNo} poNo={poNo} line={line} onCreated={(no) => { setClaimedNo(no); setClaiming(false); }} />
      )}
    </div>
  );
}

// Downscale a camera photo to fit the ~2MB data-URL cap (raw phone photos routinely exceed it).
function fileToDataUrl(file: File, maxDim = 1600): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(String(reader.result)); // not decodable as an image — send as-is, server validates
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        if (scale >= 1 && String(reader.result).length < 1_500_000) { resolve(String(reader.result)); return; }
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

// Inline supplier-claim form at the receiving dock: qty + reason + a photo taken on the spot. Posts to
// /api/claims/gr — the server enforces the claim window (CLAIM_WINDOW_CLOSED once it lapses).
function GrClaimForm({ grNo, poNo, line, onCreated }: { grNo: string; poNo: string; line: SummaryLine; onCreated: (claimNo: string) => void }) {
  const { t } = useLang();
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [showErr, setShowErr] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const mut = useMutation({
    mutationFn: () => api<{ claim_no: string }>('/api/claims/gr', {
      method: 'POST',
      body: JSON.stringify({
        gr_no: grNo, po_no: poNo, item_id: line.item_id, item_description: line.item_description ?? undefined,
        gr_qty: line.received_now, claim_qty: Number(qty), uom: line.uom ?? undefined,
        reason: reason || undefined, image_data_url: photo ?? undefined,
      }),
    }),
    onSuccess: (d) => { notifySuccess(t('iv.recv_claim_created', { no: d.claim_no })); onCreated(d.claim_no); },
    onError: (e: any) => notifyError(e?.message ?? t('iv.recv_toast_failed')),
  });

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { setPhoto(await fileToDataUrl(f)); } catch { notifyError(t('iv.recv_toast_failed')); }
    e.target.value = '';
  };

  const submit = () => {
    setShowErr(true);
    if (!(Number(qty) > 0)) { notifyError(t('iv.recv_claim_err_qty')); return; }
    mut.mutate();
  };

  return (
    <div className="mt-3 grid gap-2 border-t pt-3 sm:grid-cols-[8rem_1fr_auto_auto]">
      <Input
        type="number" min="0" step="any" inputMode="decimal" placeholder={t('iv.recv_claim_qty')}
        aria-label={t('iv.recv_claim_qty')} value={qty} aria-invalid={showErr && !(Number(qty) > 0)}
        onChange={(e) => setQty(e.target.value)}
      />
      <Input placeholder={t('iv.recv_claim_reason')} aria-label={t('iv.recv_claim_reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button type="button" variant={photo ? 'secondary' : 'outline'} onClick={() => fileRef.current?.click()}>
        <Camera className="size-4" /> {photo ? t('iv.recv_claim_photo_added') : t('iv.recv_claim_photo')}
      </Button>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFile} />
      <Button disabled={mut.isPending} onClick={submit}>
        {mut.isPending ? t('proc.saving') : t('iv.recv_claim_submit')}
      </Button>
    </div>
  );
}

// Recent goods receipts (GR notes) — print or email each ใบรับสินค้า. The email recipient defaults to the
// vendor's email on file (master data) when the prompt is left blank.
function GrListSection() {
  const { t } = useLang();
  const grs = useQuery<any>({ queryKey: GR_LIST_KEY, queryFn: () => api('/api/procurement/grs'), retry: false });
  const emailGr = useMutation({
    mutationFn: (v: { no: string; to_email?: string }) => api<{ to: string }>(`/api/procurement/grs/${encodeURIComponent(v.no)}/send-email`, { method: 'POST', body: JSON.stringify({ to_email: v.to_email }) }),
    onSuccess: (r) => notifySuccess(t('doc.email_sent', { to: r.to })),
    onError: (e: any) => notifyError(e.message),
  });
  const promptGrEmail = (no: string) => { const to = window.prompt(t('doc.email_prompt_default')); if (to === null) return; emailGr.mutate({ no, to_email: to.trim() || undefined }); };
  return (
    <div className="mt-8">
      <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('iv.recv_grs_heading')}</h3>
      <StateView q={grs}>
        {grs.data && (
          <DataTable
            rows={grs.data.grs ?? []}
            rowKey={(r: any) => r.gr_no}
            emptyState={{ icon: PackageCheck, title: t('iv.recv_grs_empty_title'), description: t('iv.recv_grs_empty_desc') }}
            columns={[
              { key: 'gr_no', label: t('iv.wms_gr_label') },
              { key: 'gr_date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.gr_date) },
              { key: 'po_no', label: t('iv.col_po_no'), render: (r: any) => r.po_no ?? '—' },
              { key: 'vendor_name', label: t('inv.col_supplier'), render: (r: any) => r.vendor_name ?? '—' },
              { key: 'act', label: '', align: 'right', sortable: false, render: (r: any) => (
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" size="sm" asChild title={t('doc.print_pdf')}>
                    <a href={`${BASE}/api/procurement/grs/${encodeURIComponent(r.gr_no)}/pdf`} target="_blank" rel="noopener noreferrer"><Printer className="size-4" /></a>
                  </Button>
                  <Button variant="ghost" size="sm" disabled={emailGr.isPending} title={t('doc.email')} onClick={() => promptGrEmail(r.gr_no)}><Mail className="size-4" /></Button>
                </div>
              ) },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
