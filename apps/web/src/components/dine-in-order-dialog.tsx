'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Flame, MessageCircle, Minus, Plus, Trash2, Utensils, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Msg } from '@/components/tabs';
import { useLang } from '@/lib/i18n';

type MenuItem = { sku: string; name: string; price: number };
type MenuCategory = { name?: string; items: MenuItem[] };
type Menu = { categories: MenuCategory[] };

type Line = { key: string; item_id?: string; name: string; unit_price: number; qty: number; course: number; seat: number | null };

export function DineInOrderDialog({
  tableId,
  tableNo,
  orderNo: initialOrderNo,
  onChange,
  onClose,
}: {
  tableId: number;
  tableNo: string;
  orderNo: string | null;
  onChange: () => void;
  onClose: () => void;
}) {
  const { t } = useLang();
  const [orderNo, setOrderNo] = useState<string | null>(initialOrderNo);
  const [lines, setLines] = useState<Line[]>([]);
  const [free, setFree] = useState({ name: '', unit_price: '' });
  const [guests, setGuests] = useState('');
  const [course, setCourse] = useState(1);   // course assigned to newly-added lines (fire course-by-course)
  const [seat, setSeat] = useState('');       // seat assigned to newly-added lines (POS-9); blank = shared/table
  const [discount, setDiscount] = useState('');
  const [tip, setTip] = useState('');
  const [msg, setMsg] = useState('');
  const [paidSale, setPaidSale] = useState<string | null>(null); // settled sale — enables the LINE e-receipt action

  const menu = useQuery<Menu>({ queryKey: ['menu'], queryFn: () => api('/api/menu') });

  const total = useMemo(() => lines.reduce((a, l) => a + l.qty * l.unit_price, 0), [lines]);

  const seatNo = seat ? Math.max(1, Number(seat) || 1) : null;
  const addLine = (name: string, unit_price: number, item_id?: string) =>
    setLines((ls) => {
      const idx = ls.findIndex((l) => l.item_id === item_id && l.name === name && l.course === course && l.seat === seatNo && (item_id || true));
      if (item_id && idx >= 0) return ls.map((l, j) => (j === idx ? { ...l, qty: l.qty + 1 } : l));
      return [...ls, { key: `${Date.now()}-${ls.length}`, item_id, name, unit_price, qty: 1, course, seat: seatNo }];
    });

  const setQty = (key: string, delta: number) =>
    setLines((ls) =>
      ls.map((l) => (l.key === key ? { ...l, qty: Math.max(1, l.qty + delta) } : l)),
    );
  const removeLine = (key: string) => setLines((ls) => ls.filter((l) => l.key !== key));

  const addFree = () => {
    if (!free.name) return;
    addLine(free.name, Number(free.unit_price) || 0);
    setFree({ name: '', unit_price: '' });
  };

  const payload = () =>
    lines.map((l) => ({ item_id: l.item_id, name: l.name, unit_price: l.unit_price, qty: l.qty, course: l.course, seat: l.seat ?? undefined }));

  const createOrAdd = useMutation({
    mutationFn: () => {
      if (orderNo) {
        return api(`/api/restaurant/orders/${orderNo}/items`, {
          method: 'POST',
          body: JSON.stringify({ items: payload() }),
        });
      }
      return api<{ order_no: string }>('/api/restaurant/orders', {
        method: 'POST',
        body: JSON.stringify({
          table_id: tableId,
          guest_count: guests ? Number(guests) : undefined,
          items: payload(),
        }),
      });
    },
    onSuccess: (r: any) => {
      if (r?.order_no) setOrderNo(r.order_no);
      setLines([]);
      setMsg(`✅ ${t('px.dine_saved', { order: r?.order_no ?? orderNo ?? '' })}`);
      onChange();
    },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  const fire = useMutation({
    mutationFn: () => api(`/api/restaurant/orders/${orderNo}/fire`, { method: 'POST', body: '{}' }),
    onSuccess: () => { setMsg(`✅ ${t('px.dine_fired')}`); onChange(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  const checkout = useMutation({
    mutationFn: () => api<{ order_no: string; sale_no: string; total: number; status: string }>(
      `/api/restaurant/orders/${orderNo}/checkout`,
      {
        method: 'POST',
        body: JSON.stringify({
          method: 'Cash',
          discount_pct: discount ? Number(discount) : undefined,
          tip: tip ? Number(tip) : undefined,
        }),
      },
    ),
    // Stay open after settling so the cashier can push the LINE e-receipt (POS-2); ปิด closes when done.
    onSuccess: (r) => { setMsg(`✅ ${t('px.dine_paid', { sale: r.sale_no, total: baht(r.total) })}`); setPaidSale(r.sale_no); onChange(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  // POS-2 — LINE e-receipt for the member on the sale (server resolves the member; LINE_NOT_LINKED when none).
  const sendLine = useMutation({
    mutationFn: () => api(`/api/pos/sales/${encodeURIComponent(paidSale!)}/receipt/send`, { method: 'POST', body: JSON.stringify({ channel: 'line' }) }),
    onSuccess: () => setMsg(`✅ ${t('px.chk_sent_ok')}`),
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Utensils className="size-4" /> {t('px.dine_title', { table: tableNo })}
            {orderNo && <Badge variant="info">{orderNo}</Badge>}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[1fr_300px] md:items-start">
          {/* Menu picker */}
          <div className="space-y-3">
            <div className="max-h-[320px] space-y-3 overflow-y-auto pr-1">
              {(menu.data?.categories ?? []).map((c, ci) => (
                <div key={ci}>
                  {c.name && <p className="mb-1 text-xs font-semibold text-muted-foreground">{c.name}</p>}
                  <div className="grid gap-2 sm:grid-cols-2">
                    {c.items.map((m) => (
                      <button
                        key={m.sku}
                        type="button"
                        onClick={() => addLine(m.name, Number(m.price), m.sku)}
                        className="flex items-center justify-between rounded-md border bg-card px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                      >
                        <span className="truncate">{m.name}</span>
                        <span className="tabular ml-2 shrink-0 text-muted-foreground">{baht(m.price)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {menu.isLoading && <p className="text-sm text-muted-foreground">{t('px.dine_loading_menu')}</p>}
            </div>

            {/* Free-text line */}
            <div className="flex flex-wrap items-end gap-2 border-t pt-3">
              <div className="min-w-[140px] flex-[2] grid gap-1">
                <Label htmlFor="free-name">{t('px.dine_other_item')}</Label>
                <Input id="free-name" placeholder={t('px.dine_ph_food_name')} value={free.name} onChange={(e) => setFree({ ...free, name: e.target.value })} />
              </div>
              <div className="w-24 grid gap-1">
                <Label htmlFor="free-price">{t('px.dine_price')}</Label>
                <Input id="free-price" type="number" min={0} step="0.01" className="tabular text-right" value={free.unit_price} onChange={(e) => setFree({ ...free, unit_price: e.target.value })} />
              </div>
              <Button type="button" variant="outline" disabled={!free.name} onClick={addFree}>
                <Plus className="size-4" /> {t('px.dine_add')}
              </Button>
            </div>

            {/* Course + seat for items added next: course fired course-by-course; seat (POS-9) attributes each
                line to a guest so the kitchen can fire per seat and the bill can split by who ordered what. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
              <div className="flex items-center gap-2">
                <Label htmlFor="course" className="text-xs text-muted-foreground">{t('px.dine_course_for_added')}</Label>
                <Input id="course" type="number" min={1} step={1} className="tabular w-16" value={course} onChange={(e) => setCourse(Math.max(1, Number(e.target.value) || 1))} />
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="seat" className="text-xs text-muted-foreground">{t('px.dine_seat_for_added')}</Label>
                <Input id="seat" type="number" min={1} step={1} className="tabular w-16" placeholder={t('px.dine_seat_shared')} value={seat} onChange={(e) => setSeat(e.target.value)} />
              </div>
            </div>
          </div>

          {/* Cart */}
          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            {!orderNo && (
              <div className="grid gap-1">
                <Label htmlFor="guests">{t('px.dine_guest_count')}</Label>
                <Input id="guests" type="number" min={1} step={1} className="tabular" value={guests} onChange={(e) => setGuests(e.target.value)} placeholder={t('px.dine_ph_eg2')} />
              </div>
            )}

            <div className="space-y-2">
              {lines.length === 0 && <p className="text-sm text-muted-foreground">{t('px.dine_no_items')}</p>}
              {lines.map((l) => (
                <div key={l.key} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 truncate">{l.name}{l.course > 1 && <span className="ml-1 text-xs text-muted-foreground">{t('px.dine_course_n', { n: l.course })}</span>}{l.seat != null && <span className="ml-1 text-xs text-muted-foreground">{t('px.dine_seat_n', { n: l.seat })}</span>}</span>
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={t('px.dine_decrease')} onClick={() => setQty(l.key, -1)}><Minus className="size-3" /></Button>
                    <span className="tabular w-6 text-center">{l.qty}</span>
                    <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={t('px.dine_add')} onClick={() => setQty(l.key, 1)}><Plus className="size-3" /></Button>
                  </div>
                  <span className="tabular w-16 text-right text-muted-foreground">{baht(l.qty * l.unit_price)}</span>
                  <Button type="button" variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" aria-label={t('px.dine_delete')} onClick={() => removeLine(l.key)}><Trash2 className="size-3" /></Button>
                </div>
              ))}
            </div>

            {lines.length > 0 && (
              <div className="flex items-center justify-between border-t pt-2 text-sm">
                <span className="text-muted-foreground">{t('px.dine_new_items_total')}</span>
                <span className="tabular font-semibold">{baht(total)}</span>
              </div>
            )}

            <Button
              type="button"
              className="w-full"
              disabled={createOrAdd.isPending || lines.length === 0}
              onClick={() => { setMsg(''); createOrAdd.mutate(); }}
            >
              {orderNo ? t('px.dine_add_to_order') : t('px.dine_create_order')}
            </Button>

            {orderNo && (
              <div className="space-y-2 border-t pt-3">
                <Button type="button" variant="outline" className="w-full" disabled={fire.isPending} onClick={() => { setMsg(''); fire.mutate(); }}>
                  <Flame className="size-4" /> {t('px.dine_send_kitchen')}
                </Button>

                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1">
                    <Label htmlFor="discount">{t('px.dine_discount_pct')}</Label>
                    <Input id="discount" type="number" min={0} max={100} step="0.01" className="tabular" value={discount} onChange={(e) => setDiscount(e.target.value)} />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="tip">{t('px.dine_tip')}</Label>
                    <Input id="tip" type="number" min={0} step="0.01" className="tabular" value={tip} onChange={(e) => setTip(e.target.value)} />
                  </div>
                </div>

                {paidSale ? (
                  <Button type="button" variant="outline" className={cn('w-full')} disabled={sendLine.isPending} onClick={() => sendLine.mutate()}>
                    <MessageCircle className="size-4" /> {t('px.chk_send_line')}
                  </Button>
                ) : (
                  <Button type="button" className={cn('w-full')} disabled={checkout.isPending} onClick={() => { setMsg(''); checkout.mutate(); }}>
                    <Wallet className="size-4" /> {t('px.dine_checkout_cash')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        {msg && <Msg ok={msg.startsWith('✅')}>{msg}</Msg>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t('px.dine_close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
