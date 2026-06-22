'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Flame, Minus, Plus, Trash2, Utensils, Wallet } from 'lucide-react';
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

type MenuItem = { sku: string; name: string; price: number };
type MenuCategory = { name?: string; items: MenuItem[] };
type Menu = { categories: MenuCategory[] };

type Line = { key: string; item_id?: string; name: string; unit_price: number; qty: number };

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
  const [orderNo, setOrderNo] = useState<string | null>(initialOrderNo);
  const [lines, setLines] = useState<Line[]>([]);
  const [free, setFree] = useState({ name: '', unit_price: '' });
  const [guests, setGuests] = useState('');
  const [discount, setDiscount] = useState('');
  const [tip, setTip] = useState('');
  const [msg, setMsg] = useState('');

  const menu = useQuery<Menu>({ queryKey: ['menu'], queryFn: () => api('/api/menu') });

  const total = useMemo(() => lines.reduce((a, l) => a + l.qty * l.unit_price, 0), [lines]);

  const addLine = (name: string, unit_price: number, item_id?: string) =>
    setLines((ls) => {
      const idx = ls.findIndex((l) => l.item_id === item_id && l.name === name && (item_id || true));
      if (item_id && idx >= 0) return ls.map((l, j) => (j === idx ? { ...l, qty: l.qty + 1 } : l));
      return [...ls, { key: `${Date.now()}-${ls.length}`, item_id, name, unit_price, qty: 1 }];
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
    lines.map((l) => ({ item_id: l.item_id, name: l.name, unit_price: l.unit_price, qty: l.qty }));

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
      setMsg(`✅ บันทึกรายการแล้ว ${r?.order_no ?? orderNo ?? ''}`);
      onChange();
    },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  const fire = useMutation({
    mutationFn: () => api(`/api/restaurant/orders/${orderNo}/fire`, { method: 'POST', body: '{}' }),
    onSuccess: () => { setMsg('✅ ส่งเข้าครัวแล้ว'); onChange(); },
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
    onSuccess: (r) => { setMsg(`✅ ชำระเงินสำเร็จ · ${r.sale_no} · ${baht(r.total)}`); onChange(); onClose(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Utensils className="size-4" /> สั่งอาหาร · โต๊ะ {tableNo}
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
              {menu.isLoading && <p className="text-sm text-muted-foreground">กำลังโหลดเมนู…</p>}
            </div>

            {/* Free-text line */}
            <div className="flex flex-wrap items-end gap-2 border-t pt-3">
              <div className="min-w-[140px] flex-[2] grid gap-1">
                <Label htmlFor="free-name">รายการอื่น ๆ</Label>
                <Input id="free-name" placeholder="ชื่ออาหาร" value={free.name} onChange={(e) => setFree({ ...free, name: e.target.value })} />
              </div>
              <div className="w-24 grid gap-1">
                <Label htmlFor="free-price">ราคา</Label>
                <Input id="free-price" type="number" className="tabular text-right" value={free.unit_price} onChange={(e) => setFree({ ...free, unit_price: e.target.value })} />
              </div>
              <Button type="button" variant="outline" disabled={!free.name} onClick={addFree}>
                <Plus className="size-4" /> เพิ่ม
              </Button>
            </div>
          </div>

          {/* Cart */}
          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            {!orderNo && (
              <div className="grid gap-1">
                <Label htmlFor="guests">จำนวนลูกค้า</Label>
                <Input id="guests" type="number" className="tabular" value={guests} onChange={(e) => setGuests(e.target.value)} placeholder="เช่น 2" />
              </div>
            )}

            <div className="space-y-2">
              {lines.length === 0 && <p className="text-sm text-muted-foreground">ยังไม่มีรายการ — เลือกจากเมนู</p>}
              {lines.map((l) => (
                <div key={l.key} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 truncate">{l.name}</span>
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="ghost" size="icon" className="size-6" aria-label="ลด" onClick={() => setQty(l.key, -1)}><Minus className="size-3" /></Button>
                    <span className="tabular w-6 text-center">{l.qty}</span>
                    <Button type="button" variant="ghost" size="icon" className="size-6" aria-label="เพิ่ม" onClick={() => setQty(l.key, 1)}><Plus className="size-3" /></Button>
                  </div>
                  <span className="tabular w-16 text-right text-muted-foreground">{baht(l.qty * l.unit_price)}</span>
                  <Button type="button" variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" aria-label="ลบ" onClick={() => removeLine(l.key)}><Trash2 className="size-3" /></Button>
                </div>
              ))}
            </div>

            {lines.length > 0 && (
              <div className="flex items-center justify-between border-t pt-2 text-sm">
                <span className="text-muted-foreground">รวมรายการใหม่</span>
                <span className="tabular font-semibold">{baht(total)}</span>
              </div>
            )}

            <Button
              type="button"
              className="w-full"
              disabled={createOrAdd.isPending || lines.length === 0}
              onClick={() => { setMsg(''); createOrAdd.mutate(); }}
            >
              {orderNo ? 'เพิ่มลงออเดอร์' : 'สร้างออเดอร์'}
            </Button>

            {orderNo && (
              <div className="space-y-2 border-t pt-3">
                <Button type="button" variant="outline" className="w-full" disabled={fire.isPending} onClick={() => { setMsg(''); fire.mutate(); }}>
                  <Flame className="size-4" /> ส่งเข้าครัว
                </Button>

                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1">
                    <Label htmlFor="discount">ส่วนลด %</Label>
                    <Input id="discount" type="number" className="tabular" value={discount} onChange={(e) => setDiscount(e.target.value)} />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="tip">ทิป</Label>
                    <Input id="tip" type="number" className="tabular" value={tip} onChange={(e) => setTip(e.target.value)} />
                  </div>
                </div>

                <Button type="button" className={cn('w-full')} disabled={checkout.isPending} onClick={() => { setMsg(''); checkout.mutate(); }}>
                  <Wallet className="size-4" /> ชำระเงิน (เงินสด)
                </Button>
              </div>
            )}
          </div>
        </div>

        {msg && <Msg ok={msg.startsWith('✅')}>{msg}</Msg>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>ปิด</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
