'use client';

import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Eye, EyeOff, GripVertical, KeyRound, ListTree, Lock, Plus, Power, RotateCcw, Search, ShieldCheck, ToggleLeft, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  moduleLabel,
  moduleCategoryKey,
  categoryLabel,
  menusForPerm,
  MODULE_CATEGORIES,
  type ModuleFlag,
} from '@/lib/modules';
import { INTERNAL_NAV, allGroupItems, navForWorkspace, orderGroups, orderItems, type NavGroup, type NavItem, type Workspace } from '@/lib/nav';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

export default function SettingsPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('st.set.title')} description={t('st.set.subtitle')} />
      <Tabs
        tabs={[
          { key: 'modules', label: t('st.set.tab_modules'), content: <Modules /> },
          { key: 'keys', label: 'API Keys', content: <ApiKeys /> },
          { key: 'identity', label: 'SSO / SCIM', content: <Identity /> },
          { key: 'mfa', label: t('st.set.tab_mfa'), content: <Mfa /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Menu & Modules ─────────────────────────
// Two axes of control, on one screen:
//   • Section A — Menu visibility: hide individual sidebar entries / sub-sections / whole categories from
//     everyone's nav. Chrome only (permissions still apply). Mirrors the sidebar (nav.ts) so names match.
//   • Section B — System modules: the permission feature-flags — disabling one also blocks its API routes.
//     Grouped + Thai-named + shows exactly which menus each module controls.
type ModulesResp = { modules: ModuleFlag[]; navDisabled?: string[]; groupOrder?: string[]; itemOrder?: Record<string, string[]> };
const NAV_ALWAYS_VISIBLE = ['/settings', '/admin/users']; // never hidable (admin lockout guard)

function Modules() {
  const qc = useQueryClient();
  const { t, lang } = useLang();
  const list = useQuery<ModulesResp>({ queryKey: ['admin-modules'], queryFn: () => api('/api/admin/modules') });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-modules'] });
    qc.invalidateQueries({ queryKey: ['module-flags'] }); // refresh the sidebar nav
  };

  // One mutation drives both single-row and category-bulk toggles (keys[] fanned out in parallel).
  const toggleModule = useMutation({
    mutationFn: (v: { keys: string[]; enabled: boolean }) =>
      Promise.all(v.keys.map((key) => api('/api/admin/modules', { method: 'POST', body: JSON.stringify({ key, enabled: v.enabled }) }))),
    onSuccess: (_r, v) => {
      notifySuccess(v.keys.length === 1
        ? t('st.set.module_toggled', { name: moduleLabel(v.keys[0], lang), state: v.enabled ? t('st.set.on') : t('st.set.off') })
        : t('st.set.modules_toggled', { count: v.keys.length, state: v.enabled ? t('st.set.on') : t('st.set.off') }));
      invalidate();
    },
    onError: (e: any) => notifyError(e.message),
  });

  const toggleNav = useMutation({
    mutationFn: (v: { hrefs: string[]; enabled: boolean }) => api('/api/admin/modules/nav', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: (_r, v) => {
      notifySuccess(v.hrefs.length === 1
        ? t('st.set.menu_toggled', { state: v.enabled ? t('st.set.show') : t('st.set.hide') })
        : t('st.set.menus_toggled', { count: v.hrefs.length, state: v.enabled ? t('st.set.show') : t('st.set.hide') }));
      invalidate();
    },
    onError: (e: any) => notifyError(e.message),
  });

  const reorder = useMutation({
    mutationFn: (order: string[]) => api('/api/admin/modules/nav-order', { method: 'POST', body: JSON.stringify({ order }) }),
    onSuccess: () => { notifySuccess(t('st.set.group_order_updated')); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });

  const reorderItems = useMutation({
    mutationFn: (v: { scope: string; order: string[] }) => api('/api/admin/modules/nav-item-order', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: () => { notifySuccess(t('st.set.item_order_updated')); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });

  const [resetAsk, setResetAsk] = useState(false);
  const resetNav = useMutation({
    mutationFn: () => api('/api/admin/modules/nav-reset', { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('st.set.nav_reset_done')); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });

  const mods = list.data?.modules ?? [];
  const navDisabled = useMemo(() => new Set(list.data?.navDisabled ?? []), [list.data]);
  const groupOrder = list.data?.groupOrder;
  const itemOrder = list.data?.itemOrder;
  const disabledCount = mods.filter((m) => !m.enabled).length;

  return (
    <div className="space-y-4">
      <Card className="gap-2 p-5">
        <h3 className="text-base font-semibold">{t('st.set.menu_modules_heading')}</h3>
        <p className="text-sm text-muted-foreground">
          <b>{t('st.set.hide_menu_label')}</b>{t('st.set.hide_menu_desc')}<b>{t('st.set.disable_module_label')}</b>{t('st.set.disable_module_desc')}
        </p>
        <p className="text-xs text-muted-foreground">{t('st.set.per_company_note')}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {navDisabled.size > 0 && <Badge variant={statusVariant('Cancelled')}>{t('st.set.hidden_menus_badge', { count: navDisabled.size })}</Badge>}
          {disabledCount > 0 && <Badge variant={statusVariant('Cancelled')}>{t('st.set.disabled_modules_badge', { count: disabledCount })}</Badge>}
          {(navDisabled.size > 0 || (groupOrder?.length ?? 0) > 0) && (
            <Button variant="outline" size="sm" className="ml-auto" disabled={resetNav.isPending}
              onClick={() => setResetAsk(true)}>
              <RotateCcw className="size-4" /> {t('st.set.reset_nav_btn')}
            </Button>
          )}
        </div>
        <ConfirmDialog
          open={resetAsk}
          onOpenChange={setResetAsk}
          title={t('st.set.reset_nav_confirm')}
          busy={resetNav.isPending}
          onConfirm={() => { setResetAsk(false); resetNav.mutate(); }}
        />
      </Card>

      <StateView q={list}>
        <div className="space-y-6">
          <MenuVisibility navDisabled={navDisabled} onToggle={(hrefs, enabled) => toggleNav.mutate({ hrefs, enabled })}
            groupOrder={groupOrder} itemOrder={itemOrder} onReorder={(order) => reorder.mutate(order)}
            onReorderItems={(scope, order) => reorderItems.mutate({ scope, order })}
            pending={toggleNav.isPending || reorder.isPending || reorderItems.isPending} t={t} />
          <SystemModules mods={mods} onToggle={(keys, enabled) => toggleModule.mutate({ keys, enabled })} pending={toggleModule.isPending} lang={lang} t={t} />
        </div>
      </StateView>
    </div>
  );
}

// ── shared bits ────────────────────────────────────────────────────────────────
function VisBtn({ hidden, onClick, disabled, size = 'sm' }: { hidden: boolean; onClick: () => void; disabled?: boolean; size?: 'sm' | 'xs' }) {
  const { t } = useLang();
  return (
    <Button variant={hidden ? 'default' : 'outline'} size="sm" disabled={disabled} onClick={onClick}
      className={cn('shrink-0', size === 'xs' && 'h-7 px-2 text-xs')}>
      {hidden ? <><Eye className="size-3.5" /> {t('st.set.show')}</> : <><EyeOff className="size-3.5" /> {t('st.set.hide')}</>}
    </Button>
  );
}

// Count how many of these hrefs are hidden (protected ones don't count — they can't be hidden).
function hiddenStats(hrefs: string[], hidden: Set<string>) {
  const toggleable = hrefs.filter((h) => !NAV_ALWAYS_VISIBLE.includes(h));
  const off = toggleable.filter((h) => hidden.has(h)).length;
  return { total: toggleable.length, off, allOff: toggleable.length > 0 && off === toggleable.length };
}

// ── Section A: Menu visibility — a collapsible tree mirroring the sidebar. Hide/show, reorder (▲▼ or drag
//    the ⋮⋮ handle), and search — all system-wide (chrome only). ─────────
type DragState = { kind: 'group'; key: string } | { kind: 'item'; key: string; scope: string } | null;
function MenuVisibility({
  navDisabled, onToggle, groupOrder, itemOrder, onReorder, onReorderItems, pending, t,
}: {
  navDisabled: Set<string>;
  onToggle: (hrefs: string[], enabled: boolean) => void;
  groupOrder?: string[];
  itemOrder?: Record<string, string[]>;
  onReorder: (order: string[]) => void;
  onReorderItems: (scope: string, order: string[]) => void;
  pending: boolean;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // Mirror the sidebar's ERP/POS split so the tree lines up with what staff actually see. "All" merges both
  // surfaces (with a per-group workspace chip); ERP/POS use the SAME filter the sidebar uses (navForWorkspace).
  const [ws, setWs] = useState<'all' | Workspace>('all');
  const [q, setQ] = useState('');
  const [drag, setDrag] = useState<DragState>(null);
  const query = q.trim().toLowerCase();
  const searching = query.length > 0;
  const canReorder = !searching; // reordering is disabled while filtering (order would be relative to matches)
  const wsChip = (g: NavGroup) => (!g.workspace || g.workspace.length === 2 ? t('st.set.both') : g.workspace[0] === 'pos' ? 'POS' : 'ERP');

  const wsGroups = orderGroups(ws === 'all' ? INTERNAL_NAV : navForWorkspace(INTERNAL_NAV, ws), groupOrder);
  const itemsOf = (items: NavItem[], scope: string) => orderItems(items, itemOrder?.[scope]);
  const itMatch = (it: NavItem) => !searching || t(it.label).toLowerCase().includes(query) || it.href.toLowerCase().includes(query);
  const grpTitleMatch = (g: NavGroup) => t(g.title).toLowerCase().includes(query);

  // Category order (▲▼ swaps the adjacent visible category; drag moves before the drop target). Both write
  // the FULL global order so the stored list stays complete across ERP/POS filtering.
  const moveGroup = (title: string, dir: -1 | 1) => {
    const vis = wsGroups.map((g) => g.title);
    const nb = vis[vis.indexOf(title) + dir];
    if (!nb) return;
    const full = orderGroups(INTERNAL_NAV, groupOrder).map((g) => g.title);
    const ia = full.indexOf(title); const ib = full.indexOf(nb);
    if (ia < 0 || ib < 0) return;
    [full[ia], full[ib]] = [full[ib], full[ia]];
    onReorder(full);
  };
  const dropGroup = (targetTitle: string) => {
    if (!drag || drag.kind !== 'group' || drag.key === targetTitle) return;
    const full = orderGroups(INTERNAL_NAV, groupOrder).map((g) => g.title);
    const from = full.indexOf(drag.key); if (from < 0) return;
    full.splice(from, 1);
    const to = full.indexOf(targetTitle);
    full.splice(to < 0 ? full.length : to, 0, drag.key);
    onReorder(full);
  };

  // Item order within one container (scope = a group / sub-section title).
  const moveItem = (scope: string, list: NavItem[], href: string, dir: -1 | 1) => {
    const vis = itemsOf(list, scope).map((i) => i.href);
    const j = vis.indexOf(href) + dir;
    if (j < 0 || j >= vis.length) return;
    const full = vis.slice();
    [full[j - dir], full[j]] = [full[j], full[j - dir]];
    onReorderItems(scope, full);
  };
  const dropItem = (scope: string, list: NavItem[], targetHref: string) => {
    if (!drag || drag.kind !== 'item' || drag.scope !== scope || drag.key === targetHref) return;
    const full = itemsOf(list, scope).map((i) => i.href);
    const from = full.indexOf(drag.key); if (from < 0) return;
    full.splice(from, 1);
    const to = full.indexOf(targetHref);
    full.splice(to < 0 ? full.length : to, 0, drag.key);
    onReorderItems(scope, full);
  };

  const renderItem = (it: NavItem, scope: string, list: NavItem[], idx: number, count: number) => {
    const protectedItem = NAV_ALWAYS_VISIBLE.includes(it.href);
    const hidden = navDisabled.has(it.href);
    return (
      <div key={it.href}
        onDragOver={canReorder && drag?.kind === 'item' && drag.scope === scope ? (e) => e.preventDefault() : undefined}
        onDrop={canReorder ? () => { dropItem(scope, list, it.href); setDrag(null); } : undefined}
        className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50', hidden && 'opacity-60', drag?.kind === 'item' && drag.key === it.href && 'opacity-40')}>
        {canReorder && (
          <span draggable={!pending} onDragStart={!pending ? () => setDrag({ kind: 'item', key: it.href, scope }) : undefined} onDragEnd={() => setDrag(null)}
            title={t('st.set.drag_to_reorder')} className="shrink-0 cursor-grab text-muted-foreground/40 hover:text-muted-foreground"><GripVertical className="size-3.5" /></span>
        )}
        <it.icon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{t(it.label)}</div>
          <code className="text-[11px] text-muted-foreground">{it.href}</code>
        </div>
        <div className="hidden shrink-0 flex-wrap justify-end gap-1 sm:flex">
          {(it.perms ?? []).slice(0, 3).map((p) => (
            <code key={p} className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{p}</code>
          ))}
        </div>
        {canReorder && (
          <div className="flex shrink-0 items-center">
            <button type="button" disabled={pending || idx === 0} onClick={() => moveItem(scope, list, it.href, -1)}
              aria-label={t('st.set.move_up_label', { name: t(it.label) })} title={t('st.set.move_up')} className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-25"><ArrowUp className="size-3" /></button>
            <button type="button" disabled={pending || idx === count - 1} onClick={() => moveItem(scope, list, it.href, 1)}
              aria-label={t('st.set.move_down_label', { name: t(it.label) })} title={t('st.set.move_down')} className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-25"><ArrowDown className="size-3" /></button>
          </div>
        )}
        {protectedItem ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3.5" /> {t('st.set.locked')}</span>
        ) : (
          <VisBtn hidden={hidden} disabled={pending} size="xs" onClick={() => onToggle([it.href], hidden)} />
        )}
      </div>
    );
  };

  // Build the (optionally search-filtered) group list once, with each group's ordered flat items + subs.
  const visibleGroups = wsGroups
    .map((g) => ({
      g,
      flat: itemsOf(g.items ?? [], g.title).filter(itMatch),
      subs: (g.subgroups ?? []).map((sub) => ({ sub, items: itemsOf(sub.items, sub.title).filter(itMatch) })),
    }))
    .filter(({ g, flat, subs }) => !searching || grpTitleMatch(g) || flat.length > 0 || subs.some((s) => s.items.length > 0));

  return (
    <Card className="gap-0 p-0">
      <div className="flex flex-wrap items-center gap-2 border-b p-4">
        <ListTree className="size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold">{t('st.set.menu_manage_heading')}</h3>
          <p className="text-sm text-muted-foreground">{t('st.set.menu_manage_desc1')}<b>{t('st.set.reorder_word')}</b>{t('st.set.menu_manage_desc2')}<GripVertical className="inline size-3 align-text-bottom" />{t('st.set.menu_manage_desc3')}</p>
        </div>
        <div className="flex shrink-0 gap-0.5 rounded-md bg-muted p-0.5 text-xs">
          {([['all', 'st.set.all'], ['erp', 'ERP'], ['pos', 'POS']] as const).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setWs(id)}
              className={cn('rounded px-2.5 py-1 font-medium transition-colors', ws === id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {id === 'all' ? t(label) : label}
            </button>
          ))}
        </div>
        <div className="relative w-full">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('st.set.search_placeholder')} className="pl-8" />
        </div>
      </div>
      <div className="divide-y">
        {visibleGroups.map(({ g, flat, subs }, gi) => {
          const allHrefs = allGroupItems(g).map((i) => i.href);
          const st = hiddenStats(allHrefs, navDisabled);
          const isOpen = searching || (open[g.title] ?? false);
          const groupDragging = drag?.kind === 'group';
          return (
            <div key={g.title}
              onDragOver={canReorder && groupDragging ? (e) => e.preventDefault() : undefined}
              onDrop={canReorder ? () => { dropGroup(g.title); setDrag(null); } : undefined}
              className={cn(groupDragging && drag.key === g.title && 'opacity-40')}>
              <div className="flex items-center gap-2 px-3 py-2">
                {canReorder && (
                  <span draggable={!pending} onDragStart={!pending ? () => setDrag({ kind: 'group', key: g.title }) : undefined} onDragEnd={() => setDrag(null)}
                    title={t('st.set.drag_group')} className="shrink-0 cursor-grab text-muted-foreground/40 hover:text-muted-foreground"><GripVertical className="size-4" /></span>
                )}
                <button type="button" onClick={() => setOpen((o) => ({ ...o, [g.title]: !isOpen }))}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                  {isOpen ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="truncate text-sm font-semibold">{t(g.title)}</span>
                  {ws === 'all' && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{wsChip(g)}</span>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {st.off > 0 ? t('st.set.hidden_ratio', { off: st.off, total: st.total }) : t('st.set.menu_count', { count: st.total })}
                  </span>
                </button>
                {canReorder && (
                  <div className="flex shrink-0 items-center">
                    <button type="button" disabled={pending || gi === 0} onClick={() => moveGroup(g.title, -1)}
                      aria-label={t('st.set.move_up_label', { name: t(g.title) })} title={t('st.set.move_group_up')}
                      className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:opacity-25"><ArrowUp className="size-3.5" /></button>
                    <button type="button" disabled={pending || gi === visibleGroups.length - 1} onClick={() => moveGroup(g.title, 1)}
                      aria-label={t('st.set.move_down_label', { name: t(g.title) })} title={t('st.set.move_group_down')}
                      className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:opacity-25"><ArrowDown className="size-3.5" /></button>
                  </div>
                )}
                {st.total > 0 && (
                  <VisBtn hidden={st.allOff} disabled={pending}
                    onClick={() => onToggle(allHrefs.filter((h) => !NAV_ALWAYS_VISIBLE.includes(h)), st.allOff)} />
                )}
              </div>
              {isOpen && (
                <div className="space-y-0.5 px-3 pb-3">
                  {flat.map((it, i) => renderItem(it, g.title, flat, i, flat.length))}
                  {subs.map(({ sub, items }) => {
                    if (searching && items.length === 0) return null;
                    const subHrefs = sub.items.map((i) => i.href);
                    const subSt = hiddenStats(subHrefs, navDisabled);
                    return (
                      <div key={sub.title} className="mt-1 rounded-md border border-dashed border-border/70 p-1.5">
                        <div className="flex items-center gap-2 px-1 pb-1">
                          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-muted-foreground">{t(sub.title)}</span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">{subSt.off > 0 ? t('st.set.hidden_ratio', { off: subSt.off, total: subSt.total }) : t('st.set.menu_count', { count: subSt.total })}</span>
                          <VisBtn hidden={subSt.allOff} disabled={pending} size="xs"
                            onClick={() => onToggle(subHrefs.filter((h) => !NAV_ALWAYS_VISIBLE.includes(h)), subSt.allOff)} />
                        </div>
                        {items.map((it, i) => renderItem(it, sub.title, items, i, items.length))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {searching && visibleGroups.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">{t('st.set.no_menu_found', { q })}</div>
        )}
      </div>
    </Card>
  );
}

// ── Section B: System modules — permission feature-flags, grouped + named + cross-referenced ─────────
function SystemModules({
  mods, onToggle, pending, lang, t,
}: {
  mods: ModuleFlag[];
  onToggle: (keys: string[], enabled: boolean) => void;
  pending: boolean;
  lang: any;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  const byCat = useMemo(() => {
    const m = new Map<string, ModuleFlag[]>();
    for (const mod of mods) {
      const c = moduleCategoryKey(mod.key);
      (m.get(c) ?? m.set(c, []).get(c)!).push(mod);
    }
    return m;
  }, [mods]);

  return (
    <Card className="gap-0 p-0">
      <div className="flex items-center gap-2 border-b p-4">
        <ToggleLeft className="size-4 text-primary" />
        <div>
          <h3 className="text-base font-semibold">{t('st.set.system_modules_heading')}</h3>
          <p className="text-sm text-muted-foreground">{t('st.set.system_modules_desc')}</p>
        </div>
      </div>
      <div className="divide-y">
        {MODULE_CATEGORIES.map((cat) => {
          const rows = byCat.get(cat.key) ?? [];
          if (rows.length === 0) return null;
          const toggleable = rows.filter((r) => !r.always_on);
          const anyOn = toggleable.some((r) => r.enabled);
          const offCount = rows.filter((r) => !r.enabled).length;
          return (
            <div key={cat.key} className="p-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{categoryLabel(cat.key, lang)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{offCount > 0 ? t('st.set.disabled_ratio', { off: offCount, total: rows.length }) : t('st.set.module_count', { count: rows.length })}</span>
                {toggleable.length > 0 && (
                  <Button variant={anyOn ? 'destructive' : 'default'} size="sm" disabled={pending} className="h-7 px-2 text-xs"
                    onClick={() => onToggle(toggleable.map((r) => r.key), !anyOn)}>
                    <Power className="size-3.5" /> {anyOn ? t('st.set.disable_category') : t('st.set.enable_category')}
                  </Button>
                )}
              </div>
              <div className="space-y-0.5">
                {rows.map((r) => {
                  const menus = menusForPerm(r.key);
                  return (
                    <div key={r.key} className={cn('flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50', !r.enabled && 'opacity-60')}>
                      <div className="min-w-0 flex-1 basis-40">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{moduleLabel(r.key, lang)}</span>
                          <code className="shrink-0 text-[11px] text-muted-foreground">{r.key}</code>
                        </div>
                        {menus.length > 0 && (
                          <div className="mt-0.5 flex flex-wrap items-center gap-1">
                            <span className="text-[11px] text-muted-foreground">{t('st.set.controls_menus')}</span>
                            {menus.slice(0, 5).map((mn) => (
                              <span key={mn.href} className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{t(mn.label)}</span>
                            ))}
                            {menus.length > 5 && <span className="text-[10px] text-muted-foreground">+{menus.length - 5}</span>}
                          </div>
                        )}
                      </div>
                      <Badge variant={statusVariant(r.enabled ? 'Open' : 'Cancelled')} className="shrink-0">{r.enabled ? t('st.set.enabled_state') : t('st.set.disabled_state')}</Badge>
                      {r.always_on ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3.5" /> always-on</span>
                      ) : (
                        <Button variant={r.enabled ? 'destructive' : 'default'} size="sm" disabled={pending} className="h-7 shrink-0 px-2 text-xs"
                          onClick={() => onToggle([r.key], !r.enabled)}>
                          <Power className="size-3.5" /> {r.enabled ? t('st.set.off') : t('st.set.on')}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ───────────────────────── API Keys ─────────────────────────
// Public API (v1) scopes an integrator key can be granted. The aliases read/write/* are also
// accepted by the server; here we expose the granular per-resource read scopes plus 'read'.
const API_KEY_SCOPES: { key: string; label: string }[] = [
  { key: 'read', label: 'st.set.scope_read' },
  { key: 'catalog:read', label: 'st.set.scope_catalog' },
  { key: 'inventory:read', label: 'st.set.scope_inventory' },
  { key: 'orders:read', label: 'st.set.scope_orders' },
  { key: 'invoices:read', label: 'st.set.scope_invoices' },
];

function ApiKeys() {
  const qc = useQueryClient();
  const { t } = useLang();
  const list = useQuery<any>({ queryKey: ['api-keys'], queryFn: () => api('/api/platform/api-keys') });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [newKey, setNewKey] = useState('');

  const rows = Array.isArray(list.data) ? list.data : (list.data?.keys ?? list.data?.api_keys ?? []);
  const toggleScope = (k: string) => setScopes((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));

  const create = useMutation({
    mutationFn: () => api<{ key: string }>('/api/platform/api-keys', { method: 'POST', body: JSON.stringify({ name, scopes: scopes.length ? scopes : ['read'] }) }),
    onSuccess: (r) => { setNewKey(r.key); setName(''); setScopes(['read']); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api(`/api/platform/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <div>
          <h3 className="text-base font-semibold">{t('st.set.create_key_heading')}</h3>
          <p className="text-sm text-muted-foreground">
            {t('st.set.create_key_desc1')}<code>/api/v1</code>{t('st.set.create_key_desc2')}{' '}
            <a href="/api/v1/openapi.json" className="underline" target="_blank" rel="noreferrer">openapi.json</a>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-[180px] flex-1" placeholder={t('st.set.key_name_placeholder')} value={name} onChange={(e) => setName(e.target.value)} />
          <Button disabled={!name || create.isPending} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? t('st.set.creating') : t('st.set.create_key_btn')}
          </Button>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">{t('st.set.allowed_scopes')}</p>
          <div className="flex flex-wrap gap-1.5">
            {API_KEY_SCOPES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => toggleScope(s.key)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs transition-colors',
                  scopes.includes(s.key) ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent',
                )}
              >
                {t(s.label)}
              </button>
            ))}
          </div>
        </div>
        {newKey && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-warning-foreground dark:text-warning">
              <TriangleAlert className="size-4" /> {t('st.set.copy_now_once')}
            </div>
            <code className="mt-1.5 block break-all text-sm">{newKey}</code>
          </div>
        )}
      </Card>

      <StateView q={list}>
        <DataTable
          rows={rows}
          emptyState={{ icon: KeyRound, title: t('st.set.no_keys_title'), description: t('st.set.no_keys_desc') }}
          columns={[
            { key: 'name', label: t('st.set.col_name') },
            { key: 'prefix', label: 'Prefix', render: (r: any) => <code>{r.prefix}…</code> },
            { key: 'scopes', label: t('st.set.col_scopes'), render: (r: any) => (Array.isArray(r.scopes) ? r.scopes.join(', ') : String(r.scopes ?? '')) },
            { key: 'revoked', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.revoked ? 'Cancelled' : 'Open')}>{r.revoked ? 'Cancelled' : 'Open'}</Badge> },
            { key: 'act', label: '', render: (r: any) => !r.revoked && <Button variant="destructive" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(r.id)}>{t('st.set.revoke')}</Button> },
          ]}
        />
      </StateView>
    </div>
  );
}

// ───────────────────────── Identity (SSO / SCIM) ─────────────────────────
function Identity() {
  const qc = useQueryClient();
  const { t } = useLang();
  const cfg = useQuery<any>({ queryKey: ['identity-config'], queryFn: () => api('/api/platform/identity') });
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [redirect, setRedirect] = useState('');
  const [defaultRole, setDefaultRole] = useState('Customer');
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [scimToken, setScimToken] = useState('');
  const [seeded, setSeeded] = useState(false);

  // Seed the form once from the server config (secrets are never returned, so they stay blank).
  useEffect(() => {
    if (!cfg.data || seeded) return;
    setIssuer(cfg.data.oidc_issuer ?? '');
    setClientId(cfg.data.oidc_client_id ?? '');
    setRedirect(cfg.data.oidc_redirect_uri ?? '');
    setDefaultRole(cfg.data.default_role ?? 'Customer');
    setSsoEnabled(!!cfg.data.sso_enabled);
    setSeeded(true);
  }, [cfg.data, seeded]);

  const save = useMutation({
    mutationFn: () => api('/api/platform/identity', { method: 'PUT', body: JSON.stringify({
      sso_enabled: ssoEnabled, oidc_issuer: issuer, oidc_client_id: clientId,
      ...(secret ? { oidc_client_secret: secret } : {}), oidc_redirect_uri: redirect, default_role: defaultRole,
    }) }),
    onSuccess: () => { notifySuccess(t('st.set.idp_saved')); setSecret(''); qc.invalidateQueries({ queryKey: ['identity-config'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const rotate = useMutation({
    mutationFn: () => api<{ token: string }>('/api/platform/identity/scim-token', { method: 'POST' }),
    onSuccess: (r) => { setScimToken(r.token); qc.invalidateQueries({ queryKey: ['identity-config'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <div>
          <h3 className="text-base font-semibold">{t('st.set.sso_heading')}</h3>
          <p className="text-sm text-muted-foreground">{t('st.set.sso_desc')}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ssoEnabled} onChange={(e) => setSsoEnabled(e.target.checked)} />
          {t('st.set.enable_sso')}
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label>Issuer URL</Label><Input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://login.example.com" /></div>
          <div className="grid gap-1.5"><Label>Client ID</Label><Input value={clientId} onChange={(e) => setClientId(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label>Client Secret {cfg.data?.has_client_secret && <span className="text-xs text-muted-foreground">{t('st.set.secret_set_hint')}</span>}</Label><Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="••••••" /></div>
          <div className="grid gap-1.5"><Label>Redirect URI</Label><Input value={redirect} onChange={(e) => setRedirect(e.target.value)} placeholder="https://app.example/sso/callback" /></div>
          <div className="grid gap-1.5"><Label>{t('st.set.default_role_label')}</Label><Input value={defaultRole} onChange={(e) => setDefaultRole(e.target.value)} /></div>
        </div>
        <div><Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? t('st.set.saving') : t('fin.save')}</Button></div>
      </Card>

      <Card className="gap-3 p-5">
        <div>
          <h3 className="text-base font-semibold">{t('st.set.scim_heading')}</h3>
          <p className="text-sm text-muted-foreground">{t('st.set.scim_desc1')}<code>/scim/v2</code>{t('st.set.scim_desc2')}</p>
        </div>
        {cfg.data?.has_scim_token && !scimToken && <p className="text-sm text-muted-foreground">{t('st.set.current_token')}<code>{cfg.data.scim_token_prefix}…</code></p>}
        {scimToken && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-warning-foreground dark:text-warning">
              <TriangleAlert className="size-4" /> {t('st.set.copy_now_once')}
            </div>
            <code className="mt-1.5 block break-all text-sm">{scimToken}</code>
          </div>
        )}
        <div><Button variant="outline" disabled={rotate.isPending} onClick={() => rotate.mutate()}>{rotate.isPending ? t('st.set.creating') : (cfg.data?.has_scim_token ? t('st.set.rotate_token') : t('st.set.create_scim_token'))}</Button></div>
      </Card>
    </div>
  );
}

// ───────────────────────── MFA (TOTP) ─────────────────────────
function Mfa() {
  const { t } = useLang();
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [token, setToken] = useState('');

  const begin = useMutation({
    mutationFn: () => api<{ secret: string; otpauth_url: string }>('/api/platform/mfa/setup', { method: 'POST' }),
    onSuccess: (r) => { setSetup(r); },
    onError: (e: any) => notifyError(e.message),
  });
  const verify = useMutation({
    mutationFn: () => api('/api/platform/mfa/verify', { method: 'POST', body: JSON.stringify({ token }) }),
    onSuccess: () => notifySuccess(t('st.set.mfa_enabled')),
    onError: (e: any) => notifyError(t('st.set.invalid_code', { msg: e.message })),
  });

  return (
    <Card className="max-w-[480px] gap-4 p-5">
      <div>
        <h3 className="text-base font-semibold">{t('st.set.mfa_heading')}</h3>
        <p className="text-sm text-muted-foreground">{t('st.set.mfa_desc')}</p>
      </div>
      {!setup ? (
        <Button disabled={begin.isPending} onClick={() => begin.mutate()}>
          <ShieldCheck className="size-4" /> {begin.isPending ? t('st.set.starting') : t('st.set.start_mfa')}
        </Button>
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <span className="text-sm text-muted-foreground">{t('st.set.mfa_step1')}</span>
            <code className="block break-all rounded-md bg-muted p-2 text-sm">{setup.secret}</code>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mfa-token">{t('st.set.mfa_step2')}</Label>
            <Input id="mfa-token" inputMode="numeric" maxLength={6} placeholder="000000" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <Button disabled={token.length < 6 || verify.isPending} onClick={() => verify.mutate()}>
            {verify.isPending ? t('st.set.verifying') : t('st.set.verify_enable')}
          </Button>
        </div>
      )}
    </Card>
  );
}
