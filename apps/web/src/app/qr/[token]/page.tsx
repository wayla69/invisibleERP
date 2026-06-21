'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { publicApi } from '@/lib/api';

type Status = {
  table_no: string | null; session_status: string;
  order: { order_no: string; status: string; waited_min: number; ready_in_min: number; items: { item_id: number; name: string; qty: number; kds_status: string; status_th: string }[] } | null;
  bill: { subtotal: number; vat: number; total: number; settled: boolean } | null;
};
const ITEM_COLOR: Record<string, string> = { 'รับออเดอร์': '#9ca3af', 'รอคิว': '#60a5fa', 'กำลังปรุง': '#f59e0b', 'พร้อมเสิร์ฟ': '#10b981', 'เสิร์ฟแล้ว': '#059669' };
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

  const wrap: React.CSSProperties = { maxWidth: 420, margin: '0 auto', padding: 16, fontFamily: 'Sarabun, sans-serif' };
  const card: React.CSSProperties = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 12 };

  if (paid) return (<main style={wrap}><div style={{ ...card, textAlign: 'center' }}><div style={{ fontSize: 48 }}>✅</div><h2>ชำระเงินสำเร็จ</h2><p style={{ color: '#6b7280' }}>ขอบคุณที่ใช้บริการ 🙏</p></div></main>);

  return (
    <main style={wrap}>
      <h2 style={{ color: '#1E3C72', marginBottom: 4 }}>🍽️ โต๊ะ {st?.table_no ?? '...'}</h2>
      {err && <p style={{ color: '#dc2626' }}>{err}</p>}

      {st?.order ? (
        <>
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <strong>สถานะออเดอร์</strong>
              <span style={{ color: '#6b7280' }}>{st.order.waited_min > 0 ? `รอมาแล้ว ${st.order.waited_min} นาที` : 'เพิ่งสั่ง'}</span>
            </div>
            {st.order.ready_in_min > 0 && <div style={{ color: '#d97706', marginBottom: 8 }}>⏱️ อาหารพร้อมในอีกประมาณ {st.order.ready_in_min} นาที</div>}
            {st.order.items.map((it) => (
              <div key={it.item_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
                <span>{it.qty}× {it.name}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: ITEM_COLOR[it.status_th] ?? '#6b7280' }}>{it.status_th}</span>
              </div>
            ))}
          </div>

          {st.bill && (
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6b7280' }}><span>มูลค่าสินค้า</span><span>{baht(st.bill.subtotal)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6b7280' }}><span>VAT 7%</span><span>{baht(st.bill.vat)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 18, color: '#1E3C72', marginTop: 6 }}><span>รวมทั้งสิ้น</span><span>{baht(st.bill.total)}</span></div>
            </div>
          )}

          {!pay && (
            <>
              {st.session_status === 'open' && <button onClick={doBill} disabled={busy} style={btn('#fff', '#1E3C72')}>🧾 เรียกเก็บเงิน</button>}
              {st.session_status === 'bill_requested' && <button onClick={doPay} disabled={busy} style={btn('#1E3C72', '#fff')}>📱 ชำระด้วย PromptPay</button>}
            </>
          )}
          {pay && (
            <div style={{ ...card, textAlign: 'center' }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>สแกนเพื่อชำระ {baht(pay.total)}</div>
              <div style={{ width: 180, height: 180, margin: '0 auto', border: '2px dashed #1E3C72', borderRadius: 12, display: 'grid', placeItems: 'center', color: '#6b7280', fontSize: 13, padding: 8 }}>
                PromptPay QR<br />({pay.gateway_ref})
              </div>
              <p style={{ color: '#6b7280', fontSize: 13, marginTop: 8 }}>กำลังรอยืนยันการชำระเงิน…</p>
              <button onClick={doConfirm} disabled={busy} style={btn('#10b981', '#fff')}>ยืนยันการชำระเงิน (จำลอง)</button>
            </div>
          )}
        </>
      ) : !err ? <p style={{ color: '#6b7280' }}>ยังไม่มีรายการอาหาร</p> : null}
    </main>
  );
}

function btn(bg: string, fg: string): React.CSSProperties {
  return { width: '100%', padding: 14, borderRadius: 10, border: bg === '#fff' ? '1px solid #1E3C72' : '0', background: bg, color: fg, fontSize: 16, fontWeight: 600, cursor: 'pointer', marginTop: 8 };
}
