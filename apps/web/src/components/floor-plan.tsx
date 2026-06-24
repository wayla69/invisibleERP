'use client';

// Floor-plan editor (โต๊ะ / ผังร้าน). Two modes:
//  • view  — แตะโต๊ะเพื่อจัดการ (เปิดแผงจัดการในหน้า tables)
//  • edit  — ลาก-วางจัดตำแหน่งโต๊ะ (PATCH pos_x/pos_y) + ลบโต๊ะ (DELETE soft-delete)
// Shapes/rotation/zones come from the API (board returns shape/rotation/zone_id) and are honoured here.
import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Move, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export type TableRow = {
  id: number; table_no: string; status: string; seats: number;
  zone_id: number | null; shape: string; rotation: number;
  pos_x: number; pos_y: number; width: number; height: number;
  session: { session_no: string; party_size: number; elapsed_min: number } | null;
  order: { order_no: string; status: string; total: number; waited_min: number } | null;
};

export const STATUS_TH: Record<string, string> = { available: 'ว่าง', reserved: 'จอง', occupied: 'มีลูกค้า', bill_requested: 'เรียกเก็บเงิน', paying: 'กำลังชำระ', cleaning: 'ทำความสะอาด', out_of_service: 'งดใช้' };

// Status → token classes. text = label color, border = left/top accent, fill = floor-plan fill, bar = panel top accent.
export const STATUS_TONE: Record<string, { text: string; border: string; fill: string; bar: string }> = {
  available: { text: 'text-success', border: 'border-l-success', fill: 'bg-success text-success-foreground', bar: 'border-t-success' },
  reserved: { text: 'text-info', border: 'border-l-info', fill: 'bg-info text-info-foreground', bar: 'border-t-info' },
  occupied: { text: 'text-info', border: 'border-l-info', fill: 'bg-info text-info-foreground', bar: 'border-t-info' },
  bill_requested: { text: 'text-warning-foreground dark:text-warning', border: 'border-l-warning', fill: 'bg-warning text-warning-foreground', bar: 'border-t-warning' },
  paying: { text: 'text-warning-foreground dark:text-warning', border: 'border-l-warning', fill: 'bg-warning text-warning-foreground', bar: 'border-t-warning' },
  cleaning: { text: 'text-muted-foreground', border: 'border-l-muted-foreground', fill: 'bg-muted text-muted-foreground', bar: 'border-t-muted-foreground' },
  out_of_service: { text: 'text-muted-foreground', border: 'border-l-muted', fill: 'bg-muted text-muted-foreground', bar: 'border-t-muted' },
};
export const tone = (s: string) => STATUS_TONE[s] ?? STATUS_TONE.out_of_service;

const CANVAS_H = 460; // px — the floor canvas height
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

type Drag = { id: number; offX: number; offY: number; x: number; y: number; w: number; h: number; moved: boolean };

export function FloorPlan({ tables, onSelect, sel, onChange }: { tables: TableRow[]; onSelect: (id: number) => void; sel: number | null; onChange: () => void }) {
  const [no, setNo] = useState('');
  const [edit, setEdit] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const add = useMutation({
    mutationFn: () => api('/api/restaurant/tables', { method: 'POST', body: JSON.stringify({ table_no: no.trim(), pos_x: 20 + ((tables.length % 5) * 120), pos_y: 20 + Math.floor(tables.length / 5) * 110 }) }),
    onSuccess: () => { setNo(''); onChange(); },
    onError: (e: any) => toast.error(e.message),
  });
  const move = useMutation({
    mutationFn: (v: { id: number; pos_x: number; pos_y: number }) => api(`/api/restaurant/tables/${v.id}`, { method: 'PATCH', body: JSON.stringify({ pos_x: v.pos_x, pos_y: v.pos_y }) }),
    onSuccess: () => onChange(),
    onError: (e: any) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`/api/restaurant/tables/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('ลบโต๊ะแล้ว'); onChange(); },
    onError: (e: any) => toast.error(e.message),
  });

  const pointerDown = (e: React.PointerEvent, t: TableRow) => {
    if (!edit) return;                       // view mode → let onClick select
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDrag({ id: t.id, offX: e.clientX - rect.left - t.pos_x, offY: e.clientY - rect.top - t.pos_y, x: t.pos_x, y: t.pos_y, w: t.width, h: t.height, moved: false });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const pointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = clamp(e.clientX - rect.left - drag.offX, 0, rect.width - drag.w);
    const y = clamp(e.clientY - rect.top - drag.offY, 0, rect.height - drag.h);
    // only mark "moved" once the pointer has actually travelled — a 1px jitter is still a tap
    const moved = drag.moved || Math.abs(x - drag.x) > 2 || Math.abs(y - drag.y) > 2;
    setDrag({ ...drag, x, y, moved });
  };
  const pointerUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.moved) move.mutate({ id: d.id, pos_x: Math.round(d.x), pos_y: Math.round(d.y) });
    else onSelect(d.id);                      // a tap (no travel) in edit mode still opens the table
  };

  const confirmDelete = (t: TableRow) => {
    if (typeof window !== 'undefined' && !window.confirm(`ลบโต๊ะ ${t.table_no}?\nโต๊ะจะถูกซ่อนจากผัง — ประวัติการขายยังอยู่ครบ`)) return;
    del.mutate(t.id);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-[180px]"
          placeholder="เลขโต๊ะ เช่น A1"
          value={no}
          onChange={(e) => setNo(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && no.trim() && !add.isPending) add.mutate(); }}
        />
        <Button disabled={!no.trim() || add.isPending} onClick={() => add.mutate()}>
          <Plus className="size-4" /> เพิ่มโต๊ะ
        </Button>
        <Button variant={edit ? 'default' : 'outline'} className="ml-auto" onClick={() => { setEdit((v) => !v); setDrag(null); }}>
          {edit ? <><Check className="size-4" /> เสร็จสิ้น</> : <><Pencil className="size-4" /> แก้ไขผัง</>}
        </Button>
      </div>

      <div
        ref={canvasRef}
        className={cn('relative overflow-hidden rounded-lg border border-dashed bg-muted/40', edit && 'border-primary/60 bg-primary/5')}
        style={{ height: CANVAS_H }}
      >
        {tables.length === 0 && (
          <p className="absolute inset-0 grid place-items-center px-4 text-center text-sm text-muted-foreground">ยังไม่มีโต๊ะ — พิมพ์เลขโต๊ะแล้วกด “เพิ่มโต๊ะ”</p>
        )}
        {tables.map((t) => {
          const left = drag?.id === t.id ? drag.x : t.pos_x;
          const top = drag?.id === t.id ? drag.y : t.pos_y;
          const dragging = drag?.id === t.id && drag.moved;
          const round = t.shape === 'circle' || t.width === t.height;
          return (
            <div key={t.id} className="absolute" style={{ left, top, width: t.width, height: t.height }}>
              <button
                onPointerDown={(e) => pointerDown(e, t)}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onClick={() => { if (!edit) onSelect(t.id); }}
                title={STATUS_TH[t.status]}
                className={cn(
                  'flex size-full select-none flex-col items-center justify-center text-[13px] font-bold',
                  tone(t.status).fill,
                  sel === t.id && 'ring-[3px] ring-primary',
                  edit ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-pointer',
                )}
                style={{ borderRadius: round ? '50%' : 8, transform: t.rotation ? `rotate(${t.rotation}deg)` : undefined, touchAction: edit ? 'none' : undefined }}
              >
                {t.table_no}
                <span className="text-[10px] font-normal">{STATUS_TH[t.status]}</span>
              </button>
              {edit && (
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); confirmDelete(t); }}
                  title="ลบโต๊ะ"
                  className="absolute -right-2 -top-2 grid size-5 place-items-center rounded-full bg-destructive text-destructive-foreground shadow ring-1 ring-background hover:bg-destructive/90"
                >
                  <Trash2 className="size-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        {edit
          ? <span className="inline-flex items-center gap-1"><Move className="size-3" /> ลากเพื่อย้ายโต๊ะ · กดถังขยะเพื่อลบ · กด “เสร็จสิ้น” เมื่อจัดเสร็จ</span>
          : 'แตะโต๊ะเพื่อจัดการ · กด “แก้ไขผัง” เพื่อย้าย/ลบ · สีบอกสถานะ'}
      </p>
    </div>
  );
}
