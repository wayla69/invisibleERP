'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle2, Clock, QrCode, ReceiptText, Smartphone, Utensils } from 'lucide-react';
import { publicApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

type Status = {
  table_no: string | null; session_status: string;
  order: { order_no: string; status: string; waited_min: number; ready_in_min: number; items: { item_id: number; name: string; qty: number; kds_status: string; status_th: string }[] } | null;
  bill: { subtotal: number; vat: number; total: number; settled: boolean } | null;
};

const ITEM_COLOR: Record<string, string> = {
  'รับออเดอร์': 'text-muted-foreground',
  'รอคิว': 'text-info',
  'กำลังปรุง': 'text-warning-foreground dark:text-warning',
  'พร้อมเสิร์ฟ': 'text-success',
  'เสิร์ฟแล้ว': 'text-success',
};
const baht = (v: number) => `฿${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function DinerPage() {
  const token = String(useParams().token ?? '');
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState('');
  const [pay, setPay] = useState<{ payment_no: string; gateway_ref: string; total: number } | null>(null);
  const [paid, setPaid] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setSt(await publicApi<Status>(`/api/qr/t/${token}`)); setErr(''); }
    catch (e) { setErr(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ'); }
  }, [token]);

  useEffect(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i); }, [load]);

  const doBill = async () => { setBusy(true); try { await publicApi(`/api/qr/t/${token}/bill`, { method: 'POST' }); await load(); } finally { setBusy(false); } };
  const doPay = async () => { setBusy(true); try { setPay(await publicApi(`/api/qr/t/${token}/pay`, { method: 'POST' })); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); } };
  const doConfirm = async () => { if (!pay) return; setBusy(true); try { await publicApi(`/api/qr/t/${token}/confirm`, { method: 'POST', body: JSON.stringify({ payment_no: pay.payment_no }) }); setPaid(true); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); } };

  if (paid)
    return (
      <main className="mx-auto grid min-h-svh max-w-md place-items-center bg-muted/30 p-4">
        <Card className="w-full items-center gap-2 p-8 text-center">
          <CheckCircle2 className="size-14 text-success" />
          <h2 className="text-xl font-semibold">ชำระเงินสำเร็จ</h2>
          <p className="text-sm text-muted-foreground">ขอบคุณที่ใช้บริการ 🙏</p>
        </Card>
      </main>
    );

  return (
    <main className="mx-auto min-h-svh max-w-md bg-muted/30 p-4">
      <div className="mb-4 flex items-center gap-2">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Utensils className="size-5" />
        </div>
        <h2 className="text-lg font-semibold">โต๊ะ {st?.table_no ?? '…'}</h2>
      </div>
      {err && <p className="mb-3 text-sm text-destructive">{err}</p>}

      {st?.order ? (
        <>
          <Card className="mb-3 gap-3 p-4">
            <div className="flex items-center justify-between">
              <strong className="text-sm">สถานะออเดอร์</strong>
              <span className="text-xs text-muted-foreground">
                {st.order.waited_min > 0 ? `รอมาแล้ว ${st.order.waited_min} นาที` : 'เพิ่งสั่ง'}
              </span>
            </div>
            {st.order.ready_in_min > 0 && (
              <div className="flex items-center gap-1.5 text-sm text-warning-foreground dark:text-warning">
                <Clock className="size-4" /> อาหารพร้อมในอีกประมาณ {st.order.ready_in_min} นาที
              </div>
            )}
            <div className="divide-y">
              {st.order.items.map((it) => (
                <div key={it.item_id} className="flex items-center justify-between py-1.5">
                  <span className="text-sm">{it.qty}× {it.name}</span>
                  <span className={cn('text-xs font-semibold', ITEM_COLOR[it.status_th] ?? 'text-muted-foreground')}>
                    {it.status_th}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          {st.bill && (
            <Card className="mb-3 gap-1.5 p-4 text-sm">
              <div className="flex justify-between text-muted-foreground"><span>มูลค่าสินค้า</span><span className="tabular">{baht(st.bill.subtotal)}</span></div>
              <div className="flex justify-between text-muted-foreground"><span>VAT 7%</span><span className="tabular">{baht(st.bill.vat)}</span></div>
              <div className="mt-1 flex justify-between border-t pt-2 text-lg font-bold text-primary"><span>รวมทั้งสิ้น</span><span className="tabular">{baht(st.bill.total)}</span></div>
            </Card>
          )}

          {!pay && (
            <>
              {st.session_status === 'open' && (
                <Button onClick={doBill} disabled={busy} variant="outline" className="h-12 w-full text-base">
                  <ReceiptText className="size-5" /> เรียกเก็บเงิน
                </Button>
              )}
              {st.session_status === 'bill_requested' && (
                <Button onClick={doPay} disabled={busy} className="h-12 w-full text-base">
                  <Smartphone className="size-5" /> ชำระด้วย PromptPay
                </Button>
              )}
            </>
          )}
          {pay && (
            <Card className="items-center gap-3 p-5 text-center">
              <div className="font-medium">สแกนเพื่อชำระ {baht(pay.total)}</div>
              <div className="grid size-44 place-items-center gap-1 rounded-xl border-2 border-dashed border-primary/60 p-2 text-xs text-muted-foreground">
                <QrCode className="size-10 text-primary/70" />
                PromptPay QR<br />({pay.gateway_ref})
              </div>
              <p className="text-xs text-muted-foreground">กำลังรอยืนยันการชำระเงิน…</p>
              <Button onClick={doConfirm} disabled={busy} className="h-12 w-full bg-success text-base text-success-foreground hover:bg-success/90">
                ยืนยันการชำระเงิน (จำลอง)
              </Button>
            </Card>
          )}
        </>
      ) : !err ? (
        <p className="text-sm text-muted-foreground">ยังไม่มีรายการอาหาร</p>
      ) : null}
    </main>
  );
}
