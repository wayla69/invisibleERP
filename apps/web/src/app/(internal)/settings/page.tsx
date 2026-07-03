'use client';

import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Eye, EyeOff, KeyRound, ListTree, Lock, Plus, Power, ShieldCheck, ToggleLeft, TriangleAlert } from 'lucide-react';
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
import { INTERNAL_NAV, allGroupItems, navForWorkspace, orderGroups, type NavGroup, type NavItem, type Workspace } from '@/lib/nav';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
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
  return (
    <div>
      <PageHeader title="ตั้งค่า" description="API Keys และความปลอดภัย" />
      <Tabs
        tabs={[
          { key: 'modules', label: 'โมดูล (เปิด/ปิด)', content: <Modules /> },
          { key: 'keys', label: 'API Keys', content: <ApiKeys /> },
          { key: 'identity', label: 'SSO / SCIM', content: <Identity /> },
          { key: 'mfa', label: 'ความปลอดภัย (MFA)', content: <Mfa /> },
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
type ModulesResp = { modules: ModuleFlag[]; navDisabled?: string[]; groupOrder?: string[] };
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
      notifySuccess(v.keys.length === 1 ? `${moduleLabel(v.keys[0], lang)} → ${v.enabled ? 'เปิด' : 'ปิด'}` : `${v.keys.length} โมดูล → ${v.enabled ? 'เปิด' : 'ปิด'}`);
      invalidate();
    },
    onError: (e: any) => notifyError(e.message),
  });

  const toggleNav = useMutation({
    mutationFn: (v: { hrefs: string[]; enabled: boolean }) => api('/api/admin/modules/nav', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: (_r, v) => {
      notifySuccess(v.hrefs.length === 1 ? `เมนู → ${v.enabled ? 'แสดง' : 'ซ่อน'}` : `${v.hrefs.length} เมนู → ${v.enabled ? 'แสดง' : 'ซ่อน'}`);
      invalidate();
    },
    onError: (e: any) => notifyError(e.message),
  });

  const reorder = useMutation({
    mutationFn: (order: string[]) => api('/api/admin/modules/nav-order', { method: 'POST', body: JSON.stringify({ order }) }),
    onSuccess: () => { notifySuccess('อัปเดตลำดับหมวดเมนูแล้ว'); invalidate(); },
    onError: (e: any) => notifyError(e.message),
  });

  const mods = list.data?.modules ?? [];
  const navDisabled = useMemo(() => new Set(list.data?.navDisabled ?? []), [list.data]);
  const groupOrder = list.data?.groupOrder;
  const disabledCount = mods.filter((m) => !m.enabled).length;

  return (
    <div className="space-y-4">
      <Card className="gap-2 p-5">
        <h3 className="text-base font-semibold">จัดการเมนู & โมดูล (ทั้งระบบ)</h3>
        <p className="text-sm text-muted-foreground">
          <b>ซ่อนเมนู</b> = เอาออกจากแถบเมนูของทุกคน (สิทธิ์ยังเหมือนเดิม) · <b>ปิดโมดูล</b> = ปิดความสามารถทั้งชุดและปิดกั้นที่ API ด้วย —
          โมดูล “ผู้ใช้ & สิทธิ์” และเมนูตั้งค่า/ผู้ใช้ ปิดไม่ได้เพื่อไม่ให้ผู้ดูแลถูกล็อกออก
        </p>
        <div className="flex flex-wrap gap-1.5">
          {navDisabled.size > 0 && <Badge variant={statusVariant('Cancelled')}>ซ่อน {navDisabled.size} เมนู</Badge>}
          {disabledCount > 0 && <Badge variant={statusVariant('Cancelled')}>ปิด {disabledCount} โมดูล</Badge>}
        </div>
      </Card>

      <StateView q={list}>
        <div className="space-y-6">
          <MenuVisibility navDisabled={navDisabled} onToggle={(hrefs, enabled) => toggleNav.mutate({ hrefs, enabled })}
            groupOrder={groupOrder} onReorder={(order) => reorder.mutate(order)} pending={toggleNav.isPending || reorder.isPending} t={t} />
          <SystemModules mods={mods} onToggle={(keys, enabled) => toggleModule.mutate({ keys, enabled })} pending={toggleModule.isPending} lang={lang} t={t} />
        </div>
      </StateView>
    </div>
  );
}

// ── shared bits ────────────────────────────────────────────────────────────────
function VisBtn({ hidden, onClick, disabled, size = 'sm' }: { hidden: boolean; onClick: () => void; disabled?: boolean; size?: 'sm' | 'xs' }) {
  return (
    <Button variant={hidden ? 'default' : 'outline'} size="sm" disabled={disabled} onClick={onClick}
      className={cn('shrink-0', size === 'xs' && 'h-7 px-2 text-xs')}>
      {hidden ? <><Eye className="size-3.5" /> แสดง</> : <><EyeOff className="size-3.5" /> ซ่อน</>}
    </Button>
  );
}

// Count how many of these hrefs are hidden (protected ones don't count — they can't be hidden).
function hiddenStats(hrefs: string[], hidden: Set<string>) {
  const toggleable = hrefs.filter((h) => !NAV_ALWAYS_VISIBLE.includes(h));
  const off = toggleable.filter((h) => hidden.has(h)).length;
  return { total: toggleable.length, off, allOff: toggleable.length > 0 && off === toggleable.length };
}

// ── Section A: Menu visibility — a collapsible tree mirroring the sidebar ─────────
function MenuVisibility({
  navDisabled, onToggle, groupOrder, onReorder, pending, t,
}: {
  navDisabled: Set<string>;
  onToggle: (hrefs: string[], enabled: boolean) => void;
  groupOrder?: string[];
  onReorder: (order: string[]) => void;
  pending: boolean;
  t: (k: string) => string;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // Mirror the sidebar's ERP/POS split so the tree lines up with what staff actually see. "All" merges both
  // surfaces (with a per-group workspace chip); ERP/POS use the SAME filter the sidebar uses (navForWorkspace).
  const [ws, setWs] = useState<'all' | Workspace>('all');
  const wsChip = (g: NavGroup) => (!g.workspace || g.workspace.length === 2 ? 'ทั้งสอง' : g.workspace[0] === 'pos' ? 'POS' : 'ERP');

  // Show categories in the admin-curated order (same as the sidebar). Reorder writes the FULL global order.
  const wsGroups = orderGroups(ws === 'all' ? INTERNAL_NAV : navForWorkspace(INTERNAL_NAV, ws), groupOrder);
  const moveGroup = (title: string, dir: -1 | 1) => {
    const visible = wsGroups.map((g) => g.title);
    const neighbour = visible[visible.indexOf(title) + dir]; // swap with the adjacent VISIBLE category
    if (!neighbour) return;
    const full = orderGroups(INTERNAL_NAV, groupOrder).map((g) => g.title);
    const ia = full.indexOf(title);
    const ib = full.indexOf(neighbour);
    if (ia < 0 || ib < 0) return;
    [full[ia], full[ib]] = [full[ib], full[ia]];
    onReorder(full);
  };

  const renderItem = (it: NavItem) => {
    const protectedItem = NAV_ALWAYS_VISIBLE.includes(it.href);
    const hidden = navDisabled.has(it.href);
    return (
      <div key={it.href} className={cn('flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/50', hidden && 'opacity-60')}>
        <it.icon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{t(it.label)}</div>
          <code className="text-[11px] text-muted-foreground">{it.href}</code>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {(it.perms ?? []).slice(0, 3).map((p) => (
            <code key={p} className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{p}</code>
          ))}
        </div>
        {protectedItem ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3.5" /> ล็อก</span>
        ) : (
          <VisBtn hidden={hidden} disabled={pending} size="xs" onClick={() => onToggle([it.href], hidden)} />
        )}
      </div>
    );
  };

  return (
    <Card className="gap-0 p-0">
      <div className="flex flex-wrap items-center gap-2 border-b p-4">
        <ListTree className="size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold">จัดการเมนู (แสดง/ซ่อน)</h3>
          <p className="text-sm text-muted-foreground">ซ่อนได้ทั้งหมวด หมวดย่อย หรือเมนูรายตัว · จัดลำดับหมวดด้วยปุ่ม ▲▼ (มีผลกับทุกคน) — แยกตาม ERP/POS ให้ตรงกับแถบเมนูซ้าย</p>
        </div>
        <div className="flex shrink-0 gap-0.5 rounded-md bg-muted p-0.5 text-xs">
          {([['all', 'ทั้งหมด'], ['erp', 'ERP'], ['pos', 'POS']] as const).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setWs(id)}
              className={cn('rounded px-2.5 py-1 font-medium transition-colors', ws === id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="divide-y">
        {wsGroups.map((g: NavGroup, gi: number) => {
          const allHrefs = allGroupItems(g).map((i) => i.href);
          const st = hiddenStats(allHrefs, navDisabled);
          const isOpen = open[g.title] ?? false;
          return (
            <div key={g.title}>
              <div className="flex items-center gap-2 px-3 py-2">
                <button type="button" onClick={() => setOpen((o) => ({ ...o, [g.title]: !isOpen }))}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                  {isOpen ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="truncate text-sm font-semibold">{t(g.title)}</span>
                  {ws === 'all' && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{wsChip(g)}</span>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {st.off > 0 ? `ซ่อน ${st.off}/${st.total}` : `${st.total} เมนู`}
                  </span>
                </button>
                <div className="flex shrink-0 items-center">
                  <button type="button" disabled={pending || gi === 0} onClick={() => moveGroup(g.title, -1)}
                    aria-label={`เลื่อน ${t(g.title)} ขึ้น`} title="เลื่อนหมวดขึ้น"
                    className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:opacity-25">
                    <ArrowUp className="size-3.5" />
                  </button>
                  <button type="button" disabled={pending || gi === wsGroups.length - 1} onClick={() => moveGroup(g.title, 1)}
                    aria-label={`เลื่อน ${t(g.title)} ลง`} title="เลื่อนหมวดลง"
                    className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:opacity-25">
                    <ArrowDown className="size-3.5" />
                  </button>
                </div>
                {st.total > 0 && (
                  <VisBtn hidden={st.allOff} disabled={pending}
                    onClick={() => onToggle(allHrefs.filter((h) => !NAV_ALWAYS_VISIBLE.includes(h)), st.allOff)} />
                )}
              </div>
              {isOpen && (
                <div className="space-y-0.5 px-3 pb-3">
                  {g.items?.map(renderItem)}
                  {g.subgroups?.map((sub) => {
                    const subHrefs = sub.items.map((i) => i.href);
                    const subSt = hiddenStats(subHrefs, navDisabled);
                    return (
                      <div key={sub.title} className="mt-1 rounded-md border border-dashed border-border/70 p-1.5">
                        <div className="flex items-center gap-2 px-1 pb-1">
                          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-muted-foreground">{t(sub.title)}</span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">{subSt.off > 0 ? `ซ่อน ${subSt.off}/${subSt.total}` : `${subSt.total} เมนู`}</span>
                          <VisBtn hidden={subSt.allOff} disabled={pending} size="xs"
                            onClick={() => onToggle(subHrefs.filter((h) => !NAV_ALWAYS_VISIBLE.includes(h)), subSt.allOff)} />
                        </div>
                        {sub.items.map(renderItem)}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
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
  t: (k: string) => string;
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
          <h3 className="text-base font-semibold">โมดูลระบบ (สิทธิ์การใช้งาน)</h3>
          <p className="text-sm text-muted-foreground">ปิดโมดูลจะปิดกั้นการเข้าถึงที่ API ด้วย — คอลัมน์ “คุมเมนู” แสดงว่าโมดูลนี้ควบคุมเมนูใดบ้าง</p>
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
                <span className="shrink-0 text-xs text-muted-foreground">{offCount > 0 ? `ปิด ${offCount}/${rows.length}` : `${rows.length} โมดูล`}</span>
                {toggleable.length > 0 && (
                  <Button variant={anyOn ? 'destructive' : 'default'} size="sm" disabled={pending} className="h-7 px-2 text-xs"
                    onClick={() => onToggle(toggleable.map((r) => r.key), !anyOn)}>
                    <Power className="size-3.5" /> {anyOn ? 'ปิดทั้งหมวด' : 'เปิดทั้งหมวด'}
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
                            <span className="text-[11px] text-muted-foreground">คุมเมนู:</span>
                            {menus.slice(0, 5).map((mn) => (
                              <span key={mn.href} className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{t(mn.label)}</span>
                            ))}
                            {menus.length > 5 && <span className="text-[10px] text-muted-foreground">+{menus.length - 5}</span>}
                          </div>
                        )}
                      </div>
                      <Badge variant={statusVariant(r.enabled ? 'Open' : 'Cancelled')} className="shrink-0">{r.enabled ? 'เปิดอยู่' : 'ปิดอยู่'}</Badge>
                      {r.always_on ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3.5" /> always-on</span>
                      ) : (
                        <Button variant={r.enabled ? 'destructive' : 'default'} size="sm" disabled={pending} className="h-7 shrink-0 px-2 text-xs"
                          onClick={() => onToggle([r.key], !r.enabled)}>
                          <Power className="size-3.5" /> {r.enabled ? 'ปิด' : 'เปิด'}
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
  { key: 'read', label: 'อ่านทั้งหมด (read)' },
  { key: 'catalog:read', label: 'แค็ตตาล็อกสินค้า (catalog:read)' },
  { key: 'inventory:read', label: 'สต๊อก (inventory:read)' },
  { key: 'orders:read', label: 'ออเดอร์ (orders:read)' },
  { key: 'invoices:read', label: 'ใบแจ้งหนี้ (invoices:read)' },
];

function ApiKeys() {
  const qc = useQueryClient();
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
          <h3 className="text-base font-semibold">สร้าง API Key ใหม่</h3>
          <p className="text-sm text-muted-foreground">
            สำหรับเชื่อมต่อระบบภายนอกกับ Public API (<code>/api/v1</code>) ของคุณ · เอกสาร:{' '}
            <a href="/api/v1/openapi.json" className="underline" target="_blank" rel="noreferrer">openapi.json</a>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-[180px] flex-1" placeholder="ชื่อ key (เช่น Zapier)" value={name} onChange={(e) => setName(e.target.value)} />
          <Button disabled={!name || create.isPending} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? 'กำลังสร้าง…' : 'สร้าง Key'}
          </Button>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">สิทธิ์ (scopes) ที่อนุญาต</p>
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
                {s.label}
              </button>
            ))}
          </div>
        </div>
        {newKey && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-warning-foreground dark:text-warning">
              <TriangleAlert className="size-4" /> คัดลอกเก็บไว้ตอนนี้ — จะแสดงเพียงครั้งเดียว
            </div>
            <code className="mt-1.5 block break-all text-sm">{newKey}</code>
          </div>
        )}
      </Card>

      <StateView q={list}>
        <DataTable
          rows={rows}
          emptyState={{ icon: KeyRound, title: 'ยังไม่มี API Key', description: 'สร้าง API Key ด้านบนเพื่อเชื่อมต่อระบบภายนอกกับ Public API' }}
          columns={[
            { key: 'name', label: 'ชื่อ' },
            { key: 'prefix', label: 'Prefix', render: (r: any) => <code>{r.prefix}…</code> },
            { key: 'scopes', label: 'สิทธิ์', render: (r: any) => (Array.isArray(r.scopes) ? r.scopes.join(', ') : String(r.scopes ?? '')) },
            { key: 'revoked', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.revoked ? 'Cancelled' : 'Open')}>{r.revoked ? 'Cancelled' : 'Open'}</Badge> },
            { key: 'act', label: '', render: (r: any) => !r.revoked && <Button variant="destructive" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(r.id)}>เพิกถอน</Button> },
          ]}
        />
      </StateView>
    </div>
  );
}

// ───────────────────────── Identity (SSO / SCIM) ─────────────────────────
function Identity() {
  const qc = useQueryClient();
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
    onSuccess: () => { notifySuccess('บันทึกการตั้งค่า IdP แล้ว'); setSecret(''); qc.invalidateQueries({ queryKey: ['identity-config'] }); },
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
          <h3 className="text-base font-semibold">เข้าสู่ระบบด้วย SSO (OIDC)</h3>
          <p className="text-sm text-muted-foreground">เชื่อมต่อ Identity Provider ขององค์กร (Azure AD, Okta, Google) ให้พนักงานล็อกอินด้วยบัญชีองค์กร</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ssoEnabled} onChange={(e) => setSsoEnabled(e.target.checked)} />
          เปิดใช้งาน SSO
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label>Issuer URL</Label><Input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://login.example.com" /></div>
          <div className="grid gap-1.5"><Label>Client ID</Label><Input value={clientId} onChange={(e) => setClientId(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label>Client Secret {cfg.data?.has_client_secret && <span className="text-xs text-muted-foreground">(ตั้งไว้แล้ว — เว้นว่างเพื่อคงเดิม)</span>}</Label><Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="••••••" /></div>
          <div className="grid gap-1.5"><Label>Redirect URI</Label><Input value={redirect} onChange={(e) => setRedirect(e.target.value)} placeholder="https://app.example/sso/callback" /></div>
          <div className="grid gap-1.5"><Label>บทบาทเริ่มต้นของผู้ใช้ใหม่</Label><Input value={defaultRole} onChange={(e) => setDefaultRole(e.target.value)} /></div>
        </div>
        <div><Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'กำลังบันทึก…' : 'บันทึก'}</Button></div>
      </Card>

      <Card className="gap-3 p-5">
        <div>
          <h3 className="text-base font-semibold">SCIM 2.0 — จัดการผู้ใช้อัตโนมัติ</h3>
          <p className="text-sm text-muted-foreground">ให้ IdP เพิ่ม/ปิดผู้ใช้อัตโนมัติผ่าน SCIM endpoint <code>/scim/v2</code> ด้วย bearer token นี้</p>
        </div>
        {cfg.data?.has_scim_token && !scimToken && <p className="text-sm text-muted-foreground">โทเค็นปัจจุบัน: <code>{cfg.data.scim_token_prefix}…</code></p>}
        {scimToken && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-warning-foreground dark:text-warning">
              <TriangleAlert className="size-4" /> คัดลอกเก็บไว้ตอนนี้ — จะแสดงเพียงครั้งเดียว
            </div>
            <code className="mt-1.5 block break-all text-sm">{scimToken}</code>
          </div>
        )}
        <div><Button variant="outline" disabled={rotate.isPending} onClick={() => rotate.mutate()}>{rotate.isPending ? 'กำลังสร้าง…' : (cfg.data?.has_scim_token ? 'สร้างโทเค็นใหม่ (เพิกถอนของเดิม)' : 'สร้าง SCIM token')}</Button></div>
      </Card>
    </div>
  );
}

// ───────────────────────── MFA (TOTP) ─────────────────────────
function Mfa() {
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [token, setToken] = useState('');

  const begin = useMutation({
    mutationFn: () => api<{ secret: string; otpauth_url: string }>('/api/platform/mfa/setup', { method: 'POST' }),
    onSuccess: (r) => { setSetup(r); },
    onError: (e: any) => notifyError(e.message),
  });
  const verify = useMutation({
    mutationFn: () => api('/api/platform/mfa/verify', { method: 'POST', body: JSON.stringify({ token }) }),
    onSuccess: () => notifySuccess('เปิดใช้งาน MFA สำเร็จ — ครั้งต่อไปต้องใส่รหัส 6 หลัก'),
    onError: (e: any) => notifyError(`รหัสไม่ถูกต้อง (${e.message})`),
  });

  return (
    <Card className="max-w-[480px] gap-4 p-5">
      <div>
        <h3 className="text-base font-semibold">ยืนยันตัวตนสองชั้น (Two-Factor / TOTP)</h3>
        <p className="text-sm text-muted-foreground">เพิ่มความปลอดภัยด้วยแอป Google Authenticator / Authy</p>
      </div>
      {!setup ? (
        <Button disabled={begin.isPending} onClick={() => begin.mutate()}>
          <ShieldCheck className="size-4" /> {begin.isPending ? 'กำลังเริ่ม…' : 'เริ่มตั้งค่า MFA'}
        </Button>
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <span className="text-sm text-muted-foreground">1) เพิ่มลงในแอป Authenticator ด้วยรหัสลับนี้:</span>
            <code className="block break-all rounded-md bg-muted p-2 text-sm">{setup.secret}</code>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mfa-token">2) ใส่รหัส 6 หลักจากแอปเพื่อยืนยัน</Label>
            <Input id="mfa-token" inputMode="numeric" maxLength={6} placeholder="000000" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <Button disabled={token.length < 6 || verify.isPending} onClick={() => verify.mutate()}>
            {verify.isPending ? 'กำลังยืนยัน…' : 'ยืนยันเปิดใช้งาน'}
          </Button>
        </div>
      )}
    </Card>
  );
}
