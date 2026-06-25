'use client';

import { Flame, Minus, Pause, Plus, ShoppingCart, Trash2, Utensils, User, Wallet } from 'lucide-react';
import { baht } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { CartLine } from './types';
import { lineAmount } from './types';
import { cartTotals } from './cart';

export function CartPanel({
  lines, mode, tableNo, customerName,
  onQty, onRemove, onClear, onHold, onCheckout, onFire, firePending,
}: {
  lines: CartLine[];
  mode: 'quick' | 'dinein';
  tableNo?: string | null;
  customerName?: string | null;
  onQty: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  onClear: () => void;
  onHold: () => void;
  onCheckout: () => void;
  onFire?: () => void;
  firePending?: boolean;
}) {
  const t = cartTotals(lines);
  const count = lines.reduce((a, l) => a + l.qty, 0);
  const empty = lines.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border bg-card">
      {/* header */}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ShoppingCart className="size-4" /> ตะกร้า
          {count > 0 && <Badge variant="secondary" className="tabular">{count}</Badge>}
        </div>
        <div className="flex items-center gap-1.5">
          {mode === 'dinein' && tableNo && (
            <Badge variant="info" className="gap-1"><Utensils className="size-3" /> โต๊ะ {tableNo}</Badge>
          )}
          {mode === 'quick' && <Badge variant="muted">ขายเร็ว</Badge>}
        </div>
      </div>

      {customerName && (
        <div className="flex items-center gap-1.5 border-b px-3 py-1.5 text-xs text-muted-foreground">
          <User className="size-3.5" /> {customerName}
        </div>
      )}

      {/* lines */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
            <div>
              <ShoppingCart className="mx-auto mb-2 size-8 opacity-30" />
              ยังไม่มีรายการ<br />แตะเมนูทางซ้ายเพื่อเพิ่ม
            </div>
          </div>
        ) : (
          <ul className="divide-y">
            {lines.map((l) => (
              <li key={l.key} className="flex items-start gap-2 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{l.name}</div>
                  {l.modifiers && l.modifiers.length > 0 && (
                    <div className="truncate text-xs text-muted-foreground">
                      {l.modifiers.map((m) => m.label).join(' · ')}
                    </div>
                  )}
                  <div className="mt-1 flex items-center gap-2">
                    <div className="flex items-center rounded-md border">
                      <button type="button" aria-label="ลดจำนวน" className="grid size-7 place-items-center text-muted-foreground hover:text-foreground" onClick={() => onQty(l.key, -1)}>
                        <Minus className="size-3.5" />
                      </button>
                      <span className="tabular w-7 text-center text-sm font-medium">{l.qty}</span>
                      <button type="button" aria-label="เพิ่มจำนวน" className="grid size-7 place-items-center text-muted-foreground hover:text-foreground" onClick={() => onQty(l.key, 1)}>
                        <Plus className="size-3.5" />
                      </button>
                    </div>
                    <span className="text-xs text-muted-foreground">× {baht(l.unit_price)}</span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="tabular text-sm font-semibold">{baht(lineAmount(l))}</span>
                  <button type="button" aria-label="ลบรายการ" className="text-muted-foreground hover:text-destructive" onClick={() => onRemove(l.key)}>
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* totals + actions */}
      <div className="space-y-2.5 border-t p-3">
        <div className="space-y-1 text-sm">
          <Row label="ยอดรวม" value={baht(t.net)} muted />
          <Row label="ภาษีมูลค่าเพิ่ม 7%" value={baht(t.vat)} muted />
          <Row label="สุทธิ" value={baht(t.total)} big />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" size="sm" disabled={empty} onClick={onHold}>
            <Pause className="size-4" /> พักบิล
          </Button>
          <Button variant="outline" size="sm" disabled={empty} onClick={onClear} className="text-muted-foreground hover:text-destructive">
            <Trash2 className="size-4" /> ล้างตะกร้า
          </Button>
        </div>

        {mode === 'dinein' && onFire && (
          <Button variant="secondary" className="w-full" disabled={empty || firePending} onClick={onFire}>
            <Flame className="size-4" /> {firePending ? 'กำลังส่ง…' : 'ส่งเข้าครัว'}
          </Button>
        )}

        <Button className={cn('h-12 w-full text-base')} disabled={empty} onClick={onCheckout}>
          <Wallet className="size-5" /> ชำระเงิน · {baht(t.total)}
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value, big, muted }: { label: string; value: string; big?: boolean; muted?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between', big && 'pt-1 text-lg font-bold', muted && 'text-muted-foreground')}>
      <span>{label}</span>
      <span className="tabular">{value}</span>
    </div>
  );
}
