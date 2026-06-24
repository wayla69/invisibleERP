'use client';

// Floor-plan editor (โต๊ะ / ผังร้าน). Two modes:
//  • view  — แตะโต๊ะเพื่อจัดการ (เปิดแผงจัดการในหน้า tables); zones render as labelled rooms.
//  • edit  — drag/resize tables AND zones, delete them, assign a table to a room. Persists via the
//            REST API (PATCH /tables/:id pos/size/zone_id; PATCH/DELETE /zones/:id). A VIP room is
//            just a zone with an accent colour. Shapes/rotation come from the API and are honoured.
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Home, Move, Palette, Pencil, Plus, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type TableRow = {
  id: number; table_no: string; status: string; seats: number;
  zone_id: number | null; shape: string; rotation: number;
  pos_x: number; pos_y: number; width: number; height: number;
  session: { session_no: string; party_size: number; elapsed_min: number } | null;
  order: { order_no: string; status: string; total: number; waited_min: number } | null;
};
export type ZoneRow = { id: number; name: string; sort_order: number; color: string | null; pos_x: number; pos_y: number; width: number; height: number };

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

// Room accent palette (the cycle button steps through these + "none"). Gold reads as a VIP room.
const ACCENTS = [
  { hex: '#caa53d', label: 'ทอง (VIP)' },
  { hex: '#3b82f6', label: 'ฟ้า' },
  { hex: '#16a34a', label: 'เขียว' },
  { hex: '#db2777', label: 'ชมพู' },
  { hex: '#64748b', label: 'เทา' },
];
const hexA = (hex: string, a: number) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

const CANVAS_H = 520; // px — the floor canvas height
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

type Drag = {
  kind: 'table' | 'zone'; id: number; action: 'move' | 'resize';
  px0: number; py0: number; x0: number; y0: number; w0: number; h0: number;
  x: number; y: number; w: number; h: number; moved: boolean;
};

export function FloorPlan({ tables, onSelect, sel, onChange }: { tables: TableRow[]; onSelect: (id: number) => void; sel: number | null; onChange: () => void }) {
  const qc = useQueryClient();
  const zonesQ = useQuery<{ zones: ZoneRow[] }>({ queryKey: ['floor-zones'], queryFn: () => api('/api/restaurant/zones') });
  const zones = zonesQ.data?.zones ?? [];
  const refreshZones = () => qc.invalidateQueries({ queryKey: ['floor-zones'] });

  const [no, setNo] = useState('');
  const [zoneName, setZoneName] = useState('');
  const [zoneColor, setZoneColor] = useState('');     // '' = no accent
  const [edit, setEdit] = useState(false);
  const [editSel, setEditSel] = useState<number | null>(null);   // selected table id for the edit inspector
  const [drag, setDrag] = useState<Drag | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const onErr = (e: any) => toast.error(e.message);
  const addTable = useMutation({
    mutationFn: () => api('/api/restaurant/tables', { method: 'POST', body: JSON.stringify({ table_no: no.trim(), pos_x: 20 + ((tables.length % 5) * 120), pos_y: 20 + Math.floor(tables.length / 5) * 110 }) }),
    onSuccess: () => { setNo(''); onChange(); }, onError: onErr,
  });
  // generic PATCH for table/zone move+resize+zone-assign — invalidates the right cache by kind
  const patch = useMutation({
    mutationFn: (v: { path: string; body: any; kind: 'table' | 'zone' }) => api(v.path, { method: 'PATCH', body: JSON.stringify(v.body) }),
    onSuccess: (_r, v) => { if (v.kind === 'zone') refreshZones(); else onChange(); }, onError: onErr,
  });
  const delTable = useMutation({
    mutationFn: (id: number) => api(`/api/restaurant/tables/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('ลบโต๊ะแล้ว'); setEditSel(null); onChange(); }, onError: onErr,
  });
  const addZone = useMutation({
    mutationFn: () => api('/api/restaurant/zones', { method: 'POST', body: JSON.stringify({ name: zoneName.trim(), color: zoneColor || null, pos_x: 16 + ((zones.length % 2) * 340), pos_y: 16 + Math.floor(zones.length / 2) * 230, width: 320, height: 200 }) }),
    onSuccess: () => { setZoneName(''); refreshZones(); }, onError: onErr,
  });
  const delZone = useMutation({
    mutationFn: (id: number) => api(`/api/restaurant/zones/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('ลบห้องแล้ว'); refreshZones(); onChange(); }, onError: onErr,   // tables un-assigned → refresh both
  });

  // ── unified pointer drag (move | resize) for tables and zones ──
  const startDrag = (e: ReactPointerEvent, kind: Drag['kind'], id: number, action: Drag['action'], box: { x: number; y: number; w: number; h: number }) => {
    if (!edit) return;
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    setDrag({ kind, id, action, px0: px, py0: py, x0: box.x, y0: box.y, w0: box.w, h0: box.h, x: box.x, y: box.y, w: box.w, h: box.h, moved: false });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const dx = px - drag.px0, dy = py - drag.py0;
    let { x, y, w, h } = drag;
    if (drag.action === 'move') {
      x = clamp(drag.x0 + dx, 0, Math.max(0, rect.width - drag.w0));
      y = clamp(drag.y0 + dy, 0, Math.max(0, rect.height - drag.h0));
    } else {
      const minW = drag.kind === 'zone' ? 120 : 40, minH = drag.kind === 'zone' ? 80 : 40;
      w = clamp(drag.w0 + dx, minW, rect.width - drag.x0);
      h = clamp(drag.h0 + dy, minH, rect.height - drag.y0);
    }
    setDrag({ ...drag, x, y, w, h, moved: drag.moved || Math.abs(dx) > 2 || Math.abs(dy) > 2 });
  };
  const onDragUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.moved) { if (d.kind === 'table') setEditSel(d.id); return; }   // a tap (no travel) selects a table
    const path = d.kind === 'table' ? `/api/restaurant/tables/${d.id}` : `/api/restaurant/zones/${d.id}`;
    const body = d.action === 'move' ? { pos_x: Math.round(d.x), pos_y: Math.round(d.y) } : { width: Math.round(d.w), height: Math.round(d.h) };
    patch.mutate({ path, body, kind: d.kind });
  };

  const confirmDeleteTable = (t: TableRow) => {
    if (typeof window !== 'undefined' && !window.confirm(`ลบโต๊ะ ${t.table_no}?\nโต๊ะจะถูกซ่อนจากผัง — ประวัติการขายยังอยู่ครบ`)) return;
    delTable.mutate(t.id);
  };
  const renameZone = (z: ZoneRow) => {
    const v = typeof window !== 'undefined' ? window.prompt('ชื่อห้อง', z.name)?.trim() : '';
    if (v) patch.mutate({ path: `/api/restaurant/zones/${z.id}`, body: { name: v }, kind: 'zone' });
  };
  const cycleColor = (z: ZoneRow) => {
    const order = [null, ...ACCENTS.map((a) => a.hex)];
    const next = order[(order.indexOf(z.color) + 1) % order.length];
    patch.mutate({ path: `/api/restaurant/zones/${z.id}`, body: { color: next }, kind: 'zone' });
  };
  const confirmDeleteZone = (z: ZoneRow) => {
    if (typeof window !== 'undefined' && !window.confirm(`ลบห้อง “${z.name}”?\nโต๊ะในห้องจะไม่ถูกลบ แต่จะไม่อยู่ในห้องใด`)) return;
    delZone.mutate(z.id);
  };

  const inspTable = editSel != null ? tables.find((t) => t.id === editSel) ?? null : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-[180px]"
          placeholder="เลขโต๊ะ เช่น A1"
          value={no}
          onChange={(e) => setNo(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && no.trim() && !addTable.isPending) addTable.mutate(); }}
        />
        <Button disabled={!no.trim() || addTable.isPending} onClick={() => addTable.mutate()}>
          <Plus className="size-4" /> เพิ่มโต๊ะ
        </Button>
        <Button variant={edit ? 'default' : 'outline'} className="ml-auto" onClick={() => { setEdit((v) => !v); setDrag(null); setEditSel(null); }}>
          {edit ? <><Check className="size-4" /> เสร็จสิ้น</> : <><Pencil className="size-4" /> แก้ไขผัง</>}
        </Button>
      </div>

      {edit && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-2">
          <Home className="size-4 text-muted-foreground" />
          <Input
            className="max-w-[200px]"
            placeholder="ชื่อห้อง เช่น VIP, ระเบียง, ชั้น 2"
            value={zoneName}
            onChange={(e) => setZoneName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && zoneName.trim() && !addZone.isPending) addZone.mutate(); }}
          />
          <Select value={zoneColor || 'none'} onValueChange={(v) => setZoneColor(v === 'none' ? '' : v)}>
            <SelectTrigger className="w-[150px]"><SelectValue placeholder="สีห้อง" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">ไม่มีสี</SelectItem>
              {ACCENTS.map((a) => <SelectItem key={a.hex} value={a.hex}>{a.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" disabled={!zoneName.trim() || addZone.isPending} onClick={() => addZone.mutate()}>
            <Plus className="size-4" /> เพิ่มห้อง
          </Button>
        </div>
      )}

      <div
        ref={canvasRef}
        onPointerDown={(e) => { if (edit && e.target === canvasRef.current) setEditSel(null); }}
        className={cn('relative overflow-hidden rounded-lg border border-dashed bg-muted/40', edit && 'border-primary/60 bg-primary/5')}
        style={{ height: CANVAS_H }}
      >
        {/* zones / rooms — drawn behind tables; only headers + handles are interactive */}
        {zones.map((z) => {
          const d = drag?.kind === 'zone' && drag.id === z.id ? drag : null;
          const x = d ? d.x : z.pos_x, y = d ? d.y : z.pos_y, w = d ? d.w : z.width, h = d ? d.h : z.height;
          return (
            <div
              key={`z${z.id}`}
              className="absolute rounded-lg border-2 border-muted-foreground/25"
              style={{ left: x, top: y, width: w, height: h, pointerEvents: 'none', borderColor: z.color ?? undefined, background: z.color ? hexA(z.color, 0.06) : undefined }}
            >
              <div
                onPointerDown={(e) => startDrag(e, 'zone', z.id, 'move', { x, y, w, h })}
                onPointerMove={onDragMove}
                onPointerUp={onDragUp}
                className={cn('flex items-center gap-1 rounded-t-md px-2 py-1 text-xs font-semibold', !z.color && 'bg-muted')}
                style={{ pointerEvents: edit ? 'auto' : 'none', cursor: edit ? 'grab' : 'default', background: z.color ? hexA(z.color, 0.18) : undefined, color: z.color ?? undefined, touchAction: 'none' }}
              >
                <Home className="size-3.5 shrink-0" />
                <span className="truncate">{z.name}</span>
                {edit && (
                  <span className="ml-auto flex items-center gap-0.5">
                    <button type="button" title="เปลี่ยนสี" onPointerDown={(e) => e.stopPropagation()} onClick={() => cycleColor(z)} className="grid size-5 place-items-center rounded hover:bg-foreground/10"><Palette className="size-3.5" /></button>
                    <button type="button" title="เปลี่ยนชื่อ" onPointerDown={(e) => e.stopPropagation()} onClick={() => renameZone(z)} className="grid size-5 place-items-center rounded hover:bg-foreground/10"><Pencil className="size-3.5" /></button>
                    <button type="button" title="ลบห้อง" onPointerDown={(e) => e.stopPropagation()} onClick={() => confirmDeleteZone(z)} className="grid size-5 place-items-center rounded text-destructive hover:bg-destructive/10"><Trash2 className="size-3.5" /></button>
                  </span>
                )}
              </div>
              {edit && (
                <div
                  onPointerDown={(e) => startDrag(e, 'zone', z.id, 'resize', { x, y, w, h })}
                  onPointerMove={onDragMove}
                  onPointerUp={onDragUp}
                  title="ปรับขนาดห้อง"
                  className="absolute -bottom-1.5 -right-1.5 size-3.5 rounded-sm border border-background bg-foreground/50"
                  style={{ pointerEvents: 'auto', cursor: 'nwse-resize', touchAction: 'none' }}
                />
              )}
            </div>
          );
        })}

        {tables.length === 0 && zones.length === 0 && (
          <p className="absolute inset-0 grid place-items-center px-4 text-center text-sm text-muted-foreground">ยังไม่มีโต๊ะ — พิมพ์เลขโต๊ะแล้วกด “เพิ่มโต๊ะ”</p>
        )}

        {tables.map((t) => {
          const d = drag?.kind === 'table' && drag.id === t.id ? drag : null;
          const left = d ? d.x : t.pos_x, top = d ? d.y : t.pos_y;
          const dragging = d?.moved;
          const round = t.shape === 'circle' || t.width === t.height;
          const selected = sel === t.id || (edit && editSel === t.id);
          return (
            <div key={t.id} className="absolute" style={{ left, top, width: t.width, height: t.height }}>
              <button
                onPointerDown={(e) => startDrag(e, 'table', t.id, 'move', { x: t.pos_x, y: t.pos_y, w: t.width, h: t.height })}
                onPointerMove={onDragMove}
                onPointerUp={onDragUp}
                onClick={() => { if (!edit) onSelect(t.id); }}
                title={STATUS_TH[t.status]}
                className={cn(
                  'flex size-full select-none flex-col items-center justify-center text-[13px] font-bold',
                  tone(t.status).fill,
                  selected && 'ring-[3px] ring-primary',
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
                  onClick={(e) => { e.stopPropagation(); confirmDeleteTable(t); }}
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

      {/* edit inspector — assign the selected table to a room, or delete it */}
      {edit && inspTable && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
          <span className="font-semibold">โต๊ะ {inspTable.table_no}</span>
          <span className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">ห้อง:</span>
            <Select
              value={inspTable.zone_id != null ? String(inspTable.zone_id) : 'none'}
              onValueChange={(v) => patch.mutate({ path: `/api/restaurant/tables/${inspTable.id}`, body: { zone_id: v === 'none' ? null : Number(v) }, kind: 'table' })}
            >
              <SelectTrigger className="w-[180px]"><SelectValue placeholder="เลือกห้อง" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">ไม่มีห้อง</SelectItem>
                {zones.map((z) => <SelectItem key={z.id} value={String(z.id)}>{z.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </span>
          <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10" onClick={() => confirmDeleteTable(inspTable)} disabled={delTable.isPending}>
            <Trash2 className="size-4" /> ลบโต๊ะ
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setEditSel(null)}><X className="size-4" /> ปิด</Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {edit
          ? <span className="inline-flex items-center gap-1"><Move className="size-3" /> ลากโต๊ะ/ห้องเพื่อย้าย · จับมุมห้องเพื่อปรับขนาด · แตะโต๊ะเพื่อกำหนดห้อง/ลบ · กด “เสร็จสิ้น” เมื่อจัดเสร็จ</span>
          : 'แตะโต๊ะเพื่อจัดการ · กด “แก้ไขผัง” เพื่อจัดผัง/สร้างห้อง VIP · สีบอกสถานะ'}
      </p>
    </div>
  );
}
