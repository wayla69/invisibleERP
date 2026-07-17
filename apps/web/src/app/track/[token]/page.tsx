'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle2, ChefHat, Clock, PackageCheck, Bike, ReceiptText, QrCode } from 'lucide-react';
import { publicApi } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { LanguageToggle } from '@/components/language-toggle';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { baht } from '@/lib/format';

// Public order tracker for TAKEAWAY / DELIVERY (channel) orders — no login. Polls the public
// GET /api/order/t/:token endpoint and shows the fulfillment timeline + bill, with optional PromptPay pay.
interface Item { item_id: number; name: string; qty: number; kds_status: string; status_th: string; amount: number }
interface Status {
  order_no: string; channel: string; fulfillment_type: string; fulfillment_status: string;
  status: string; waited_min: number; ready_in_min: number; items: Item[];
  bill: { subtotal: number; vat: number; delivery_fee: number; total: number };
}
interface Pay { payment_no: string; qr_image: string | null; total: number; mock_settle: boolean }



// the fulfillment lifecycle, in order (label = catalog key); delivery adds the "out for delivery" stage.
const STAGES = (deliver: boolean) => [
  { key: 'received', label: 'pub.trk.stg_received', icon: ReceiptText },
  { key: 'accepted', label: 'pub.trk.stg_accepted', icon: CheckCircle2 },
  { key: 'preparing', label: 'pub.trk.stg_preparing', icon: ChefHat },
  { key: 'ready', label: deliver ? 'pub.trk.stg_ready_deliver' : 'pub.trk.stg_ready_pickup', icon: PackageCheck },
  ...(deliver ? [{ key: 'out_for_delivery', label: 'pub.trk.stg_out', icon: Bike }] : []),
  { key: 'completed', label: deliver ? 'pub.trk.stg_done_deliver' : 'pub.trk.stg_done_pickup', icon: CheckCircle2 },
];

export default function TrackPage() {
  const { t } = useLang();
  const token = String(useParams().token ?? '');
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState('');
  const [pay, setPay] = useState<Pay | null>(null);
  const [paid, setPaid] = useState(false);
  const [busy, setBusy] = useState(false);

  const poll = useCallback(async () => {
    try { setS(await publicApi<Status>(`/api/order/t/${token}`)); setErr(''); }
    catch (e) { setErr(String((e as Error).message)); }
  }, [token]);

  useEffect(() => { void poll(); const id = setInterval(poll, 15_000); return () => clearInterval(id); }, [poll]);

  const deliver = s?.fulfillment_type === 'delivery';
  const stages = STAGES(deliver);
  const rejected = s?.fulfillment_status === 'rejected';
  const activeIdx = s ? Math.max(0, stages.findIndex((st) => st.key === s.fulfillment_status)) : 0;

  const doPay = async () => { setBusy(true); try { setPay(await publicApi(`/api/order/t/${token}/pay`, { method: 'POST' })); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); } };
  const doConfirm = async () => { if (!pay) return; setBusy(true); try { await publicApi(`/api/order/t/${token}/confirm`, { method: 'POST', body: JSON.stringify({ payment_no: pay.payment_no }) }); setPaid(true); void poll(); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); } };

  return (
    <div className="mx-auto min-h-dvh max-w-md p-4">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-lg font-semibold">{t('pub.trk.title')}</h1>
        <LanguageToggle />
      </div>
      {s && <p className="mb-4 text-sm text-muted-foreground">{s.order_no} · {deliver ? t('pub.trk.delivery') : s.fulfillment_type === 'pickup' ? t('pub.trk.pickup') : t('pub.trk.takeaway')}</p>}

      {err && !s && <Card className="p-4 text-center text-sm text-destructive">{t('pub.trk.not_found')}</Card>}

      {s && (
        <>
          {/* timeline */}
          <Card className="mb-4 p-4">
            {rejected ? (
              <div className="text-center text-destructive">{t('pub.trk.rejected')}</div>
            ) : (
              <ol className="space-y-3">
                {stages.map((st, i) => {
                  const done = i < activeIdx, active = i === activeIdx;
                  const Icon = st.icon;
                  return (
                    <li key={st.key} className="flex items-center gap-3">
                      <span className={cn('grid size-8 place-items-center rounded-full border', done ? 'border-success bg-success/10 text-success' : active ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground')}>
                        <Icon className="size-4" />
                      </span>
                      <span className={cn('text-sm', active ? 'font-semibold' : done ? 'text-muted-foreground line-through' : 'text-muted-foreground')}>{t(st.label)}</span>
                      {active && s.ready_in_min > 0 && st.key === 'preparing' && <Badge variant="info" className="ml-auto gap-1"><Clock className="size-3" /> {t('pub.trk.eta', { n: s.ready_in_min })}</Badge>}
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>

          {/* items + bill */}
          <Card className="mb-4 p-4">
            <ul className="mb-3 space-y-1.5">
              {s.items.map((it) => (
                <li key={it.item_id} className="flex justify-between text-sm">
                  <span>{it.qty}× {it.name} <Badge variant="muted" className="ml-1 text-[10px]">{t(`pub.qr.st_${it.kds_status}`) === `pub.qr.st_${it.kds_status}` ? it.status_th : t(`pub.qr.st_${it.kds_status}`)}</Badge></span>
                  <span className="tabular">{baht(it.amount)}</span>
                </li>
              ))}
            </ul>
            <div className="space-y-1 border-t pt-2 text-sm">
              <div className="flex justify-between text-muted-foreground"><span>{t('pub.trk.food_total')}</span><span className="tabular">{baht(s.bill.subtotal)}</span></div>
              <div className="flex justify-between text-muted-foreground"><span>VAT</span><span className="tabular">{baht(s.bill.vat)}</span></div>
              {s.bill.delivery_fee > 0 && <div className="flex justify-between text-muted-foreground"><span>{t('pub.trk.delivery_fee')}</span><span className="tabular">{baht(s.bill.delivery_fee)}</span></div>}
              <div className="flex justify-between font-semibold"><span>{t('pub.trk.total')}</span><span className="tabular">{baht(s.bill.total)}</span></div>
            </div>
          </Card>

          {/* pay online (PromptPay) */}
          {paid ? (
            <Card className="p-4 text-center text-success"><CheckCircle2 className="mx-auto mb-1 size-8" /> {t('pub.trk.paid')}</Card>
          ) : !pay ? (
            <Button className="w-full" disabled={busy} onClick={doPay}><QrCode className="size-4" /> {t('pub.trk.pay_online')}</Button>
          ) : (
            <Card className="p-4 text-center">
              {pay.qr_image && /* eslint-disable-next-line @next/next/no-img-element */ <img src={pay.qr_image} alt="PromptPay QR" className="mx-auto size-48 rounded-lg border bg-white p-1" />}
              <p className="my-2 text-sm text-muted-foreground">{t('pub.trk.scan_to_pay')} <strong className="tabular text-foreground">{baht(pay.total)}</strong></p>
              <Button className="w-full" variant="outline" disabled={busy} onClick={doConfirm}>{t('pub.trk.i_paid')}</Button>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
