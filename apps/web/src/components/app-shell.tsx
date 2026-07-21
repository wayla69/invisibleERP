'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { BadgeCheck, Building2, Check, ChevronDown, ChevronRight, ChevronsUpDown, ChevronUp, Globe, LogOut, Search, ShieldCheck, SlidersHorizontal, Star } from 'lucide-react';

import { useQuery } from '@tanstack/react-query';

import { api, hasSession, logout as apiLogout, getActingTenant, setActingTenant, type ActingTenant } from '@/lib/api';
import { useMe, hasPerm } from '@/lib/auth';
import { useModuleFlags } from '@/lib/modules';
import {
  INTERNAL_NAV,
  PORTAL_NAV,
  allGroupItems,
  filterAdvancedNav,
  navForWorkspace,
  orderGroups,
  orderItems,
  defaultWorkspace,
  workspaceHome,
  WORKSPACES,
  type NavGroup,
  type NavItem,
  type Workspace,
} from '@/lib/nav';
import { useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ThemeToggle } from '@/components/theme-toggle';
import { LanguageToggle } from '@/components/language-toggle';
import { CommandPalette } from '@/components/command-palette';
import { SmeReasonDialog } from '@/components/sme-reason-dialog';
import { PlanUpsellDialog } from '@/components/plan-upsell-dialog';
import { SmeSetupWizard } from '@/components/sme-setup-wizard';
import { AssistantWidget } from '@/components/assistant-widget';
import { NotificationBell } from '@/components/notification-bell';

function initials(name?: string | null) {
  if (!name) return '?';
  return name.slice(0, 2).toUpperCase();
}

const WORKSPACE_KEY = 'ie-workspace';
const FAVORITES_KEY = 'ie-nav-favorites'; // pinned hrefs (manual) — localStorage cache of the synced value
const FOLD_KEY = 'ie-nav-fold'; // nav sub-section fold map {title: open} — localStorage cache of synced value
const FOLD_KEY_PREFIX = 'ie-nav-sub:'; // legacy per-title fold keys (pre-sync), migrated into FOLD_KEY
const RECENTS_KEY = 'ie-nav-recents'; // recently visited hrefs (auto, most-recent-first) — per-device only
const RECENTS_SHOWN = 5; // how many recent items to surface
const RECENTS_STORED = 12; // how many to retain so favourites filtering doesn't starve the list
const PREFS_PUSH_MS = 600; // debounce for syncing pref changes to the server
// Reserved fold-map key holding the "show advanced menus" toggle. Stored inside `navFold` (a free-form
// {key: boolean} synced via /api/user-prefs) so it syncs across devices with no backend change; it can't
// collide with a real group/subgroup title (those are all `nav.group.*` / `nav.sub.*`). Excluded from the
// group render because no NavGroup carries this title.
const ADVANCED_FOLD_KEY = '__show_advanced__';
// B2 (docs/50): reserved fold-map key for the SME "show hidden menus" escape hatch — reveals the
// industry-hidden nav domains (B1) without needing the platform owner. Same synced-navFold mechanics.
const SME_HIDDEN_FOLD_KEY = '__show_sme_hidden__';

type SyncedPrefs = { favorites: string[]; navFold: Record<string, boolean> };

const readJson = <T,>(key: string, fallback: T): T => {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    return v == null ? fallback : (v as T);
  } catch {
    return fallback;
  }
};

/** A labelled, collapsible sub-section inside a sidebar group (dependency-free). Controlled: open state and
 *  persistence live in AppShell (so they can be device-synced). In icon-collapsed mode the header is hidden
 *  and items stay visible (icons only). */
function NavSubSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-sidebar-foreground/60 transition-colors hover:text-sidebar-foreground group-data-[collapsible=icon]:hidden"
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="truncate">{title}</span>
      </button>
      <div className={cn(open ? 'block' : 'hidden', 'group-data-[collapsible=icon]:block')}>{children}</div>
    </div>
  );
}

/** A collapsible TOP-LEVEL sidebar domain. The label becomes a fold toggle (chevron + title, with an
 *  item-count badge when collapsed). Default-open is driven by the caller (only the domain containing the
 *  active route opens on load); an explicit user toggle persists and overrides. In icon-collapsed (rail)
 *  mode the header hides and items stay visible (icons only), matching NavSubSection. */
function NavGroupSection({
  title,
  count,
  open,
  active,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  active: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <SidebarGroup>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors hover:text-sidebar-foreground group-data-[collapsible=icon]:hidden',
          active ? 'text-sidebar-foreground' : 'text-sidebar-foreground/60',
        )}
      >
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="flex-1 truncate text-left">{title}</span>
        {!open && count > 0 && (
          <span
            aria-hidden="true"
            className="rounded-full bg-sidebar-accent px-1.5 text-[10px] font-medium tabular-nums text-sidebar-foreground/70"
          >
            {count}
          </span>
        )}
      </button>
      <SidebarGroupContent className={cn(open ? 'block' : 'hidden', 'group-data-[collapsible=icon]:block')}>
        {children}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

// God-only nav group (Platform Console). Appended AFTER the permission filter so it is gated solely on
// is_platform_owner — a per-tenant Admin (who also passes every perm) never sees it.
const PLATFORM_GROUP: NavGroup = {
  title: 'nav.group.platform',
  items: [{ label: 'nav.platform', href: '/platform', icon: ShieldCheck, perms: [] }],
};

/**
 * Persistent scope banner under the header — god only. In the combined view it warns that every figure sums
 * ALL companies (so a dashboard number isn't misread as one company's); while acting-as it names the company
 * in scope and offers a one-click return to the combined view. Complements the sidebar switcher/badge.
 */
function GodScopeBanner() {
  const { t } = useLang();
  const [acting, setActing] = React.useState<ActingTenant | null>(null);
  React.useEffect(() => setActing(getActingTenant()), []);
  const exit = () => { setActingTenant(null); window.location.reload(); };
  const toggleReadOnly = () => { if (acting) { setActingTenant({ ...acting, readOnly: !acting.readOnly }); window.location.reload(); } };
  if (acting) {
    return (
      <div className={cn('flex items-center gap-2 border-b px-4 py-1.5 text-xs', acting.readOnly ? 'border-amber-500/40 bg-amber-500/10' : 'border-primary/30 bg-primary/10')}>
        <Building2 className={cn('size-3.5 shrink-0', acting.readOnly ? 'text-amber-600 dark:text-amber-400' : 'text-primary')} />
        <span className="flex-1 truncate">
          {t('plt.scope_acting_as')} <b>{acting.name}</b>{acting.code ? ` (${acting.code})` : ''} — {acting.readOnly ? <b>{t('plt.scope_read_only')}</b> : t('plt.scope_admin_view')}
        </span>
        <button type="button" onClick={toggleReadOnly} className="shrink-0 rounded px-2 py-0.5 font-medium hover:bg-black/5 dark:hover:bg-white/10" title={t('plt.scope_toggle_title')}>
          {acting.readOnly ? t('plt.scope_enable_edit') : t('plt.scope_read_only_btn')}
        </button>
        <button type="button" onClick={exit} className="shrink-0 rounded px-2 py-0.5 font-medium text-primary hover:bg-primary/15">{t('plt.scope_exit_to_combined')}</button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 border-b border-dashed border-amber-500/40 bg-amber-500/5 px-4 py-1 text-[11px] text-muted-foreground">
      <Globe className="size-3.5 shrink-0" />
      <span>{t('plt.scope_combined_mode_pre')} <b>{t('plt.scope_all_companies')}</b> {t('plt.scope_combined_mode_post')}</span>
    </div>
  );
}

/**
 * Persistent SME-mode banner (docs/49) — shown to EVERY user of a control_profile='sme' tenant so nobody
 * mistakes the relaxed single-operator control environment for the full enterprise maker-checker one.
 * Names the compensating control: self-approvals require a logged reason and are independently reviewed.
 */
function SmeModeBanner() {
  const { t } = useLang();
  return (
    <div className="flex items-center gap-2 border-b border-sky-500/40 bg-sky-500/10 px-4 py-1 text-[11px]">
      <BadgeCheck className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
      <span className="truncate"><b>{t('sme.mode_badge')}</b> — {t('sme.mode_banner_desc')}</span>
    </div>
  );
}

interface SwitcherCompany { id: number; code: string; name: string; suspended: boolean }

/**
 * Cross-company switcher for the platform owner ("god"). A god otherwise sees every company's data combined
 * with no way to tell which company a row belongs to. Picking a company here stores it (api.setActingTenant)
 * so every request carries `X-Act-As-Tenant` and the server narrows the god's RLS scope to that one company;
 * "ทุกบริษัท" clears it and restores the global view. The trigger doubles as the current-company badge.
 * Rendered ONLY for a god (`me.is_platform_owner`). Kept inside this already-'use client' shell (rather than
 * its own file) so it stays a client island without adding to the 'use client' ratchet.
 */
const RECENT_COMPANIES_KEY = 'ie-god-recent-companies'; // most-recent-first, capped
function readRecentCompanies(): ActingTenant[] {
  return readJson<ActingTenant[]>(RECENT_COMPANIES_KEY, []).filter((c) => c && typeof c.id === 'number').slice(0, 5);
}
function pushRecentCompany(c: ActingTenant) {
  if (typeof window === 'undefined') return;
  const next = [c, ...readRecentCompanies().filter((r) => r.id !== c.id)].slice(0, 5);
  localStorage.setItem(RECENT_COMPANIES_KEY, JSON.stringify(next));
}

function CompanySwitcher() {
  const { t } = useLang();
  const { data: companies } = useQuery<SwitcherCompany[]>({
    queryKey: ['admin-tenants'],
    queryFn: () => api<SwitcherCompany[]>('/api/admin/tenants'),
    staleTime: 5 * 60_000,
  });
  const [acting, setActing] = React.useState<ActingTenant | null>(null);
  const [recents, setRecents] = React.useState<ActingTenant[]>([]);
  const [query, setQuery] = React.useState('');
  React.useEffect(() => { setActing(getActingTenant()); setRecents(readRecentCompanies()); }, []);

  const pick = (tnt: ActingTenant | null) => {
    if (tnt) pushRecentCompany(tnt);
    setActingTenant(tnt);
    // Reload so every cached query refetches under the new scope (see setActingTenant).
    window.location.reload();
  };

  const currentName = acting?.name ?? t('plt.sw_all_companies');
  const isGlobal = acting == null;
  const q = query.trim().toLowerCase();
  const list = (companies ?? []).filter((c) => !q || `${c.name} ${c.code}`.toLowerCase().includes(q));
  // Recents only when not searching, and only companies still in the directory (name may have changed).
  const recentItems = q ? [] : recents
    .map((r) => (companies ?? []).find((c) => c.id === r.id))
    .filter((c): c is SwitcherCompany => !!c && c.id !== acting?.id)
    .slice(0, 4);

  const row = (c: SwitcherCompany) => (
    <DropdownMenuItem key={c.id} onSelect={(e) => { e.preventDefault(); pick({ id: c.id, name: c.name, code: c.code }); }} className="gap-2">
      <Building2 className="size-4" />
      <span className="grid flex-1 leading-tight">
        <span className={cn('truncate', c.suspended && 'text-muted-foreground line-through')}>{c.name}</span>
        <span className="truncate text-[10px] text-muted-foreground">{c.code}{c.suspended ? t('plt.sw_suspended') : ''}</span>
      </span>
      {acting?.id === c.id && <Check className="size-4 text-primary" />}
    </DropdownMenuItem>
  );

  return (
    <div className="px-1 pb-1 group-data-[collapsible=icon]:hidden">
      <DropdownMenu onOpenChange={(o) => !o && setQuery('')}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted',
              isGlobal ? 'border-dashed text-muted-foreground' : 'border-primary/40 bg-primary/5 text-foreground',
            )}
            aria-label={t('plt.sw_aria_label')}
          >
            {isGlobal ? <Globe className="size-3.5 shrink-0" /> : <Building2 className="size-3.5 shrink-0 text-primary" />}
            <span className="grid flex-1 leading-tight">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('plt.sw_viewing_data_for')}</span>
              <span className="truncate font-medium">{currentName}</span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[70vh] w-64 overflow-y-auto">
          <DropdownMenuLabel className="text-xs">{t('plt.sw_menu_label')}</DropdownMenuLabel>
          {/* Search — stop keydown propagation so the menu's typeahead doesn't steal keystrokes. */}
          <div className="px-1 py-1">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={t('plt.sw_search_ph')}
              className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); pick(null); }} className="gap-2">
            <Globe className="size-4" />
            <span className="flex-1">{t('plt.sw_all_combined')}</span>
            {isGlobal && <Check className="size-4 text-primary" />}
          </DropdownMenuItem>
          {recentItems.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('plt.sw_recent')}</DropdownMenuLabel>
              {recentItems.map(row)}
            </>
          )}
          <DropdownMenuSeparator />
          {q && <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('plt.sw_search_results', { n: list.length })}</DropdownMenuLabel>}
          {list.length === 0 ? <div className="px-3 py-2 text-xs text-muted-foreground">{t('plt.sw_no_company_found')}</div> : list.map(row)}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function AppShell({
  variant,
  brand,
  filterPerms = false,
  enableWorkspaces = false,
  children,
}: {
  /** Which nav tree to render. Selected here (not passed as a prop) so the nav — whose items carry
   *  non-serializable Lucide icon component refs — never crosses the RSC boundary; the layout can then
   *  stay a server component and pass only serializable props. */
  variant: 'internal' | 'portal';
  /** Brand heading — a literal string, or a message-catalog key (resolved via t(); unknown keys pass through). */
  brand: string;
  filterPerms?: boolean;
  /** Show the ERP/POS workspace switcher and filter the sidebar to the active workspace. */
  enableWorkspaces?: boolean;
  children: React.ReactNode;
}) {
  const nav: NavGroup[] = variant === 'internal' ? INTERNAL_NAV : PORTAL_NAV;
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();
  const moduleFlags = useModuleFlags();
  const { t } = useLang();
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  // Favourites (★ pins) + nav fold-state are synced across devices via /api/user-prefs; auto-tracked
  // recents stay per-device. All only on the permission-gated internal surface (not the customer portal).
  // localStorage is an instant cache + offline fallback; the server is the source of truth once it loads.
  const pinsEnabled = filterPerms;
  const [favorites, setFavorites] = React.useState<string[]>([]);
  const [navFold, setNavFold] = React.useState<Record<string, boolean>>({});
  const [recents, setRecents] = React.useState<string[]>([]);

  // Hydrate from the localStorage cache after mount (avoids an SSR/CSR hydration mismatch), migrating any
  // legacy per-title fold keys into the single fold map.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const favs = readJson<string[]>(FAVORITES_KEY, []).filter((x) => typeof x === 'string');
    const fold = { ...readJson<Record<string, boolean>>(FOLD_KEY, {}) };
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(FOLD_KEY_PREFIX)) {
        const title = k.slice(FOLD_KEY_PREFIX.length);
        if (!(title in fold)) fold[title] = localStorage.getItem(k) === '1';
      }
    }
    setFavorites(favs);
    setNavFold(fold);
    setRecents(readJson<string[]>(RECENTS_KEY, []).filter((x) => typeof x === 'string'));
  }, []);
  const favSet = React.useMemo(() => new Set(favorites), [favorites]);

  // Debounced push of pref changes to the server (favourites + fold-state), coalescing rapid toggles.
  const pushTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPush = React.useRef<Partial<SyncedPrefs>>({});
  const schedulePush = React.useCallback(
    (patch: Partial<SyncedPrefs>) => {
      if (!pinsEnabled || !hasSession()) return;
      pendingPush.current = {
        ...pendingPush.current,
        ...patch,
        ...(patch.navFold ? { navFold: { ...pendingPush.current.navFold, ...patch.navFold } } : {}),
      };
      if (pushTimer.current) clearTimeout(pushTimer.current);
      pushTimer.current = setTimeout(() => {
        const body = pendingPush.current;
        pendingPush.current = {};
        void api('/api/user-prefs', { method: 'PUT', body: JSON.stringify(body) }).catch(() => {});
      }, PREFS_PUSH_MS);
    },
    [pinsEnabled],
  );

  const toggleFavorite = React.useCallback(
    (href: string) => {
      setFavorites((prev) => {
        const next = prev.includes(href) ? prev.filter((h) => h !== href) : [href, ...prev];
        if (typeof window !== 'undefined') localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
        schedulePush({ favorites: next });
        return next;
      });
    },
    [schedulePush],
  );
  // Swap two favourites' positions (used by the move up/down controls). Reorders relative to each other so
  // it stays intuitive even when some pinned hrefs are hidden in the current workspace.
  const swapFavorites = React.useCallback(
    (hrefA: string, hrefB: string) => {
      setFavorites((prev) => {
        const ia = prev.indexOf(hrefA);
        const ib = prev.indexOf(hrefB);
        if (ia < 0 || ib < 0) return prev;
        const next = prev.slice();
        [next[ia], next[ib]] = [next[ib], next[ia]];
        if (typeof window !== 'undefined') localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
        schedulePush({ favorites: next });
        return next;
      });
    },
    [schedulePush],
  );
  const toggleFold = React.useCallback(
    (title: string, defaultOpen: boolean) => {
      setNavFold((prev) => {
        const open = !(prev[title] ?? defaultOpen);
        const next = { ...prev, [title]: open };
        if (typeof window !== 'undefined') localStorage.setItem(FOLD_KEY, JSON.stringify(next));
        schedulePush({ navFold: { [title]: open } });
        return next;
      });
    },
    [schedulePush],
  );

  // Server sync: load the user's saved prefs, then reconcile once. If the server has a saved row, adopt it
  // as the source of truth (and refresh the local cache). If not, migrate the existing local prefs up.
  const prefsQuery = useQuery<SyncedPrefs & { saved: boolean }>({
    queryKey: ['user-prefs'],
    queryFn: () => api('/api/user-prefs'),
    enabled: pinsEnabled && typeof window !== 'undefined' && !!hasSession() && !!me.data,
    staleTime: 5 * 60_000,
  });
  const reconciled = React.useRef(false);
  React.useEffect(() => {
    if (reconciled.current || !prefsQuery.data) return;
    reconciled.current = true;
    const server = prefsQuery.data;
    if (server.saved) {
      const favs = Array.isArray(server.favorites) ? server.favorites : [];
      const fold = server.navFold && typeof server.navFold === 'object' ? server.navFold : {};
      setFavorites(favs);
      setNavFold((local) => ({ ...local, ...fold }));
      if (typeof window !== 'undefined') {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
        localStorage.setItem(FOLD_KEY, JSON.stringify(fold));
      }
    } else if (favorites.length || Object.keys(navFold).length) {
      schedulePush({ favorites, navFold }); // first-time migration of this device's local prefs
    }
  }, [prefsQuery.data, favorites, navFold, schedulePush]);

  // Active top-level workspace (ERP | POS). Seed from the saved preference; otherwise default by role
  // once the user profile loads. A manual choice is persisted and wins thereafter.
  const [workspace, setWorkspace] = React.useState<Workspace>(() => {
    if (typeof window === 'undefined') return 'erp';
    return (localStorage.getItem(WORKSPACE_KEY) as Workspace) || 'erp';
  });
  const wsResolved = React.useRef(false);
  React.useEffect(() => {
    if (!enableWorkspaces || wsResolved.current || !me.data) return;
    wsResolved.current = true;
    if (localStorage.getItem(WORKSPACE_KEY)) return; // a saved preference wins
    const def = defaultWorkspace(me.data.permissions, me.data.role);
    setWorkspace(def);
    // First-time landing only: if we're sitting on the OTHER workspace's home (e.g. login → /dashboard
    // for a POS-only operator), send them to their workspace's home. Deep links elsewhere are untouched.
    const otherHome = workspaceHome(def === 'erp' ? 'pos' : 'erp');
    if (pathname === otherHome) router.replace(workspaceHome(def));
  }, [enableWorkspaces, me.data, pathname, router]);
  const selectWorkspace = (w: Workspace) => {
    setWorkspace(w);
    if (typeof window !== 'undefined') localStorage.setItem(WORKSPACE_KEY, w);
    router.push(workspaceHome(w));
  };

  React.useEffect(() => {
    if (typeof window !== 'undefined' && !hasSession()) router.replace('/login');
  }, [router]);

  // A5 — force a default/weak password change before any back-office use
  React.useEffect(() => {
    if (me.data?.must_change_password) router.replace('/change-password');
  }, [me.data?.must_change_password, router]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Record the current destination into recents (most-recent-first, deduped, capped). Matches the active
  // nav item across the full nav so it works regardless of the active workspace.
  React.useEffect(() => {
    if (!pinsEnabled) return;
    const all = nav.flatMap((g) => allGroupItems(g));
    const match =
      all.find((it) => it.href === pathname) ??
      all.find(
        (it) => it.href !== '/dashboard' && it.href !== '/portal/dashboard' && pathname.startsWith(it.href + '/'),
      );
    if (!match) return;
    setRecents((prev) => {
      if (prev[0] === match.href) return prev;
      const next = [match.href, ...prev.filter((h) => h !== match.href)].slice(0, RECENTS_STORED);
      if (typeof window !== 'undefined') localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      return next;
    });
  }, [pathname, nav, pinsEnabled]);

  // Filter groups/items by permission AND module enable/disable (back-office); drop empty groups.
  // A disabled module hides for EVERYONE (incl. Admin) — faithful to the legacy "hides for all".
  const disabledModules = React.useMemo(() => new Set(moduleFlags.data?.disabled ?? []), [moduleFlags.data]);
  // Individually hidden menu entries (admin "menu visibility" overrides) — chrome only, not a permission.
  const hiddenNav = React.useMemo(() => new Set(moduleFlags.data?.navDisabled ?? []), [moduleFlags.data]);
  const filterByPerm = React.useCallback(
    (groupsIn: NavGroup[]) => {
      if (!filterPerms) return groupsIn;
      const visible = (it: NavItem) => {
        if (hiddenNav.has(it.href)) return false; // admin-hidden menu entry
        if (!hasPerm(me.data, ...(it.perms ?? []))) return false;
        const perms = it.perms ?? [];
        if (perms.length && perms.every((p) => disabledModules.has(p))) return false; // all its modules off
        return true;
      };
      return groupsIn
        .map((g) => ({
          ...g,
          items: (g.items ?? []).filter(visible),
          subgroups: (g.subgroups ?? [])
            .map((s) => ({ ...s, items: s.items.filter(visible) }))
            .filter((s) => s.items.length > 0),
        }))
        .filter((g) => (g.items?.length ?? 0) + (g.subgroups?.reduce((n, s) => n + s.items.length, 0) ?? 0) > 0);
    },
    [filterPerms, me.data, disabledModules, hiddenNav],
  );

  // If the current page is an admin-hidden menu entry, bounce to the workspace home (menu visibility is
  // enforced client-side; it's chrome, not a security boundary — permissions/modules remain the real guard).
  // Never redirect off the home route itself, to avoid a loop if someone hides their own landing page.
  React.useEffect(() => {
    if (!filterPerms || !moduleFlags.data || hiddenNav.size === 0) return;
    const home = workspaceHome(enableWorkspaces ? workspace : 'erp');
    const hit = nav
      .flatMap((g) => allGroupItems(g))
      .find((it) => hiddenNav.has(it.href) && it.href !== home && (pathname === it.href || pathname.startsWith(it.href + '/')));
    if (hit) router.replace(home);
  }, [filterPerms, moduleFlags.data, hiddenNav, pathname, nav, router, enableWorkspaces, workspace]);

  // Sidebar = permission-filtered within the active workspace; ⌘K palette stays global (all workspaces).
  const wsNav = React.useMemo(() => (enableWorkspaces ? navForWorkspace(nav, workspace) : nav), [enableWorkspaces, nav, workspace]);
  const groupOrder = moduleFlags.data?.groupOrder;
  const itemOrder = moduleFlags.data?.itemOrder;
  const isGod = me.data?.is_platform_owner ?? false;
  // SME edition (docs/49): hide the group title-keys the tenant was stamped with at provisioning.
  const smeHidden = React.useMemo(() => new Set(me.data?.control_profile === 'sme' ? me.data.sme_hidden_nav_groups ?? [] : []), [me.data]);
  // B1 (docs/50): industry-derived default-OPEN group/subgroup keys stamped at provisioning. When present,
  // listed keys start open and every other subgroup starts folded; a user's own navFold toggle always wins,
  // and the domain/subgroup holding the active route still opens. Empty set = enterprise behaviour.
  const smeOpen = React.useMemo(() => new Set(me.data?.control_profile === 'sme' ? me.data.sme_open_nav_groups ?? [] : []), [me.data]);
  // B2 (docs/50): the industry fold is a default, not a cage — an SME user can reveal the hidden domains
  // themselves via the sidebar-footer toggle (synced navFold reserved key, like "show advanced").
  const showSmeHidden = navFold[SME_HIDDEN_FOLD_KEY] ?? false;
  const groups = React.useMemo(() => {
    const filtered = filterByPerm(wsNav).filter((g) => showSmeHidden || !smeHidden.has(g.title));
    const base = filtered.length ? filtered : wsNav; // fall back while loading
    const ordered = orderGroups(base, groupOrder); // admin-curated system-wide category order
    return isGod ? [...ordered, PLATFORM_GROUP] : ordered; // platform console — god only
  }, [filterByPerm, wsNav, groupOrder, isGod, smeHidden, showSmeHidden]);
  // "Show advanced menus" — kept in the synced fold map under a reserved key (see ADVANCED_FOLD_KEY). Off by
  // default: infrequent/expert domains (Controls, Customise, Integrations, Intercompany) stay hidden.
  const showAdvanced = navFold[ADVANCED_FOLD_KEY] ?? false;
  // The domain tree hides `advanced` groups/subgroups when the toggle is off. Favourites/recents and the ⌘K
  // palette resolve against the UNFILTERED `groups`, so a pinned advanced item stays reachable regardless.
  const sidebarGroups = React.useMemo(() => filterAdvancedNav(groups, showAdvanced), [groups, showAdvanced]);
  const paletteGroups = React.useMemo(() => {
    const filtered = filterByPerm(nav);
    const base = filtered.length ? filtered : nav;
    const ordered = orderGroups(base, groupOrder); // keep the ⌘K palette in the same admin-curated order as the sidebar
    return isGod ? [...ordered, PLATFORM_GROUP] : ordered;
  }, [filterByPerm, nav, groupOrder, isGod]);

  const isActive = (href: string) =>
    pathname === href || (href !== '/dashboard' && href !== '/portal/dashboard' && pathname.startsWith(href + '/'));

  const activeItemLabel = groups.flatMap((g) => allGroupItems(g)).find((it) => isActive(it.href))?.label;

  // Resolve pinned hrefs against the items actually visible in the active workspace (perm-filtered), so we
  // never surface a favourite/recent the user can't currently reach. Recents exclude current favourites.
  const visibleByHref = React.useMemo(() => {
    const m = new Map<string, NavItem>();
    for (const g of groups) for (const it of allGroupItems(g)) m.set(it.href, it);
    return m;
  }, [groups]);
  const favItems = React.useMemo(
    () => favorites.map((h) => visibleByHref.get(h)).filter((it): it is NavItem => !!it),
    [favorites, visibleByHref],
  );
  const recentItems = React.useMemo(
    () =>
      recents
        .map((h) => visibleByHref.get(h))
        .filter((it): it is NavItem => !!it && !favSet.has(it.href))
        .slice(0, RECENTS_SHOWN),
    [recents, visibleByHref, favSet],
  );

  // The ⌘K palette spans all workspaces (paletteGroups), so resolve favourites/recents against that wider
  // set rather than the active-workspace one, and surface them pinned at the top of the palette.
  const paletteByHref = React.useMemo(() => {
    const m = new Map<string, NavItem>();
    for (const g of paletteGroups) for (const it of allGroupItems(g)) m.set(it.href, it);
    return m;
  }, [paletteGroups]);
  const paletteFavorites = React.useMemo(
    () => (pinsEnabled ? favorites.map((h) => paletteByHref.get(h)).filter((it): it is NavItem => !!it) : []),
    [pinsEnabled, favorites, paletteByHref],
  );
  const paletteRecents = React.useMemo(
    () =>
      pinsEnabled
        ? recents
            .map((h) => paletteByHref.get(h))
            .filter((it): it is NavItem => !!it && !favSet.has(it.href))
            .slice(0, RECENTS_SHOWN)
        : [],
    [pinsEnabled, recents, paletteByHref, favSet],
  );

  const renderItem = (item: NavItem) => {
    const fav = favSet.has(item.href);
    const label = t(item.label);
    return (
      <SidebarMenuItem key={item.href}>
        <SidebarMenuButton asChild isActive={isActive(item.href)} tooltip={label}>
          <Link href={item.href}>
            <item.icon />
            <span>{label}</span>
          </Link>
        </SidebarMenuButton>
        {pinsEnabled && (
          <button
            type="button"
            data-sidebar="menu-action"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleFavorite(item.href);
            }}
            aria-pressed={fav}
            aria-label={fav ? t('nav.fav_remove', { label }) : t('nav.fav_add', { label })}
            title={fav ? t('nav.fav_remove_short') : t('nav.fav_add_short')}
            className={cn(
              'absolute right-1 top-1.5 flex aspect-square w-5 items-center justify-center rounded-md text-sidebar-foreground/50 outline-none ring-sidebar-ring transition-opacity hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:ring-2 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 group-data-[collapsible=icon]:hidden',
              fav ? 'text-amber-500 opacity-100' : 'opacity-0',
            )}
          >
            <Star className={cn('size-3.5', fav && 'fill-current')} />
          </button>
        )}
      </SidebarMenuItem>
    );
  };

  // Favourites get reorder controls (move up/down) + unpin, shown only in the รายการโปรด group.
  const FAV_BTN =
    'flex aspect-square w-5 items-center justify-center rounded-md text-sidebar-foreground/50 outline-none ring-sidebar-ring hover:text-sidebar-foreground focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-30';
  const renderFavoriteItem = (item: NavItem, index: number, list: NavItem[]) => {
    const stop = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const label = t(item.label);
    const onHover = 'opacity-0 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100';
    return (
      <SidebarMenuItem key={item.href}>
        <SidebarMenuButton
          asChild
          isActive={isActive(item.href)}
          tooltip={label}
          className="pr-[4.25rem] group-data-[collapsible=icon]:pr-2"
        >
          <Link href={item.href}>
            <item.icon />
            <span>{label}</span>
          </Link>
        </SidebarMenuButton>
        <div className="absolute right-1 top-1.5 flex items-center gap-0.5 group-data-[collapsible=icon]:hidden">
          <button
            type="button"
            className={cn(FAV_BTN, onHover)}
            disabled={index === 0}
            aria-label={t('nav.move_up', { label })}
            title={t('nav.move_up_short')}
            onClick={(e) => {
              stop(e);
              if (index > 0) swapFavorites(item.href, list[index - 1].href);
            }}
          >
            <ChevronUp className="size-3.5" />
          </button>
          <button
            type="button"
            className={cn(FAV_BTN, onHover)}
            disabled={index === list.length - 1}
            aria-label={t('nav.move_down', { label })}
            title={t('nav.move_down_short')}
            onClick={(e) => {
              stop(e);
              if (index < list.length - 1) swapFavorites(item.href, list[index + 1].href);
            }}
          >
            <ChevronDown className="size-3.5" />
          </button>
          <button
            type="button"
            className={cn(FAV_BTN, 'text-amber-500')}
            aria-label={t('nav.fav_remove', { label })}
            title={t('nav.fav_remove_short')}
            onClick={(e) => {
              stop(e);
              toggleFavorite(item.href);
            }}
          >
            <Star className="size-3.5 fill-current" />
          </button>
        </div>
      </SidebarMenuItem>
    );
  };

  function logout() {
    void apiLogout().finally(() => router.replace('/login'));
  }

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-1 py-1.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
              IE
            </div>
            <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate text-sm font-semibold">{t(brand)}</span>
              {/* Active company name so users always know which company they're signed into (tenant code as fallback). */}
              <span className="truncate text-xs text-muted-foreground" title={me.data?.company_name ?? undefined}>
                {me.data?.company_name || me.data?.customer_name || 'Enterprise ERP'}
              </span>
            </div>
          </div>
          {enableWorkspaces && (
            <div className="px-1 pb-1 group-data-[collapsible=icon]:hidden">
              <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-0.5" role="tablist" aria-label="Workspace">
                {WORKSPACES.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    role="tab"
                    aria-selected={workspace === w.id}
                    onClick={() => selectWorkspace(w.id)}
                    className={cn(
                      'flex items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors',
                      workspace === w.id
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <w.icon className="size-3.5" />
                    {w.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {me.data?.is_platform_owner && <CompanySwitcher />}
        </SidebarHeader>

        <SidebarContent>
          {pinsEnabled && favItems.length > 0 && (
            <SidebarGroup>
              <SidebarGroupLabel>{t('nav.favorites')}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>{favItems.map((it, i) => renderFavoriteItem(it, i, favItems))}</SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
          {pinsEnabled && recentItems.length > 0 && (
            <SidebarGroup>
              <SidebarGroupLabel>{t('nav.recents')}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>{recentItems.map(renderItem)}</SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
          {sidebarGroups.map((group) => {
            // Only-active-open default: the domain holding the current route opens on load; an explicit user
            // toggle (navFold[group.title]) persists and overrides. Count feeds the collapsed badge.
            const groupActive = allGroupItems(group).some((it) => isActive(it.href));
            const groupDefault = groupActive || smeOpen.has(group.title);
            const open = navFold[group.title] ?? groupDefault;
            const count = allGroupItems(group).length;
            return (
              <NavGroupSection
                key={group.title}
                title={t(group.title)}
                count={count}
                open={open}
                active={groupActive}
                onToggle={() => toggleFold(group.title, groupDefault)}
              >
                {group.items && group.items.length > 0 && (
                  <SidebarMenu>{orderItems(group.items, itemOrder?.[group.title]).map(renderItem)}</SidebarMenu>
                )}
                {group.subgroups?.map((sub) => {
                  // B1: under an SME industry profile subgroups default FOLDED unless listed (or active);
                  // without a profile the pre-B1 default (defaultOpen ?? true) is unchanged.
                  const subActive = sub.items.some((it) => isActive(it.href));
                  const subDefault = smeOpen.size > 0 ? smeOpen.has(sub.title) || subActive : (sub.defaultOpen ?? true);
                  const subOpen = navFold[sub.title] ?? subDefault;
                  return (
                    <NavSubSection
                      key={sub.title}
                      title={t(sub.title)}
                      open={subOpen}
                      onToggle={() => toggleFold(sub.title, subDefault)}
                    >
                      <SidebarMenu>{orderItems(sub.items, itemOrder?.[sub.title]).map(renderItem)}</SidebarMenu>
                    </NavSubSection>
                  );
                })}
              </NavGroupSection>
            );
          })}
        </SidebarContent>

        <SidebarFooter>
          {pinsEnabled && (
            <button
              type="button"
              onClick={() => toggleFold(ADVANCED_FOLD_KEY, false)}
              aria-pressed={showAdvanced}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground group-data-[collapsible=icon]:hidden"
            >
              <span className="flex items-center gap-1.5">
                <SlidersHorizontal className="size-3.5 shrink-0" />
                {t('nav.show_advanced')}
              </span>
              <span
                className={cn(
                  'flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors',
                  showAdvanced ? 'bg-primary' : 'bg-muted-foreground/30',
                )}
              >
                <span className={cn('size-3 rounded-full bg-white transition-transform', showAdvanced && 'translate-x-3')} />
              </span>
            </button>
          )}
          {pinsEnabled && smeHidden.size > 0 && (
            <button
              type="button"
              onClick={() => toggleFold(SME_HIDDEN_FOLD_KEY, false)}
              aria-pressed={showSmeHidden}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground group-data-[collapsible=icon]:hidden"
            >
              <span className="flex items-center gap-1.5">
                <SlidersHorizontal className="size-3.5 shrink-0" />
                {t('nav.show_sme_hidden')}
              </span>
              <span
                className={cn(
                  'flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors',
                  showSmeHidden ? 'bg-primary' : 'bg-muted-foreground/30',
                )}
              >
                <span className={cn('size-3 rounded-full bg-white transition-transform', showSmeHidden && 'translate-x-3')} />
              </span>
            </button>
          )}
          {me.data && (
            <div className="flex items-center gap-2 rounded-md px-1 py-1.5 group-data-[collapsible=icon]:hidden">
              <Avatar className="size-8">
                <AvatarFallback className="bg-primary/10 text-primary">{initials(me.data.username)}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">{me.data.username}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {me.data.role}
                  {me.data.company_name || me.data.customer_name ? ` · ${me.data.company_name || me.data.customer_name}` : ''}
                </span>
              </div>
            </div>
          )}
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="sticky top-0 z-20 flex min-h-14 shrink-0 items-center gap-2 border-b bg-background/95 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] safe-pt backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-5" />
          <h2 className="text-sm font-medium">{activeItemLabel ? t(activeItemLabel) : t(brand)}</h2>

          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="hidden gap-2 text-muted-foreground sm:flex"
              onClick={() => setPaletteOpen(true)}
            >
              <Search className="size-4" />
              <span>{t('common.search')}</span>
              <kbd className="pointer-events-none ml-2 hidden h-5 items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium md:inline-flex">
                ⌘K
              </kbd>
            </Button>
            <Button variant="ghost" size="icon" className="sm:hidden" onClick={() => setPaletteOpen(true)} aria-label={t('common.search')}>
              <Search className="size-4" />
            </Button>
            <NotificationBell />
            <LanguageToggle />
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full" aria-label={t('common.user_account')}>
                  <Avatar className="size-8">
                    <AvatarFallback className="bg-primary/10 text-primary text-xs">
                      {initials(me.data?.username)}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div className="grid leading-tight">
                    <span className="truncate font-medium">{me.data?.username ?? '—'}</span>
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      {me.data?.role}
                      {me.data?.company_name || me.data?.customer_name ? ` · ${me.data?.company_name || me.data?.customer_name}` : ''}
                    </span>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={logout}>
                  <LogOut />
                  {t('common.logout')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {isGod && <GodScopeBanner />}
        {me.data?.control_profile === 'sme' && <SmeModeBanner />}
        <div className={cn('flex-1 pt-4 sm:pt-6 app-content-pad')}>{children}</div>
      </SidebarInset>

      <CommandPalette
        groups={paletteGroups}
        favorites={paletteFavorites}
        recents={paletteRecents}
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
      />

      {/* SME self-approval reason dialog (docs/49 H2) — invisible until api() dispatches a
          SELF_APPROVAL_REASON_REQUIRED request to it via lib/sme-reason.ts. Mounted unconditionally. */}
      <SmeReasonDialog />

      {/* Plan/entitlement upsell dialog (wave B2) — invisible until api() dispatches an
          `ierp:plan-denied` event on a plan-level 403. The billing CTA is internal-only. */}
      <PlanUpsellDialog showBillingCta={variant === 'internal'} />

      {/* SME first-run setup wizard (docs/49 v1.3) — self-hides unless the tenant is 'sme', setup is
          incomplete, and the wizard hasn't been completed/dismissed (sme_wizard_done user-pref). */}
      <SmeSetupWizard />

      {/* Global floating AI helper — contextual assistance from any screen, for users who can use the
          assistant (self-hides otherwise). Shares chat logic with the full /assistant page. */}
      {hasPerm(me.data, 'ai_chat', 'dashboard') && <AssistantWidget />}
    </SidebarProvider>
  );
}
