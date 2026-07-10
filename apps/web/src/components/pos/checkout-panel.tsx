'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Banknote, CheckCircle2, CreditCard, Delete, Printer, QrCode, Send, ArrowLeftRight, TicketPercent, X } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { notifyError, notifySuccess } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cartTotals } from './cart';
import type { CartLine } from './types';

type Method = 'Cash' | 'PromptPay' | 'Card' | 'Transfer';
const METHODS: { id: Method; icon: typeof Banknote }[] = [
  { id: 'Cash', icon: Banknote },
  { id: 'PromptPay', icon: QrCode },
  { id: 'Card', icon: CreditCard },
  { id: 'Transfer', icon: ArrowLeftRight },
];
const METHOD_LABEL_KEYS: Record<Method, string> = {
  Cash: 'px.chk_m_Cash',
  PromptPay: 'px.chk_m_PromptPay',
  Card: 'px.chk_m_Card',
  Transfer: 'px.chk_m_Transfer',
};

export interface SettleResult { sale_no: string; total: number; change?: number; offline?: boolean }

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

interface VoucherPreview { valid: boolean; code?: string; discount?: number; reason?: string; message?: string; message_th?: string }

export function CheckoutPanel({
  lines, onSettle, onReprint, onSendReceipt, onClose, onFinish, serviceChargePct = 0,
}: {
  lines: CartLine[];
  onSettle: (p: { method: Method; discountPct: number; cashReceived?: number; voucherCode?: string }) => Promise<SettleResult>;
  onReprint: (saleNo: string) => Promise<void>;
  onSendReceipt: (saleNo: string, channel: 'email' | 'line', to: string) => Promise<void>;
  onClose: () => void;
  onFinish: () => void;
  serviceChargePct?: number; // mirrors the register's service-charge so the tendered total matches the cart
}) {
  const { t, lang } = useLang();
  const [discountPct, setDiscountPct] = useState(0);
  const [method, setMethod] = useState<Method>('Cash');
  const [cash, setCash] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SettleResult | null>(null);
  const [sendTo, setSendTo] = useState('');
  // POS-3 voucher/coupon code — validated server-side (/api/vouchers/validate) for a discount preview;
  // the actual redemption is atomic inside checkout. The panel figures stay an estimate (server total wins).
  const [voucher, setVoucher] = useState('');
  const [voucherInfo, setVoucherInfo] = useState<VoucherPreview | null>(null);
  const [voucherBusy, setVoucherBusy] = useState(false);

  const base = useMemo(() => cartTotals(lines, discountPct, serviceChargePct), [lines, discountPct, serviceChargePct]);
  // Mirror the server: the voucher competes for the order-discount slot (best wins, no stacking).
  const tot = useMemo(() => {
    const vDisc = voucherInfo?.valid ? round2(Math.min(voucherInfo.discount ?? 0, base.sub)) : 0;
    if (vDisc <= base.discount) return base;
    const net = round2(base.sub - vDisc);
    const serviceCharge = round2(net * (serviceChargePct || 0) / 100);
    const vat = round2((net + serviceCharge) * 0.07);
    return { ...base, discount: vDisc, net, serviceCharge, vat, total: round2(net + serviceCharge + vat) };
  }, [base, voucherInfo, serviceChargePct]);

  const checkVoucher = async () => {
    if (!voucher.trim()) return;
    setVoucherBusy(true);
    try {
      const r = await api<VoucherPreview>('/api/vouchers/validate', { method: 'POST', body: JSON.stringify({ code: voucher.trim(), subtotal: base.sub }) });
      setVoucherInfo({ ...r, code: r.code ?? voucher.trim() });
    } catch (e) {
      setVoucherInfo({ valid: false, reason: 'ERROR', message: (e as Error).message, message_th: (e as Error).message });
    } finally {
      setVoucherBusy(false);
    }
  };
  const clearVoucher = () => { setVoucher(''); setVoucherInfo(null); };
  const cashNum = cash === '' ? null : Number(cash);
  const change = method === 'Cash' && cashNum != null ? Math.round((cashNum - tot.total) * 100) / 100 : null;
  const cashShort = method === 'Cash' && cashNum != null && cashNum < tot.total;
  const methodLabel = (id: Method) => (METHOD_LABEL_KEYS[id] ? t(METHOD_LABEL_KEYS[id]) : id);

  // PromptPay QR (rendered server-side to a scannable image). Only fetched when that tender is selected.
  const qr = useQuery<{ promptpay_id: string; amount: number; qr_payload: string; qr_image: string | null }>({
    queryKey: ['promptpay-qr', tot.total],
    queryFn: () => api(`/api/payments/promptpay-qr?amount=${tot.total}`),
    enabled: method === 'PromptPay' && !result,
    retry: false,
  });

  const append = (d: string) => setCash((c) => (c === '0' ? d : c + d).slice(0, 9));
  const settle = async () => {
    setBusy(true);
    try {
      const r = await onSettle({ method, discountPct, cashReceived: cashNum ?? undefined, voucherCode: voucherInfo?.valid ? voucherInfo.code : undefined });
      setResult(r);
    } catch (e) {
      notifyError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ── success screen ──
  if (result) {
    return (
      <Dialog open onOpenChange={() => onFinish()}>
        <DialogContent className="max-w-md text-center">
          <div className="flex flex-col items-center gap-3 py-2">
            <CheckCircle2 className={cn('size-14', result.offline ? 'text-warning' : 'text-success')} />
            <h2 className="text-xl font-semibold">{result.offline ? t('px.chk_offline_saved') : t('px.chk_sale_ok')}</h2>
            {result.offline
              ? <p className="text-sm text-muted-foreground">{t('px.chk_offline_desc')}</p>
              : <p className="text-sm text-muted-foreground">{t('px.chk_sale_no')} <strong className="text-foreground">{result.sale_no}</strong></p>}
            <div className="tabular text-3xl font-bold">{baht(result.total)}</div>
            {result.change != null && result.change > 0 && (
              <div className="rounded-lg bg-success/10 px-4 py-2 text-success">
                {t('px.chk_change')} <strong className="tabular text-lg">{baht(result.change)}</strong>
              </div>
            )}
          </div>

          {result.offline ? (
            <Button className="w-full" onClick={onFinish}>{t('px.chk_next_sale')}</Button>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" onClick={() => onReprint(result.sale_no).catch((e) => notifyError((e as Error).message))}>
                  <Printer className="size-4" /> {t('px.chk_print')}
                </Button>
                <Button onClick={onFinish}>{t('px.chk_next_sale')}</Button>
              </div>

              <div className="mt-1 flex items-center gap-2 border-t pt-3">
                <Input placeholder={t('px.chk_recipient_ph')} value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!sendTo}
                  onClick={() => onSendReceipt(result.sale_no, sendTo.includes('@') ? 'email' : 'line', sendTo)
                    .then(() => notifySuccess(t('px.chk_sent_ok')))
                    .catch((e) => notifyError((e as Error).message))}
                >
                  <Send className="size-4" /> {t('px.chk_send')}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    );
  }

  // ── payment screen ──
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>{t('px.chk_pay')}</span>
            <span className="tabular text-2xl font-bold">{baht(tot.total)}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-2">
          {/* method + discount */}
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {METHODS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMethod(m.id)}
                  className={cn(
                    'flex h-16 flex-col items-center justify-center gap-1 rounded-xl border text-sm font-medium transition-colors',
                    method === m.id ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-accent',
                  )}
                >
                  <m.icon className="size-5" /> {methodLabel(m.id)}
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
              <span className="text-muted-foreground">{t('px.chk_bill_discount')}</span>
              <Input
                type="number" min={0} max={100} step={1} inputMode="numeric"
                className="h-8 w-20 tabular text-right"
                value={discountPct || ''}
                onChange={(e) => setDiscountPct(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
              />
            </div>
            {/* POS-3: voucher / coupon code (campaign voucher or loyalty wallet coupon — one field) */}
            <div className="rounded-lg border px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <TicketPercent className="size-4 shrink-0 text-muted-foreground" />
                <Input
                  placeholder={t('px.chk_voucher_ph')}
                  className="h-8 font-mono uppercase"
                  value={voucher}
                  onChange={(e) => { setVoucher(e.target.value.toUpperCase()); setVoucherInfo(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') void checkVoucher(); }}
                />
                {voucherInfo ? (
                  <Button type="button" variant="ghost" size="sm" onClick={clearVoucher} aria-label={t('px.chk_voucher_clear')}><X className="size-4" /></Button>
                ) : (
                  <Button type="button" variant="secondary" size="sm" disabled={!voucher.trim() || voucherBusy} onClick={() => void checkVoucher()}>
                    {voucherBusy ? '…' : t('px.chk_voucher_check')}
                  </Button>
                )}
              </div>
              {voucherInfo?.valid && (
                <div className="mt-1.5 flex items-center justify-between text-success">
                  <span>{t('px.chk_voucher_ok')}</span><span className="tabular">−{baht(round2(Math.min(voucherInfo.discount ?? 0, base.sub)))}</span>
                </div>
              )}
              {voucherInfo && !voucherInfo.valid && (
                <div className="mt-1.5 text-destructive">{(lang === 'th' ? voucherInfo.message_th : voucherInfo.message) || voucherInfo.reason}</div>
              )}
            </div>
            {tot.discount > 0 && (
              <div className="flex items-center justify-between px-1 text-sm text-muted-foreground">
                <span>{t('px.chk_discount')}</span><span className="tabular text-destructive">−{baht(tot.discount)}</span>
              </div>
            )}
            {tot.serviceCharge > 0 && (
              <div className="flex items-center justify-between px-1 text-sm text-muted-foreground">
                <span>{t('px.chk_service_charge', { pct: serviceChargePct })}</span><span className="tabular">+{baht(tot.serviceCharge)}</span>
              </div>
            )}
          </div>

          {/* contextual tender pad */}
          <div className="rounded-xl border p-3">
            {method === 'Cash' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t('px.chk_cash_received')}</span>
                  <span className="tabular text-xl font-semibold">{cash === '' ? '—' : baht(cashNum!)}</span>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  <Button type="button" variant="secondary" size="sm" onClick={() => setCash(String(tot.total))}>{t('px.chk_exact')}</Button>
                  {[100, 500, 1000].map((d) => (
                    <Button key={d} type="button" variant="secondary" size="sm" onClick={() => setCash(String(d))}>฿{d}</Button>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                    <Button key={d} type="button" variant="outline" className="h-11 text-base" onClick={() => append(d)}>{d}</Button>
                  ))}
                  <Button type="button" variant="outline" className="h-11 text-base" onClick={() => append('0')}>0</Button>
                  <Button type="button" variant="outline" className="h-11 text-base" onClick={() => append('00')}>00</Button>
                  <Button type="button" variant="outline" className="h-11" onClick={() => setCash((c) => c.slice(0, -1))} aria-label={t('px.chk_aria_delete')}><Delete className="size-4" /></Button>
                </div>
                <div className={cn('flex items-center justify-between rounded-lg px-3 py-2 text-sm', cashShort ? 'bg-destructive/10 text-destructive' : 'bg-muted')}>
                  <span>{cashShort ? t('px.chk_insufficient') : t('px.chk_change')}</span>
                  <span className="tabular font-semibold">{change != null ? baht(change) : '—'}</span>
                </div>
              </div>
            )}

            {method === 'PromptPay' && (
              <div className="flex flex-col items-center gap-2 text-center">
                {qr.isLoading && <p className="text-sm text-muted-foreground">{t('px.chk_generating_qr')}</p>}
                {qr.data?.qr_image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qr.data.qr_image} alt="PromptPay QR" className="size-44 rounded-lg border bg-white p-1" />
                )}
                {qr.error && <p className="text-sm text-destructive">{(qr.error as Error).message}</p>}
                <div className="text-sm text-muted-foreground">{t('px.chk_scan_to_pay')} <strong className="tabular text-foreground">{baht(tot.total)}</strong></div>
                <p className="text-xs text-muted-foreground">{t('px.chk_confirm_when_paid')}</p>
              </div>
            )}

            {(method === 'Card' || method === 'Transfer') && (
              <div className="grid h-full place-items-center text-center text-sm text-muted-foreground">
                <div>
                  {method === 'Card' ? <CreditCard className="mx-auto mb-2 size-8 opacity-40" /> : <ArrowLeftRight className="mx-auto mb-2 size-8 opacity-40" />}
                  {t('px.chk_accept_via', { amount: baht(tot.total), via: method === 'Card' ? t('px.chk_via_card') : t('px.chk_via_transfer') })}<br />
                  {t('px.chk_confirm_when_received')}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <Button variant="outline" onClick={onClose}><ArrowLeft className="size-4" /> {t('px.chk_back_to_cart')}</Button>
          <Button className="h-11 px-6 text-base" disabled={busy || cashShort} onClick={settle}>
            {busy ? t('px.chk_saving') : t('px.chk_confirm_pay', { amount: baht(tot.total) })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
