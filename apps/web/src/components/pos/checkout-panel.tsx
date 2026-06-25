'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Banknote, CheckCircle2, CreditCard, Delete, Printer, QrCode, Send, ArrowLeftRight } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { cn } from '@/lib/utils';
import { notifyError, notifySuccess } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cartTotals } from './cart';
import type { CartLine } from './types';

type Method = 'Cash' | 'PromptPay' | 'Card' | 'Transfer';
const METHODS: { id: Method; label: string; icon: typeof Banknote }[] = [
  { id: 'Cash', label: 'เงินสด', icon: Banknote },
  { id: 'PromptPay', label: 'QR พร้อมเพย์', icon: QrCode },
  { id: 'Card', label: 'บัตร', icon: CreditCard },
  { id: 'Transfer', label: 'โอน', icon: ArrowLeftRight },
];

export interface SettleResult { sale_no: string; total: number; change?: number }

export function CheckoutPanel({
  lines, onSettle, onReprint, onSendReceipt, onClose, onFinish,
}: {
  lines: CartLine[];
  onSettle: (p: { method: Method; discountPct: number; cashReceived?: number }) => Promise<SettleResult>;
  onReprint: (saleNo: string) => Promise<void>;
  onSendReceipt: (saleNo: string, channel: 'email' | 'line', to: string) => Promise<void>;
  onClose: () => void;
  onFinish: () => void;
}) {
  const [discountPct, setDiscountPct] = useState(0);
  const [method, setMethod] = useState<Method>('Cash');
  const [cash, setCash] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SettleResult | null>(null);
  const [sendTo, setSendTo] = useState('');

  const t = useMemo(() => cartTotals(lines, discountPct), [lines, discountPct]);
  const cashNum = cash === '' ? null : Number(cash);
  const change = method === 'Cash' && cashNum != null ? Math.round((cashNum - t.total) * 100) / 100 : null;
  const cashShort = method === 'Cash' && cashNum != null && cashNum < t.total;

  // PromptPay QR (rendered server-side to a scannable image). Only fetched when that tender is selected.
  const qr = useQuery<{ promptpay_id: string; amount: number; qr_payload: string; qr_image: string | null }>({
    queryKey: ['promptpay-qr', t.total],
    queryFn: () => api(`/api/payments/promptpay-qr?amount=${t.total}`),
    enabled: method === 'PromptPay' && !result,
    retry: false,
  });

  const append = (d: string) => setCash((c) => (c === '0' ? d : c + d).slice(0, 9));
  const settle = async () => {
    setBusy(true);
    try {
      const r = await onSettle({ method, discountPct, cashReceived: cashNum ?? undefined });
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
            <CheckCircle2 className="size-14 text-success" />
            <h2 className="text-xl font-semibold">ขายสำเร็จ</h2>
            <p className="text-sm text-muted-foreground">เลขที่ขาย <strong className="text-foreground">{result.sale_no}</strong></p>
            <div className="tabular text-3xl font-bold">{baht(result.total)}</div>
            {result.change != null && result.change > 0 && (
              <div className="rounded-lg bg-success/10 px-4 py-2 text-success">
                เงินทอน <strong className="tabular text-lg">{baht(result.change)}</strong>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => onReprint(result.sale_no).catch((e) => notifyError((e as Error).message))}>
              <Printer className="size-4" /> พิมพ์ใบเสร็จ
            </Button>
            <Button onClick={onFinish}>ขายต่อไป</Button>
          </div>

          <div className="mt-1 flex items-center gap-2 border-t pt-3">
            <Input placeholder="อีเมล / LINE ID ลูกค้า" value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
            <Button
              variant="outline"
              size="sm"
              disabled={!sendTo}
              onClick={() => onSendReceipt(result.sale_no, sendTo.includes('@') ? 'email' : 'line', sendTo)
                .then(() => notifySuccess('ส่งใบเสร็จแล้ว'))
                .catch((e) => notifyError((e as Error).message))}
            >
              <Send className="size-4" /> ส่ง
            </Button>
          </div>
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
            <span>ชำระเงิน</span>
            <span className="tabular text-2xl font-bold">{baht(t.total)}</span>
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
                  <m.icon className="size-5" /> {m.label}
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
              <span className="text-muted-foreground">ส่วนลดบิล %</span>
              <Input
                type="number" min={0} max={100} step={1} inputMode="numeric"
                className="h-8 w-20 tabular text-right"
                value={discountPct || ''}
                onChange={(e) => setDiscountPct(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
              />
            </div>
            {t.discount > 0 && (
              <div className="flex items-center justify-between px-1 text-sm text-muted-foreground">
                <span>ส่วนลด</span><span className="tabular text-destructive">−{baht(t.discount)}</span>
              </div>
            )}
          </div>

          {/* contextual tender pad */}
          <div className="rounded-xl border p-3">
            {method === 'Cash' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">รับเงิน</span>
                  <span className="tabular text-xl font-semibold">{cash === '' ? '—' : baht(cashNum!)}</span>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  <Button type="button" variant="secondary" size="sm" onClick={() => setCash(String(t.total))}>พอดี</Button>
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
                  <Button type="button" variant="outline" className="h-11" onClick={() => setCash((c) => c.slice(0, -1))} aria-label="ลบ"><Delete className="size-4" /></Button>
                </div>
                <div className={cn('flex items-center justify-between rounded-lg px-3 py-2 text-sm', cashShort ? 'bg-destructive/10 text-destructive' : 'bg-muted')}>
                  <span>{cashShort ? 'เงินไม่พอ' : 'เงินทอน'}</span>
                  <span className="tabular font-semibold">{change != null ? baht(change) : '—'}</span>
                </div>
              </div>
            )}

            {method === 'PromptPay' && (
              <div className="flex flex-col items-center gap-2 text-center">
                {qr.isLoading && <p className="text-sm text-muted-foreground">กำลังสร้าง QR…</p>}
                {qr.data?.qr_image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qr.data.qr_image} alt="PromptPay QR" className="size-44 rounded-lg border bg-white p-1" />
                )}
                {qr.error && <p className="text-sm text-destructive">{(qr.error as Error).message}</p>}
                <div className="text-sm text-muted-foreground">ให้ลูกค้าสแกนเพื่อจ่าย <strong className="tabular text-foreground">{baht(t.total)}</strong></div>
                <p className="text-xs text-muted-foreground">กด “ยืนยันชำระเงิน” เมื่อได้รับเงินแล้ว</p>
              </div>
            )}

            {(method === 'Card' || method === 'Transfer') && (
              <div className="grid h-full place-items-center text-center text-sm text-muted-foreground">
                <div>
                  {method === 'Card' ? <CreditCard className="mx-auto mb-2 size-8 opacity-40" /> : <ArrowLeftRight className="mx-auto mb-2 size-8 opacity-40" />}
                  รับชำระ {baht(t.total)} ทาง{method === 'Card' ? 'บัตร' : 'โอนเงิน'}<br />
                  กด “ยืนยันชำระเงิน” เมื่อรับเงินแล้ว
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <Button variant="outline" onClick={onClose}><ArrowLeft className="size-4" /> กลับไปแก้ตะกร้า</Button>
          <Button className="h-11 px-6 text-base" disabled={busy || cashShort} onClick={settle}>
            {busy ? 'กำลังบันทึก…' : `ยืนยันชำระเงิน · ${baht(t.total)}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
