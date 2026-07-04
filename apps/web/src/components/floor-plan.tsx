'use client';

// Floor-plan editor (โต๊ะ / ผังร้าน). Two modes:
//  • view  — แตะโต๊ะเพื่อจัดการ (เปิดแผงจัดการในหน้า tables); zones render as labelled rooms.
//  • edit  — drag/resize tables AND zones, delete them, assign a table to a room. Persists via the
//            REST API (PATCH /tables/:id pos/size/zone_id; PATCH/DELETE /zones/:id). A VIP room is
//            just a zone with an accent colour. Drops snap to an 8px grid. Shapes/rotation honoured.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Copy, Home, Move, Palette, Pencil, Plus, RotateCcw, RotateCw, Trash2, Undo2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export type TableRow = {
  id: number; table_no: string; status: string; seats: number;
  zone_id: number | null; shape: string; rotation: number; rev: number;
  pos_x: number; pos_y: number; width: number; height: number;
  session: { session_no: string; party_size: number; elapsed_min: number } | null;
  order: { order_no: string; status: string; total: number; waited_min: number } | null;
};
export type ZoneRow = { id: number; name: string; sort_order: number; color: string | null; pos_x: number; pos_y: number; width: number; height: number };

// Status codes → localized labels. Machine keys stay here; the Thai/English text lives in the i18n catalog
// (px.floor_status_*). statusTh(t, code) resolves at render, falling back to the raw code for unknowns.
export const STATUS_KEYS = ['available', 'reserved', 'occupied', 'bill_requested', 'paying', 'cleaning', 'out_of_service'];
export const statusTh = (t: (k: string, vars?: Record<string, string | number>) => string, s: string) =>
  STATUS_KEYS.includes(s) ? t(`px.floor_status_${s}`) : s;

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
// Labels live in the i18n catalog (px.floor_accent_*); resolve via accentLabel at render.
const ACCENTS = [
  { hex: '#caa53d', key: 'gold' },
  { hex: '#3b82f6', key: 'blue' },
  { hex: '#16a34a', key: 'green' },
  { hex: '#db2777', key: 'pink' },
  { hex: '#64748b', key: 'gray' },
];
const hexA = (hex: string, a: number) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

const CANVAS_H = 520; // px — the floor canvas height
const GRID = 8;       // drops snap to this grid so the plan lines up
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const snap = (v: number) => Math.round(v / GRID) * GRID;

type Drag = {
  kind: 'table' | 'zone'; id: number; action: 'move' | 'resize';
  px0: number; py0: number; x0: number; y0: number; w0: number; h0: number;
  x: number; y: number; w: number; h: number; moved: boolean;
};

export function FloorPlan({ tables, zones, onSelect, sel, onChange, onZonesChange }: {
  tables: TableRow[]; zones: ZoneRow[]; onSelect: (id: number) => void; sel: number | null; onChange: () => void; onZonesChange: () => void;
}) {
  const { t } = useLang();
  const ACCENT_KEYS = ACCENTS.map((a) => a.key);
  const accentLabel = (k: string) => (ACCENT_KEYS.includes(k) ? t(`px.floor_accent_${k}`) : k);
  const [no, setNo] = useState('');
  const [zoneName, setZoneName] = useState('');
  const [zoneColor, setZoneColor] = useState('');     // '' = no accent
  const [edit, setEdit] = useState(false);
  const [editSel, setEditSel] = useState<number | null>(null);   // selected table id for the edit inspector
  const [drag, setDrag] = useState<Drag | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; onYes: () => void } | null>(null);
  const [rename, setRename] = useState<{ z: ZoneRow; value: string } | null>(null);
  const [undoStack, setUndoStack] = useState<{ path: string; body: any; kind: 'table' | 'zone' }[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const pushUndo = (u: { path: string; body: any; kind: 'table' | 'zone' }) => setUndoStack((s) => [...s.slice(-19), u]);

  const onErr = (e: any) => toast.error(e.message);
  const addTable = useMutation({
    mutationFn: () => api('/api/restaurant/tables', { method: 'POST', body: JSON.stringify({ table_no: no.trim(), pos_x: 20 + ((tables.length % 5) * 120), pos_y: 20 + Math.floor(tables.length / 5) * 110 }) }),
    onSuccess: () => { setNo(''); onChange(); }, onError: onErr,
  });
  // duplicate a table — same shape/size/seats/rotation/room, offset a little, with a unique number
  const dupNo = (base: string) => { const taken = new Set(tables.map((t) => t.table_no)); let i = 2; while (taken.has(`${base}-${i}`)) i++; return `${base}-${i}`; };
  const dup = useMutation({
    mutationFn: (t: TableRow) => api('/api/restaurant/tables', { method: 'POST', body: JSON.stringify({ table_no: dupNo(t.table_no), pos_x: snap(t.pos_x + 24), pos_y: snap(t.pos_y + 24), width: t.width, height: t.height, shape: t.shape, seats: t.seats, rotation: t.rotation, zone_id: t.zone_id }) }),
    onSuccess: () => { toast.success(t('px.floor_duplicated')); onChange(); }, onError: onErr,
  });
  // generic PATCH for table/zone move+resize+appearance. On success we patch the cache in place (incl. the
  // bumped `rev`) so rapid follow-up edits use a fresh rev and don't self-conflict; a stale-write 409 from
  // another editor surfaces as a refresh.
  const patch = useMutation({
    mutationFn: (v: { path: string; body: any; kind: 'table' | 'zone' }) => api<any>(v.path, { method: 'PATCH', body: JSON.stringify(v.body) }),
    onSuccess: (row, v) => {
      if (v.kind === 'zone') {
        qc.setQueryData<{ zones: ZoneRow[] }>(['floor-zones'], (old) => (old ? { ...old, zones: old.zones.map((z) => (z.id === row.id ? { ...z, ...row } : z)) } : old));
        onZonesChange();
      } else {
        qc.setQueryData<{ tables: TableRow[] }>(['tables-status'], (old) => (old ? { ...old, tables: old.tables.map((t) => (t.id === row.id ? { ...t, ...row } : t)) } : old));
      }
    },
    onError: (e: any, v) => {
      if (typeof e?.message === 'string' && /แก้ไขโดยผู้อื่น|STALE_WRITE/i.test(e.message)) { toast.error(t('px.floor_stale_write_refresh')); if (v.kind === 'zone') onZonesChange(); else onChange(); }
      else onErr(e);
    },
  });
  const delTable = useMutation({
    mutationFn: (id: number) => api(`/api/restaurant/tables/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success(t('px.floor_table_deleted')); setEditSel(null); onChange(); }, onError: onErr,
  });
  const addZone = useMutation({
    mutationFn: () => api('/api/restaurant/zones', { method: 'POST', body: JSON.stringify({ name: zoneName.trim(), color: zoneColor || null, pos_x: 16 + ((zones.length % 2) * 340), pos_y: 16 + Math.floor(zones.length / 2) * 230, width: 320, height: 200 }) }),
    onSuccess: () => { setZoneName(''); onZonesChange(); }, onError: onErr,
  });
  const delZone = useMutation({
    mutationFn: (id: number) => api(`/api/restaurant/zones/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success(t('px.floor_room_deleted')); onZonesChange(); onChange(); }, onError: onErr,   // tables un-assigned → refresh both
  });

  // forward edit: optimistic-locked (sends the table's current rev) + records an undo of the old values.
  const editTable = (t: TableRow, body: any, inverse: any) => {
    pushUndo({ path: `/api/restaurant/tables/${t.id}`, body: inverse, kind: 'table' });
    patch.mutate({ path: `/api/restaurant/tables/${t.id}`, body: { ...body, rev: t.rev }, kind: 'table' });
  };
  const editZone = (z: ZoneRow, body: any, inverse: any) => {
    pushUndo({ path: `/api/restaurant/zones/${z.id}`, body: inverse, kind: 'zone' });
    patch.mutate({ path: `/api/restaurant/zones/${z.id}`, body, kind: 'zone' });
  };
  // undo applies the recorded inverse without a rev → always wins (it's a deliberate take-back).
  const doUndo = () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack((s) => s.slice(0, -1));
    patch.mutate(last);
  };

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
    if (d.kind === 'zone') {
      const z = zones.find((zz) => zz.id === d.id);
      if (!z) return;
      if (d.action === 'move') editZone(z, { pos_x: snap(d.x), pos_y: snap(d.y) }, { pos_x: z.pos_x, pos_y: z.pos_y });
      else editZone(z, { width: snap(d.w), height: snap(d.h) }, { width: z.width, height: z.height });
      return;
    }
    const t = tables.find((tt) => tt.id === d.id);
    if (!t) return;
    if (d.action === 'resize') { editTable(t, { width: snap(d.w), height: snap(d.h) }, { width: t.width, height: t.height }); return; }
    // move → also auto-assign the table to whichever room now contains its centre (geometry ↔ zone sync)
    const px = snap(d.x), py = snap(d.y);
    const cx = px + t.width / 2, cy = py + t.height / 2;
    const room = zones.find((z) => cx >= z.pos_x && cx <= z.pos_x + z.width && cy >= z.pos_y && cy <= z.pos_y + z.height);
    const newZid = room ? room.id : null;
    const body: any = { pos_x: px, pos_y: py };
    const inverse: any = { pos_x: t.pos_x, pos_y: t.pos_y };
    if (newZid !== (t.zone_id ?? null)) { body.zone_id = newZid; inverse.zone_id = t.zone_id ?? null; }
    editTable(t, body, inverse);
  };

  const confirmDeleteTable = (tbl: TableRow) => setConfirm({ title: t('px.floor_delete_table_title', { no: tbl.table_no }), body: t('px.floor_delete_table_body'), onYes: () => delTable.mutate(tbl.id) });
  const confirmDeleteZone = (z: ZoneRow) => setConfirm({ title: t('px.floor_delete_zone_title', { name: z.name }), body: t('px.floor_delete_zone_body'), onYes: () => delZone.mutate(z.id) });
  const submitRename = () => { if (rename && rename.value.trim()) editZone(rename.z, { name: rename.value.trim() }, { name: rename.z.name }); setRename(null); };
  const cycleColor = (z: ZoneRow) => {
    const order = [null, ...ACCENTS.map((a) => a.hex)];
    const next = order[(order.indexOf(z.color) + 1) % order.length];
    editZone(z, { color: next }, { color: z.color });
  };

  // shape change normalises dimensions so the new shape reads immediately (circle/square → equal sides;
  // rect → a visibly rectangular ratio when it was square). Seats/rotation are simple field patches.
  const setShape = (t: TableRow, shape: string) => {
    const body: any = { shape };
    if (shape === 'circle' || shape === 'square') { const s = Math.round(Math.max(t.width, t.height)); body.width = s; body.height = s; }
    else if (t.width === t.height) { body.height = Math.max(40, Math.round(t.width * 0.62)); }
    editTable(t, body, { shape: t.shape, width: t.width, height: t.height });
  };
  const rotateBy = (t: TableRow, delta: number) => {
    const r = ((((t.rotation || 0) + delta) % 360) + 360) % 360;
    editTable(t, { rotation: r }, { rotation: t.rotation || 0 });
  };

  const inspTable = editSel != null ? tables.find((t) => t.id === editSel) ?? null : null;

  // keyboard a11y: with a table selected in edit mode, arrows nudge it (Shift = 1px), Delete removes it.
  // Uses an unconditional patch (no rev) so holding an arrow can't self-conflict on key-repeat.
  useEffect(() => {
    if (!edit || editSel == null) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;   // don't hijack typing
      const t = tables.find((x) => x.id === editSel);
      if (!t) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); confirmDeleteTable(t); return; }
      const step = e.shiftKey ? 1 : GRID;
      let dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -step; else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step; else if (e.key === 'ArrowDown') dy = step;
      else return;
      e.preventDefault();
      pushUndo({ path: `/api/restaurant/tables/${t.id}`, body: { pos_x: t.pos_x, pos_y: t.pos_y }, kind: 'table' });
      patch.mutate({ path: `/api/restaurant/tables/${t.id}`, body: { pos_x: Math.max(0, t.pos_x + dx), pos_y: Math.max(0, t.pos_y + dy) }, kind: 'table' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit, editSel, tables]);

  // the canvas grows to hold the furthest table/room (+ headroom) and scrolls — fits big venues.
  const rightEdge = Math.max(0, ...tables.map((t) => t.pos_x + t.width), ...zones.map((z) => z.pos_x + z.width));
  const bottomEdge = Math.max(0, ...tables.map((t) => t.pos_y + t.height), ...zones.map((z) => z.pos_y + z.height));
  const contentW = Math.max(960, rightEdge + 160);
  const contentH = Math.max(CANVAS_H, bottomEdge + 160);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-[180px]"
          placeholder={t('px.floor_table_no_placeholder')}
          value={no}
          onChange={(e) => setNo(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && no.trim() && !addTable.isPending) addTable.mutate(); }}
        />
        <Button disabled={!no.trim() || addTable.isPending} onClick={() => addTable.mutate()}>
          <Plus className="size-4" /> {t('px.floor_add_table')}
        </Button>
        {edit && (
          <Button variant="outline" className="ml-auto" disabled={!undoStack.length || patch.isPending} onClick={doUndo} title={t('px.floor_undo_title')}>
            <Undo2 className="size-4" /> {t('px.floor_undo')}{undoStack.length ? ` (${undoStack.length})` : ''}
          </Button>
        )}
        <Button variant={edit ? 'default' : 'outline'} className={edit ? undefined : 'ml-auto'} onClick={() => { setEdit((v) => !v); setDrag(null); setEditSel(null); setUndoStack([]); }}>
          {edit ? <><Check className="size-4" /> {t('px.floor_done')}</> : <><Pencil className="size-4" /> {t('px.floor_edit_plan')}</>}
        </Button>
      </div>

      {edit && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-2">
          <Home className="size-4 text-muted-foreground" />
          <Input
            className="max-w-[200px]"
            placeholder={t('px.floor_zone_name_placeholder')}
            value={zoneName}
            onChange={(e) => setZoneName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && zoneName.trim() && !addZone.isPending) addZone.mutate(); }}
          />
          <Select value={zoneColor || 'none'} onValueChange={(v) => setZoneColor(v === 'none' ? '' : v)}>
            <SelectTrigger className="w-[150px]"><SelectValue placeholder={t('px.floor_zone_color_placeholder')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('px.floor_no_color')}</SelectItem>
              {ACCENTS.map((a) => <SelectItem key={a.hex} value={a.hex}>{accentLabel(a.key)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" disabled={!zoneName.trim() || addZone.isPending} onClick={() => addZone.mutate()}>
            <Plus className="size-4" /> {t('px.floor_add_room')}
          </Button>
        </div>
      )}

      <div className={cn('overflow-auto rounded-lg border border-dashed bg-muted/40', edit && 'border-primary/60 bg-primary/5')} style={{ maxHeight: CANVAS_H }}>
        <div
          ref={canvasRef}
          onPointerDown={(e) => { if (edit && e.target === canvasRef.current) setEditSel(null); }}
          className="relative"
          style={{ width: '100%', minWidth: contentW, height: contentH }}
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
                {/* a star marks an accented room so VIP is not signalled by colour alone (a11y) */}
                {z.color ? <span title={t('px.floor_featured_room')} className="shrink-0">★</span> : <Home className="size-3.5 shrink-0" />}
                <span className="truncate">{z.name}</span>
                {edit && (
                  <span className="ml-auto flex items-center gap-0.5">
                    <button type="button" title={t('px.floor_change_color')} onPointerDown={(e) => e.stopPropagation()} onClick={() => cycleColor(z)} className="grid size-6 place-items-center rounded hover:bg-foreground/10"><Palette className="size-4" /></button>
                    <button type="button" title={t('px.floor_rename')} onPointerDown={(e) => e.stopPropagation()} onClick={() => setRename({ z, value: z.name })} className="grid size-6 place-items-center rounded hover:bg-foreground/10"><Pencil className="size-4" /></button>
                    <button type="button" title={t('px.floor_delete_room')} onPointerDown={(e) => e.stopPropagation()} onClick={() => confirmDeleteZone(z)} className="grid size-6 place-items-center rounded text-destructive hover:bg-destructive/10"><Trash2 className="size-4" /></button>
                  </span>
                )}
              </div>
              {edit && (
                <div
                  onPointerDown={(e) => startDrag(e, 'zone', z.id, 'resize', { x, y, w, h })}
                  onPointerMove={onDragMove}
                  onPointerUp={onDragUp}
                  title={t('px.floor_resize_room')}
                  className="absolute -bottom-3 -right-3 grid place-items-center p-2"
                  style={{ pointerEvents: 'auto', cursor: 'nwse-resize', touchAction: 'none' }}
                >
                  <span className="size-3.5 rounded-sm border border-background bg-foreground/50" />
                </div>
              )}
            </div>
          );
        })}

        {tables.length === 0 && zones.length === 0 && (
          <p className="absolute inset-0 grid place-items-center px-4 text-center text-sm text-muted-foreground">{t('px.floor_empty_hint')}</p>
        )}

        {tables.map((tbl) => {
          const d = drag?.kind === 'table' && drag.id === tbl.id ? drag : null;
          const left = d && d.action === 'move' ? d.x : tbl.pos_x;
          const top = d && d.action === 'move' ? d.y : tbl.pos_y;
          const w = d && d.action === 'resize' ? d.w : tbl.width;
          const h = d && d.action === 'resize' ? d.h : tbl.height;
          const dragging = d?.moved;
          const round = tbl.shape === 'circle' || (tbl.shape !== 'square' && w === h);
          const selected = sel === tbl.id || (edit && editSel === tbl.id);
          return (
            <div key={tbl.id} className="absolute" style={{ left, top, width: w, height: h }}>
              <button
                onPointerDown={(e) => startDrag(e, 'table', tbl.id, 'move', { x: tbl.pos_x, y: tbl.pos_y, w: tbl.width, h: tbl.height })}
                onPointerMove={onDragMove}
                onPointerUp={onDragUp}
                onClick={() => { if (!edit) onSelect(tbl.id); }}
                onKeyDown={(e) => { if (edit && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setEditSel(tbl.id); } }}
                aria-label={t('px.floor_table_aria', { no: tbl.table_no, status: statusTh(t, tbl.status) })}
                title={statusTh(t, tbl.status)}
                className={cn(
                  'flex size-full select-none flex-col items-center justify-center text-[13px] font-bold',
                  tone(tbl.status).fill,
                  selected && 'ring-[3px] ring-primary',
                  edit ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-pointer',
                )}
                style={{ borderRadius: round ? '50%' : 8, transform: tbl.rotation ? `rotate(${tbl.rotation}deg)` : undefined, touchAction: edit ? 'none' : undefined }}
              >
                {tbl.table_no}
                <span className="text-[10px] font-normal">{statusTh(t, tbl.status)}</span>
              </button>
              {edit && (
                <>
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); confirmDeleteTable(tbl); }}
                    title={t('px.floor_delete_table')}
                    className="absolute -right-2.5 -top-2.5 grid size-6 place-items-center rounded-full bg-destructive text-destructive-foreground shadow ring-1 ring-background hover:bg-destructive/90"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                  <div
                    onPointerDown={(e) => startDrag(e, 'table', tbl.id, 'resize', { x: tbl.pos_x, y: tbl.pos_y, w: tbl.width, h: tbl.height })}
                    onPointerMove={onDragMove}
                    onPointerUp={onDragUp}
                    title={t('px.floor_resize_table')}
                    className="absolute -bottom-2.5 -right-2.5 grid place-items-center p-2"
                    style={{ pointerEvents: 'auto', cursor: 'nwse-resize', touchAction: 'none' }}
                  >
                    <span className="size-3 rounded-sm border border-background bg-foreground/60" />
                  </div>
                </>
              )}
            </div>
          );
        })}
        </div>
      </div>

      {/* edit inspector — shape / seats / rotation / room for the selected table, or delete it */}
      {edit && inspTable && (
        <div key={inspTable.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card p-3 text-sm">
          <span className="font-semibold">{t('px.floor_table_label', { no: inspTable.table_no })}</span>

          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">{t('px.floor_shape')}</span>
            <Select value={inspTable.shape || 'rect'} onValueChange={(v) => setShape(inspTable, v)}>
              <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="circle">{t('px.floor_shape_circle')}</SelectItem>
                <SelectItem value="rect">{t('px.floor_shape_rect')}</SelectItem>
                <SelectItem value="square">{t('px.floor_shape_square')}</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">{t('px.floor_seats')}</span>
            <Input
              type="number" min={1} className="w-[72px]" defaultValue={inspTable.seats}
              onBlur={(e) => { const s = Number(e.target.value); if (s > 0 && s !== inspTable.seats) editTable(inspTable, { seats: s }, { seats: inspTable.seats }); }}
            />
          </label>

          {inspTable.shape !== 'circle' && (
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">{t('px.floor_rotate')}</span>
              <Button variant="outline" size="icon" className="size-8" title={t('px.floor_rotate_left')} onClick={() => rotateBy(inspTable, -15)}><RotateCcw className="size-4" /></Button>
              <span className="w-10 text-center tabular">{inspTable.rotation || 0}°</span>
              <Button variant="outline" size="icon" className="size-8" title={t('px.floor_rotate_right')} onClick={() => rotateBy(inspTable, 15)}><RotateCw className="size-4" /></Button>
            </span>
          )}

          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">{t('px.floor_room')}</span>
            <Select
              value={inspTable.zone_id != null ? String(inspTable.zone_id) : 'none'}
              onValueChange={(v) => editTable(inspTable, { zone_id: v === 'none' ? null : Number(v) }, { zone_id: inspTable.zone_id })}
            >
              <SelectTrigger className="w-[160px]"><SelectValue placeholder={t('px.floor_select_room')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('px.floor_no_room')}</SelectItem>
                {zones.map((z) => <SelectItem key={z.id} value={String(z.id)}>{z.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>

          <Button variant="outline" size="sm" onClick={() => dup.mutate(inspTable)} disabled={dup.isPending}>
            <Copy className="size-4" /> {t('px.floor_duplicate')}
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10" onClick={() => confirmDeleteTable(inspTable)} disabled={delTable.isPending}>
            <Trash2 className="size-4" /> {t('px.floor_delete_table')}
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setEditSel(null)}><X className="size-4" /> {t('px.floor_close')}</Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {edit
          ? <span className="inline-flex items-center gap-1"><Move className="size-3" /> ลากเพื่อย้าย · จับมุมเพื่อปรับขนาด · แตะโต๊ะเพื่อตั้งรูปทรง/หมุน/ที่นั่ง/ห้อง · กด “เสร็จสิ้น” เมื่อจัดเสร็จ</span>
          : 'แตะโต๊ะเพื่อจัดการ · กด “แก้ไขผัง” เพื่อจัดผัง/สร้างห้อง VIP · สีบอกสถานะ'}
      </p>

      {/* confirm (delete) + rename dialogs — design-system, replaces window.confirm/prompt */}
      <Dialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.title}</DialogTitle>
            <DialogDescription>{confirm?.body}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>ยกเลิก</Button>
            <Button variant="destructive" onClick={() => { confirm?.onYes(); setConfirm(null); }}>ลบ</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rename} onOpenChange={(o) => { if (!o) setRename(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>เปลี่ยนชื่อห้อง</DialogTitle></DialogHeader>
          <Input
            autoFocus
            value={rename?.value ?? ''}
            onChange={(e) => setRename((r) => (r ? { ...r, value: e.target.value } : r))}
            onKeyDown={(e) => { if (e.key === 'Enter') submitRename(); }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRename(null)}>ยกเลิก</Button>
            <Button disabled={!rename?.value.trim()} onClick={submitRename}>บันทึก</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
