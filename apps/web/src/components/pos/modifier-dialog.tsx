'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { cn } from '@/lib/utils';
import { notifyError } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { newLineKey } from './cart';
import type { CartLine } from './types';

interface ModOption { option_id: number; name: string; price_delta: number; is_default?: boolean }
interface ModGroup { group_id: number; code: string; name: string; min_select: number; max_select: number; required: boolean; options: ModOption[] }
interface ItemDetail { id: number; sku: string; name: string; price: number; station_code?: string; modifier_groups: ModGroup[] }
interface Resolved { item_id: number; sku: string; name: string; qty: number; unit_price: number; amount: number; station_code: string; modifiers: { option_id: number; option_name: string; price_delta: number }[] }

/** Modifier picker: pick options per group (radio when max=1, else multi), preview the live price, then
 *  resolve the priced line server-side (enforces 86 / hours / min-max) and hand it back to the cart. */
export function ModifierDialog({ sku, onClose, onConfirm }: { sku: string; onClose: () => void; onConfirm: (line: CartLine) => void }) {
  const q = useQuery<ItemDetail>({ queryKey: ['menu-item', sku], queryFn: () => api(`/api/menu/items/${encodeURIComponent(sku)}`) });
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const toggle = (g: ModGroup, optId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const inGroup = g.options.map((o) => o.option_id);
      if (g.max_select <= 1) {
        // radio: clear other options in this group, then set (allow unselect if not required)
        for (const id of inGroup) next.delete(id);
        if (!prev.has(optId) || g.required) next.add(optId);
      } else if (next.has(optId)) {
        next.delete(optId);
      } else {
        const count = inGroup.filter((id) => next.has(id)).length;
        if (count >= g.max_select) { notifyError(`เลือก "${g.name}" ได้ไม่เกิน ${g.max_select}`); return prev; }
        next.add(optId);
      }
      return next;
    });
  };

  const item = q.data;
  const optPrice = (id: number) => {
    for (const g of item?.modifier_groups ?? []) { const o = g.options.find((x) => x.option_id === id); if (o) return o.price_delta; }
    return 0;
  };
  const livePrice = (item?.price ?? 0) + [...selected].reduce((a, id) => a + optPrice(id), 0);

  const resolve = useMutation({
    mutationFn: () => api<Resolved>('/api/menu/resolve', {
      method: 'POST',
      body: JSON.stringify({ sku, qty: 1, modifier_option_ids: [...selected] }),
    }),
    onSuccess: (r) => {
      onConfirm({
        key: newLineKey(),
        item_id: r.item_id,
        sku: r.sku,
        name: r.name,
        unit_price: r.unit_price,
        qty: 1,
        discount_pct: 0,
        station_code: r.station_code,
        modifier_option_ids: [...selected],
        modifiers: r.modifiers.map((m) => ({ option_id: m.option_id, label: m.option_name, price_delta: m.price_delta })),
      });
      onClose();
    },
    onError: (e: Error) => notifyError(e.message),
  });

  const missingRequired = (item?.modifier_groups ?? []).some((g) => {
    const min = g.required ? Math.max(1, g.min_select) : g.min_select;
    return g.options.filter((o) => selected.has(o.option_id)).length < min;
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{item?.name ?? 'เลือกตัวเลือก'}</DialogTitle>
        </DialogHeader>

        <div className="max-h-[55vh] space-y-4 overflow-y-auto pr-1">
          {q.isLoading && <p className="text-sm text-muted-foreground">กำลังโหลด…</p>}
          {item?.modifier_groups.map((g) => (
            <div key={g.group_id}>
              <div className="mb-1.5 flex items-center justify-between text-sm font-semibold">
                <span>{g.name}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {g.required ? 'ต้องเลือก' : 'เลือกได้'} {g.max_select > 1 ? `สูงสุด ${g.max_select}` : ''}
                </span>
              </div>
              <div className="grid gap-1.5">
                {g.options.map((o) => {
                  const on = selected.has(o.option_id);
                  return (
                    <button
                      key={o.option_id}
                      type="button"
                      onClick={() => toggle(g, o.option_id)}
                      className={cn(
                        'flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors',
                        on ? 'border-primary bg-primary/10' : 'hover:bg-accent',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className={cn('grid size-4 place-items-center rounded-full border', on && 'border-primary bg-primary')}>
                          {on && <span className="size-1.5 rounded-full bg-primary-foreground" />}
                        </span>
                        {o.name}
                      </span>
                      {o.price_delta !== 0 && <span className="tabular text-muted-foreground">+{baht(o.price_delta)}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={onClose}>ยกเลิก</Button>
          <Button disabled={!item || missingRequired || resolve.isPending} onClick={() => resolve.mutate()}>
            เพิ่มลงตะกร้า · {baht(livePrice)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
