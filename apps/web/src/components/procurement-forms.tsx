'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { notifyError, notifySuccess } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FormField } from '@/components/form-field';

// Shared line-error affordance: a red hint under a line row (shown only after a submit attempt). Line-level
// validation only kicks in once a line has an Item ID, so the trailing empty "add-a-line" row never nags.
function LineError({ show, msg }: { show: boolean; msg?: string | null }) {
  if (!show || !msg) return null;
  return <p className="col-span-full -mt-1 text-xs text-destructive" role="alert">{msg}</p>;
}

const posNum = (v: unknown) => Number(v) > 0;
const nonNeg = (v: unknown) => Number(v) >= 0;

// ── PR ──
interface PrLine { item_id: string; item_description: string; request_qty: number; uom: string; required_date: string }
const emptyPrLine = (): PrLine => ({ item_id: '', item_description: '', request_qty: 1, uom: '', required_date: '' });

export function PrForm({ onDone }: { onDone?: () => void }) {
  const { t } = useLang();
  const [remarks, setRemarks] = useState('');
  const [priority, setPriority] = useState('');
  const [lines, setLines] = useState<PrLine[]>([emptyPrLine()]);
  const [showErrors, setShowErrors] = useState(false);
  const setLine = (i: number, p: Partial<PrLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const lineErr = (l: PrLine) => (l.item_id.trim() && !posNum(l.request_qty) ? t('proc.err_qty_gt0') : null);
  const submittable = lines.filter((l) => l.item_id.trim() && posNum(l.request_qty));
  const formErr = submittable.length === 0 ? t('proc.err_need_line') : null;
  const invalid = !!formErr || lines.some((l) => lineErr(l));

  const mut = useMutation({
    mutationFn: () => api<{ pr_no: string; status: string; lines: number }>('/api/procurement/prs', {
      method: 'POST',
      body: JSON.stringify({
        remarks: remarks || undefined,
        priority: priority || undefined,
        items: submittable.map((l) => ({
          item_id: l.item_id,
          item_description: l.item_description || undefined,
          request_qty: Number(l.request_qty),
          uom: l.uom || undefined,
          required_date: l.required_date || undefined,
        })),
      }),
    }),
    onSuccess: (d) => { notifySuccess(t('proc.pr_created', { no: d.pr_no }), t('proc.pr_created_desc', { n: d.lines, status: d.status })); onDone?.(); },
    onError: (e: any) => notifyError(e?.message ?? t('proc.pr_failed')),
  });

  const submit = () => { setShowErrors(true); if (invalid) { notifyError(t('proc.fix_errors')); return; } mut.mutate(); };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField htmlFor="pr-remarks" label={t('proc.remarks')}>
          <Input id="pr-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={t('proc.remarks_ph')} />
        </FormField>
        <FormField htmlFor="pr-priority" label={t('proc.priority')} hint={t('proc.priority_ph')}>
          <Input id="pr-priority" value={priority} onChange={(e) => setPriority(e.target.value)} placeholder={t('proc.priority_ph')} />
        </FormField>
      </div>
      <div className="space-y-2">
        <Label>{t('proc.items')}</Label>
        {lines.map((l, i) => (
          // Fixed 6-column layout only from sm+ (where it fits); on a phone every field stacks full-width
          // (qty/uom share a row) so nothing gets squeezed unreadably narrow.
          <div key={i} className="grid grid-cols-2 gap-2 rounded-md border p-2 sm:grid-cols-[1.5fr_2fr_1fr_1fr_1.3fr_auto] sm:items-center sm:border-0 sm:p-0">
            <Input className="col-span-2 sm:col-span-1" placeholder="Item ID" value={l.item_id} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { item_id: e.target.value })} />
            <Input className="col-span-2 sm:col-span-1" placeholder={t('proc.item_desc')} value={l.item_description} onChange={(e) => setLine(i, { item_description: e.target.value })} />
            <Input type="number" min="0" placeholder={t('inv.col_qty')} value={l.request_qty} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { request_qty: +e.target.value })} />
            <Input placeholder={t('inv.col_uom')} value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} />
            <Input className="col-span-2 sm:col-span-1" type="date" value={l.required_date} onChange={(e) => setLine(i, { required_date: e.target.value })} />
            <Button variant="destructive" size="icon" aria-label={t('shop.remove')} title={t('shop.remove')} className="justify-self-start sm:col-span-1" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              <X className="size-4" />
            </Button>
            <LineError show={showErrors} msg={lineErr(l)} />
          </div>
        ))}
        {showErrors && formErr && <p className="text-xs text-destructive" role="alert">{formErr}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setLines((ls) => [...ls, emptyPrLine()])}>
          <Plus className="size-4" /> {t('proc.add_line')}
        </Button>
        <Button disabled={mut.isPending} onClick={submit}>
          {mut.isPending ? t('proc.saving') : t('proc.create_pr')}
        </Button>
      </div>
    </div>
  );
}

// ── PO ──
interface PoLine { item_id: string; item_description: string; order_qty: number; unit_price: number; uom: string; is_capital: boolean }
const emptyPoLine = (): PoLine => ({ item_id: '', item_description: '', order_qty: 1, unit_price: 0, uom: '', is_capital: false });

export function PoForm({ onDone }: { onDone?: () => void }) {
  const { t } = useLang();
  const [vendorName, setVendorName] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<PoLine[]>([emptyPoLine()]);
  const [showErrors, setShowErrors] = useState(false);
  const setLine = (i: number, p: Partial<PoLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const vendorErr = !vendorName.trim() && !vendorId.trim() ? t('proc.err_vendor') : null;
  const lineErr = (l: PoLine) => {
    if (!l.item_id.trim()) return null;
    if (!posNum(l.order_qty)) return t('proc.err_qty_gt0');
    if (!nonNeg(l.unit_price)) return t('proc.err_price_neg');
    return null;
  };
  const submittable = lines.filter((l) => l.item_id.trim() && posNum(l.order_qty) && nonNeg(l.unit_price));
  const formErr = submittable.length === 0 ? t('proc.err_need_line') : null;
  const invalid = !!vendorErr || !!formErr || lines.some((l) => lineErr(l));

  const mut = useMutation({
    mutationFn: () => api<{ po_no: string; status: string }>('/api/procurement/pos', {
      method: 'POST',
      body: JSON.stringify({
        vendor_name: vendorName || undefined,
        vendor_id: vendorId || undefined,
        expected_date: expectedDate || undefined,
        remarks: remarks || undefined,
        items: submittable.map((l) => ({
          item_id: l.item_id,
          item_description: l.item_description || undefined,
          order_qty: Number(l.order_qty),
          unit_price: Number(l.unit_price),
          uom: l.uom || undefined,
          is_capital: l.is_capital || undefined,
        })),
      }),
    }),
    onSuccess: (d) => { notifySuccess(t('proc.po_created', { no: d.po_no }), t('proc.po_created_desc', { status: d.status })); onDone?.(); },
    onError: (e: any) => notifyError(e?.message ?? t('proc.po_failed')),
  });

  const submit = () => { setShowErrors(true); if (invalid) { notifyError(t('proc.fix_errors')); return; } mut.mutate(); };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField htmlFor="po-vendor" label={t('inv.col_supplier')} required error={showErrors ? vendorErr : undefined}>
          <Input id="po-vendor" value={vendorName} aria-invalid={showErrors && !!vendorErr} onChange={(e) => setVendorName(e.target.value)} placeholder={t('proc.vendor_name_ph')} />
        </FormField>
        <FormField htmlFor="po-vendor-id" label={t('proc.vendor_id')} hint={t('proc.vendor_id_hint')}>
          <Input id="po-vendor-id" value={vendorId} aria-invalid={showErrors && !!vendorErr} onChange={(e) => setVendorId(e.target.value)} placeholder={t('proc.vendor_id_ph')} />
        </FormField>
        <FormField htmlFor="po-expected" label={t('proc.expected_date')}>
          <Input id="po-expected" type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
        </FormField>
        <FormField htmlFor="po-remarks" label={t('proc.remarks')}>
          <Input id="po-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={t('proc.remarks_ph')} />
        </FormField>
      </div>
      <div className="space-y-2">
        <Label>{t('proc.items')}</Label>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1.5fr_2fr_1fr_1fr_1fr_auto_auto] items-center gap-2">
            <Input placeholder="Item ID" value={l.item_id} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { item_id: e.target.value })} />
            <Input placeholder={t('proc.item_desc')} value={l.item_description} onChange={(e) => setLine(i, { item_description: e.target.value })} />
            <Input type="number" min="0" placeholder={t('inv.col_qty')} value={l.order_qty} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { order_qty: +e.target.value })} />
            <Input type="number" min="0" step="0.01" placeholder={t('proc.unit_price_ph')} value={l.unit_price} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { unit_price: +e.target.value })} />
            <Input placeholder={t('inv.col_uom')} value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} />
            <label className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground" title={t('proc.capital_title')}>
              <input type="checkbox" checked={l.is_capital} onChange={(e) => setLine(i, { is_capital: e.target.checked })} /> {t('proc.capital')}
            </label>
            <Button variant="destructive" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              <X className="size-4" />
            </Button>
            <LineError show={showErrors} msg={lineErr(l)} />
          </div>
        ))}
        {showErrors && formErr && <p className="text-xs text-destructive" role="alert">{formErr}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setLines((ls) => [...ls, emptyPoLine()])}>
          <Plus className="size-4" /> {t('proc.add_line')}
        </Button>
        <Button disabled={mut.isPending} onClick={submit}>
          {mut.isPending ? t('proc.saving') : t('proc.create_po')}
        </Button>
      </div>
    </div>
  );
}

// ── GR ──
interface GrLine { item_id: string; received_qty: number; lot_no: string; expiry_date: string; unit_cost: number | ''; uom: string }
const emptyGrLine = (): GrLine => ({ item_id: '', received_qty: 1, lot_no: '', expiry_date: '', unit_cost: '', uom: '' });

export function GrForm({ onDone }: { onDone?: () => void }) {
  const { t } = useLang();
  const [poNo, setPoNo] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<GrLine[]>([emptyGrLine()]);
  const [showErrors, setShowErrors] = useState(false);
  const setLine = (i: number, p: Partial<GrLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const poErr = !poNo.trim() ? t('proc.err_po_no') : null;
  const lineErr = (l: GrLine) => {
    if (!l.item_id.trim()) return null;
    if (!posNum(l.received_qty)) return t('proc.err_recv_gt0');
    if (l.unit_cost !== '' && !nonNeg(l.unit_cost)) return t('proc.err_cost_neg');
    return null;
  };
  const submittable = lines.filter((l) => l.item_id.trim() && posNum(l.received_qty));
  const formErr = submittable.length === 0 ? t('proc.err_need_line') : null;
  const invalid = !!poErr || !!formErr || lines.some((l) => lineErr(l));

  const mut = useMutation({
    mutationFn: () => api<{ gr_no: string; po_no: string; po_status: string; lines: number }>('/api/procurement/grs', {
      method: 'POST',
      body: JSON.stringify({
        po_no: poNo,
        remarks: remarks || undefined,
        items: submittable.map((l) => ({
          item_id: l.item_id,
          received_qty: Number(l.received_qty),
          lot_no: l.lot_no || undefined,
          expiry_date: l.expiry_date || undefined,
          unit_cost: l.unit_cost === '' ? undefined : Number(l.unit_cost),
          uom: l.uom || undefined,
        })),
      }),
    }),
    onSuccess: (d) => { notifySuccess(t('proc.gr_created', { no: d.gr_no }), t('proc.gr_created_desc', { po: d.po_no, status: d.po_status, n: d.lines })); onDone?.(); },
    onError: (e: any) => notifyError(e?.message ?? t('proc.gr_failed')),
  });

  const submit = () => { setShowErrors(true); if (invalid) { notifyError(t('proc.fix_errors')); return; } mut.mutate(); };

  return (
    <div className="space-y-4">
      <FormField htmlFor="gr-po" label={t('proc.gr_po_no')} required error={showErrors ? poErr : undefined} className="sm:max-w-sm">
        <Input id="gr-po" value={poNo} aria-invalid={showErrors && !!poErr} onChange={(e) => setPoNo(e.target.value)} placeholder="PO-…" />
      </FormField>
      <FormField htmlFor="gr-remarks" label={t('proc.remarks')}>
        <Input id="gr-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={t('proc.remarks_ph')} />
      </FormField>
      <div className="space-y-2">
        <Label>{t('proc.gr_lines')}</Label>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1.5fr_1fr_1.3fr_1.3fr_1fr_1fr_auto] gap-2">
            <Input placeholder="Item ID" value={l.item_id} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { item_id: e.target.value })} />
            <Input type="number" min="0" placeholder={t('proc.received_ph')} value={l.received_qty} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { received_qty: +e.target.value })} />
            <Input placeholder="Lot" value={l.lot_no} onChange={(e) => setLine(i, { lot_no: e.target.value })} />
            <Input type="date" value={l.expiry_date} onChange={(e) => setLine(i, { expiry_date: e.target.value })} />
            <Input type="number" min="0" step="0.01" placeholder={t('proc.cost_ph')} value={l.unit_cost} aria-invalid={showErrors && !!lineErr(l)} onChange={(e) => setLine(i, { unit_cost: e.target.value === '' ? '' : +e.target.value })} />
            <Input placeholder={t('inv.col_uom')} value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} />
            <Button variant="destructive" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              <X className="size-4" />
            </Button>
            <LineError show={showErrors} msg={lineErr(l)} />
          </div>
        ))}
        {showErrors && formErr && <p className="text-xs text-destructive" role="alert">{formErr}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setLines((ls) => [...ls, emptyGrLine()])}>
          <Plus className="size-4" /> {t('proc.add_line')}
        </Button>
        <Button disabled={mut.isPending} onClick={submit}>
          {mut.isPending ? t('proc.saving') : t('proc.create_gr')}
        </Button>
      </div>
    </div>
  );
}
