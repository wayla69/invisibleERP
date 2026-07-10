'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { CloudOff, ListChecks, RefreshCw, Store, Utensils, Wifi, WifiOff, X } from 'lucide-react';
import { api } from '@/lib/api';
import { thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifyError, notifySuccess } from '@/lib/notify';
import { useTerminal } from '@/lib/terminal';
import { useOnline } from '@/lib/offline';
import { enqueueRegisterSale, fetchMenuOfflineFirst, useRegisterOutbox } from '@/lib/register-offline';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MenuGrid } from '@/components/pos/menu-grid';
import { CartPanel, type OrderType } from '@/components/pos/cart-panel';
import { CheckoutPanel, type SettleResult } from '@/components/pos/checkout-panel';
import { ModifierDialog } from '@/components/pos/modifier-dialog';
import { TerminalBar } from '@/components/pos/terminal-bar';
import { addLine, cartTotals, newLineKey } from '@/components/pos/cart';
import { lineAmount, type CartLine, type MenuItem, type MenuResp } from '@/components/pos/types';

type Mode = 'quick' | 'dinein';
type Method = 'Cash' | 'PromptPay' | 'Card' | 'Transfer';

interface HeldCart { lines: CartLine[]; mode: Mode; tableId: number | null; tableNo: string | null; customerName: string }

interface UserPrefs { favorites: string[]; navFold: Record<string, boolean>; pos_fav: number[]; saved: boolean }

export default function RegisterPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const tm = useTerminal();
  const online = useOnline();
  // Register offline outbox: queued quick sales replay to /api/restaurant/offline-sync on reconnect.
  const outbox = useRegisterOutbox();
  // Menu is offline-first: the fetch runs even while the browser reports offline (networkMode
  // 'always' — TanStack Query would otherwise pause it and spin forever) and falls back to the
  // last good localStorage snapshot, so a reload mid-outage still renders a sellable menu.
  const menu = useQuery<MenuResp>({ queryKey: ['menu'], networkMode: 'always', queryFn: () => fetchMenuOfflineFirst(() => api('/api/menu')) });
  const prefsQ = useQuery<UserPrefs>({ queryKey: ['user-prefs'], queryFn: () => api('/api/user-prefs') });
  const favIds = useMemo(() => new Set<number>(prefsQ.data?.pos_fav ?? []), [prefsQ.data]);
  const favMut = useMutation({
    mutationFn: (ids: number[]) => api('/api/user-prefs', { method: 'PUT', body: JSON.stringify({ pos_fav: ids }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['user-prefs'] }),
  });
  const toggleFav = useCallback((id: number) => {
    const next = favIds.has(id) ? [...favIds].filter((x) => x !== id) : [...favIds, id];
    favMut.mutate(next);
  }, [favIds, favMut]);

  // when sales flush on reconnect, refresh the order list so the synced bills appear
  useEffect(() => {
    if (online && outbox.count > 0) void outbox.flush().then(() => qc.invalidateQueries({ queryKey: ['orders'] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  const [lines, setLines] = useState<CartLine[]>([]);
  const [mode, setMode] = useState<Mode>('quick');
  const [tableId, setTableId] = useState<number | null>(null);
  const [tableNo, setTableNo] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');
  // order options (#3): fulfillment type, guest count, manual service charge %
  const [orderType, setOrderType] = useState<OrderType>('dine_in');
  const [pax, setPax] = useState(1);
  const [serviceChargePct, setServiceChargePct] = useState(0);

  const [modSku, setModSku] = useState<string | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [tablePicker, setTablePicker] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);

  const tot = useMemo(() => cartTotals(lines), [lines]);

  // ── cart ops ──
  const pick = useCallback((it: MenuItem) => {
    if (it.has_modifiers) { setModSku(it.sku); return; }
    setLines((ls) => addLine(ls, {
      key: newLineKey(), item_id: it.id, sku: it.sku, name: it.name,
      unit_price: it.price, qty: 1, discount_pct: 0, station_code: it.station_code,
    }));
  }, []);
  const setQty = (key: string, delta: number) => setLines((ls) => ls.flatMap((l) => {
    if (l.key !== key) return [l];
    const qty = l.qty + delta;
    return qty <= 0 ? [] : [{ ...l, qty }];
  }));
  const removeLine = (key: string) => setLines((ls) => ls.filter((l) => l.key !== key));
  const clearCart = () => { setLines([]); setCustomerName(''); setServiceChargePct(0); };
  const resetSale = () => { setLines([]); setCustomerName(''); setMode('quick'); setTableId(null); setTableNo(null); setOrderType('dine_in'); setPax(1); setServiceChargePct(0); };
  // switching to a to-go type drops any attached table (takeaway/delivery have no table/dine-in mode)
  const changeOrderType = (ot: OrderType) => {
    setOrderType(ot);
    if (ot !== 'dine_in') { setMode('quick'); setTableId(null); setTableNo(null); }
  };

  // ── customer-facing display: mirror the cart (debounced) ──
  useEffect(() => {
    const id = setTimeout(() => {
      if (lines.length === 0) { tm.pushDisplay({ message: t('px.reg_welcome') }); return; }
      tm.pushDisplay({
        message: tableNo ? t('px.reg_table_label', { tableNo }) : t('px.reg_disp_settling'),
        lines: lines.map((l) => ({ name: l.name, qty: l.qty, amount: lineAmount(l) })),
        subtotal: tot.net, total: tot.total,
      });
    }, 500);
    return () => clearTimeout(id);
  }, [lines, tot.net, tot.total, tableNo, tm, t]);

  // ── settle: create the order (re-priced + 86-checked server-side), fire kitchen for dine-in, checkout,
  //    then drive the hardware (customer display → print → drawer). Returns the authoritative sale. ──
  const settle = useCallback(async ({ method, discountPct, cashReceived }: { method: Method; discountPct: number; cashReceived?: number }): Promise<SettleResult> => {
    const items = lines.map((l) => ({ sku: l.sku, qty: l.qty, modifier_option_ids: l.modifier_option_ids, notes: l.notes }));

    // ── offline path: queue a QUICK (no-table) cash-ish sale and replay it on reconnect. Dine-in needs
    //    the kitchen/online path (fire + table state), so it is blocked offline with a clear message. ──
    const queueOffline = async (): Promise<SettleResult> => {
      if (mode === 'dinein') throw new Error(t('px.reg_err_offline_dinein'));
      const offlineTotal = cartTotals(lines, discountPct).total;
      const change = cashReceived != null ? Math.round((cashReceived - offlineTotal) * 100) / 100 : undefined;
      await enqueueRegisterSale({ lines: items, method, discount_pct: discountPct || undefined, captured_at: new Date().toISOString(), device_id: tm.terminalCode, total: offlineTotal });
      outbox.refresh();
      tm.pushDisplay({ message: t('px.reg_disp_offline_saved'), total: offlineTotal, amount_due: cashReceived ?? undefined, change });
      if (method === 'Cash') void tm.kickDrawer({ saleNo: 'OFFLINE', amount: offlineTotal, reason: 'sale' });
      return { sale_no: t('px.reg_offline_pending'), total: offlineTotal, change, offline: true };
    };
    if (!online) return queueOffline();

    let created: { order_no: string };
    try {
      created = await api<{ order_no: string }>('/api/restaurant/orders', {
        method: 'POST',
        body: JSON.stringify({ table_id: tableId ?? undefined, items, guest_count: pax, fulfillment_type: orderType }),
      });
    } catch (e) {
      // `navigator.onLine` can report online while the link is actually dead (router up, ISP down).
      // A NETWORK-level failure — the thrown Error carries no HTTP `status` — on this FIRST call is
      // safe to queue: nothing financial persisted server-side (worst case a timed-out create leaves
      // an orphan OPEN order — never a posted sale, and the replay itself dedups on client_uuid).
      // HTTP errors (validation, 86'd item, expired session) and any failure past this point (the
      // order now exists server-side) surface to the cashier exactly as before.
      if ((e as Error & { status?: number }).status === undefined) return queueOffline();
      throw e;
    }
    const orderNo = created.order_no;
    // fire to kitchen for table service AND for to-go cooked orders (takeaway/delivery)
    if (mode === 'dinein' || orderType !== 'dine_in') {
      await api(`/api/restaurant/orders/${orderNo}/fire`, { method: 'POST', body: '{}' }).catch(() => { /* kitchen fire best-effort */ });
    }
    // manual service charge: force-apply at the entered % regardless of party size (service_min_party=1).
    const sc = serviceChargePct > 0 ? { apply_pricing_rules: true, service_charge_pct: serviceChargePct, party_size: pax, service_min_party: 1, channel: orderType } : {};
    const sale = await api<{ sale_no: string; total: number; total_with_tip?: number }>(`/api/restaurant/orders/${orderNo}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ method, discount_pct: discountPct || undefined, ...sc }),
    });
    const total = Number(sale.total ?? sale.total_with_tip ?? tot.total);
    const change = cashReceived != null ? Math.round((cashReceived - total) * 100) / 100 : undefined;

    tm.pushDisplay({ message: t('px.reg_disp_thanks'), total, amount_due: cashReceived ?? undefined, change });
    // Auto-print only when a printer is paired — otherwise the cashier prints on demand from the success
    // screen (avoids a surprise print dialog when no printer is set up yet).
    if (tm.printerConnected) tm.printReceipt(sale.sale_no).catch((e) => notifyError(t('px.reg_err_print', { msg: (e as Error).message })));
    if (method === 'Cash') void tm.kickDrawer({ saleNo: sale.sale_no, amount: total, reason: 'sale' });

    qc.invalidateQueries({ queryKey: ['orders'] });
    qc.invalidateQueries({ queryKey: ['pos-summary'] });
    return { sale_no: sale.sale_no, total, change };
  }, [lines, tableId, mode, orderType, pax, serviceChargePct, tot.total, tm, qc, online, outbox, t]);

  const finishSale = () => { setCheckout(false); resetSale(); tm.pushDisplay({ message: t('px.reg_welcome') }); };

  // ── hold / recall ──
  const hold = async () => {
    if (!lines.length) return;
    try {
      const cart: HeldCart = { lines, mode, tableId, tableNo, customerName };
      const r = await api<{ hold_no: string }>('/api/pos/hold', {
        method: 'POST',
        body: JSON.stringify({ label: tableNo ? t('px.reg_table_label', { tableNo }) : undefined, customer_name: customerName || undefined, cart }),
      });
      notifySuccess(t('px.reg_held_ok', { hold_no: r.hold_no }));
      resetSale();
    } catch (e) { notifyError((e as Error).message); }
  };
  const recall = (cart: HeldCart) => {
    setLines(cart.lines ?? []);
    setMode(cart.mode ?? 'quick');
    setTableId(cart.tableId ?? null);
    setTableNo(cart.tableNo ?? null);
    setCustomerName(cart.customerName ?? '');
    setHeldOpen(false);
  };

  return (
    <div className="flex flex-col">
      <TerminalBar terminal={tm} />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Store className="size-5 text-primary" /> {t('px.reg_title')}
        </h1>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* offline status + pending-sync badge */}
          <Badge variant={online ? 'success' : 'warning'} className="gap-1">
            {online ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
            {online ? t('px.reg_online') : t('px.reg_offline_local')}
          </Badge>
          {outbox.count > 0 && (
            <Button variant="outline" size="sm" disabled={!online} onClick={() => outbox.flush().then(() => qc.invalidateQueries({ queryKey: ['orders'] })).catch((e) => notifyError((e as Error).message))}>
              {online ? <RefreshCw className="size-4" /> : <CloudOff className="size-4" />} {t('px.reg_pending_sync', { count: outbox.count })}
            </Button>
          )}
          {mode === 'dinein' && tableNo ? (
            <Badge variant="info" className="gap-1">
              <Utensils className="size-3" /> {t('px.reg_table_label', { tableNo })}
              <button aria-label={t('px.reg_aria_clear_table')} onClick={() => { setMode('quick'); setTableId(null); setTableNo(null); }} className="ml-1 hover:text-foreground"><X className="size-3" /></button>
            </Badge>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setTablePicker(true)}><Utensils className="size-4" /> {t('px.reg_attach_table')}</Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setHeldOpen(true)}><ListChecks className="size-4" /> {t('px.reg_held_bills')}</Button>
          <Button asChild variant="ghost" size="sm"><Link href="/tables">{t('px.reg_tables_link')}</Link></Button>
        </div>
      </div>

      <StateView q={menu}>
        {menu.data && (
          <div className="grid h-[calc(100dvh-13.5rem)] min-h-[440px] gap-4 lg:grid-cols-[1fr_minmax(320px,360px)]">
            <MenuGrid data={menu.data} onPick={pick} favIds={favIds} onToggleFav={toggleFav} className="h-full rounded-xl border bg-card p-3" />
            <CartPanel
              lines={lines}
              mode={mode}
              tableNo={tableNo}
              customerName={customerName || null}
              onQty={setQty}
              onRemove={removeLine}
              onClear={clearCart}
              onHold={hold}
              onCheckout={() => setCheckout(true)}
              orderType={orderType}
              onOrderType={changeOrderType}
              pax={pax}
              onPax={(delta) => setPax((p) => Math.max(1, p + delta))}
              serviceChargePct={serviceChargePct}
              onServiceCharge={setServiceChargePct}
            />
          </div>
        )}
      </StateView>

      {modSku && (
        <ModifierDialog
          sku={modSku}
          onClose={() => setModSku(null)}
          onConfirm={(line) => setLines((ls) => addLine(ls, line))}
        />
      )}

      {checkout && lines.length > 0 && (
        <CheckoutPanel
          lines={lines}
          serviceChargePct={serviceChargePct}
          onSettle={settle}
          onReprint={(saleNo) => tm.printReceipt(saleNo)}
          onSendReceipt={(saleNo, channel, to) => api(`/api/pos/sales/${encodeURIComponent(saleNo)}/receipt/send`, { method: 'POST', body: JSON.stringify({ channel, ...(to ? { to } : {}) }) }).then(() => undefined)}
          onClose={() => setCheckout(false)}
          onFinish={finishSale}
        />
      )}

      {tablePicker && (
        <TableDialog
          onClose={() => setTablePicker(false)}
          onPick={(id, no) => { setTableId(id); setTableNo(no); setMode('dinein'); setOrderType('dine_in'); setTablePicker(false); }}
        />
      )}

      {heldOpen && <HeldDialog onClose={() => setHeldOpen(false)} onRecall={recall} />}
    </div>
  );
}

// ── attach-table picker ──
interface TableRow { id: number; table_no: string; status: string; seats: number }
function TableDialog({ onClose, onPick }: { onClose: () => void; onPick: (id: number, no: string) => void }) {
  const { t } = useLang();
  const q = useQuery<{ tables: TableRow[] }>({ queryKey: ['tables-list'], queryFn: () => api('/api/restaurant/tables') });
  const tone = (s: string) => (['occupied', 'bill_requested', 'paying'].includes(s) ? 'warning' : s === 'available' ? 'success' : 'muted');
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t('px.reg_tabledlg_title')}</DialogTitle></DialogHeader>
        <StateView q={q}>
          {q.data && (
            q.data.tables.length === 0
              ? <p className="py-6 text-center text-sm text-muted-foreground">{t('px.reg_no_tables')}</p>
              : (
                <div className="grid max-h-[55vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
                  {q.data.tables.map((tb) => (
                    <button
                      key={tb.id}
                      type="button"
                      onClick={() => onPick(tb.id, tb.table_no)}
                      className="flex flex-col items-center gap-1 rounded-lg border p-3 text-center transition-colors hover:border-primary hover:bg-accent"
                    >
                      <span className="font-semibold">{tb.table_no}</span>
                      <Badge variant={tone(tb.status)} className="text-[10px]">{t('px.reg_seats', { seats: tb.seats })}</Badge>
                    </button>
                  ))}
                </div>
              )
          )}
        </StateView>
      </DialogContent>
    </Dialog>
  );
}

// ── held-bills list ──
interface HeldRow { hold_no: string; label: string | null; customer_name: string | null; created_at: string }
function HeldDialog({ onClose, onRecall }: { onClose: () => void; onRecall: (cart: HeldCart) => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ held: HeldRow[] }>({ queryKey: ['pos-held'], queryFn: () => api('/api/pos/held') });
  const doRecall = async (holdNo: string) => {
    try {
      const r = await api<{ cart: HeldCart }>(`/api/pos/held/${encodeURIComponent(holdNo)}/recall`, { method: 'POST', body: '{}' });
      onRecall(r.cart);
    } catch (e) { notifyError((e as Error).message); }
  };
  const discard = async (holdNo: string) => {
    try { await api(`/api/pos/held/${encodeURIComponent(holdNo)}/discard`, { method: 'POST', body: '{}' }); qc.invalidateQueries({ queryKey: ['pos-held'] }); }
    catch (e) { notifyError((e as Error).message); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('px.reg_held_bills')}</DialogTitle></DialogHeader>
        <StateView q={q}>
          {q.data && (
            q.data.held.length === 0
              ? <p className="py-6 text-center text-sm text-muted-foreground">{t('px.reg_no_held')}</p>
              : (
                <ul className="divide-y">
                  {q.data.held.map((h) => (
                    <li key={h.hold_no} className="flex items-center justify-between gap-2 py-2.5">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{h.label || h.customer_name || h.hold_no}</div>
                        <div className="text-xs text-muted-foreground">{h.hold_no} · {thaiDate(h.created_at)}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => doRecall(h.hold_no)}>{t('px.reg_recall')}</Button>
                        <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => discard(h.hold_no)}>{t('px.reg_discard')}</Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )
          )}
        </StateView>
      </DialogContent>
    </Dialog>
  );
}
