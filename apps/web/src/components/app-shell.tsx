'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronRight, LogOut, Search, Star } from 'lucide-react';

import { hasSession, logout as apiLogout } from '@/lib/api';
import { useMe, hasPerm } from '@/lib/auth';
import { useModuleFlags } from '@/lib/modules';
import {
  allGroupItems,
  navForWorkspace,
  defaultWorkspace,
  workspaceHome,
  WORKSPACES,
  type NavGroup,
  type NavItem,
  type Workspace,
} from '@/lib/nav';
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
import { NotificationBell } from '@/components/notification-bell';

function initials(name?: string | null) {
  if (!name) return '?';
  return name.slice(0, 2).toUpperCase();
}

const WORKSPACE_KEY = 'ie-workspace';
const FAVORITES_KEY = 'ie-nav-favorites'; // pinned hrefs (manual)
const RECENTS_KEY = 'ie-nav-recents'; // recently visited hrefs (auto, most-recent-first)
const RECENTS_SHOWN = 5; // how many recent items to surface
const RECENTS_STORED = 12; // how many to retain so favourites filtering doesn't starve the list

/** A labelled, collapsible sub-section inside a sidebar group (dependency-free). Open state persists per
 *  title in localStorage. In icon-collapsed mode the header is hidden and items stay visible (icons only). */
function NavSubSection({ title, children }: { title: string; children: React.ReactNode }) {
  const storeKey = `ie-nav-sub:${title}`;
  const [open, setOpen] = React.useState(true);
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = localStorage.getItem(storeKey);
    if (saved != null) setOpen(saved === '1');
  }, [storeKey]);
  const toggle = () =>
    setOpen((o) => {
      const next = !o;
      if (typeof window !== 'undefined') localStorage.setItem(storeKey, next ? '1' : '0');
      return next;
    });
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-sidebar-foreground/60 transition-colors hover:text-sidebar-foreground group-data-[collapsible=icon]:hidden"
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="truncate">{title}</span>
      </button>
      <div className={cn(open ? 'block' : 'hidden', 'group-data-[collapsible=icon]:block')}>{children}</div>
    </div>
  );
}

export function AppShell({
  nav,
  brand,
  filterPerms = false,
  enableWorkspaces = false,
  children,
}: {
  nav: NavGroup[];
  brand: string;
  filterPerms?: boolean;
  /** Show the ERP/POS workspace switcher and filter the sidebar to the active workspace. */
  enableWorkspaces?: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();
  const moduleFlags = useModuleFlags();
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  // Favourites (pinned via the star) + auto-tracked recents — only on the permission-gated internal
  // surface (not the small customer portal). Loaded after mount to avoid an SSR/CSR hydration mismatch.
  const pinsEnabled = filterPerms;
  const [favorites, setFavorites] = React.useState<string[]>([]);
  const [recents, setRecents] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const read = (k: string): string[] => {
      try {
        const v = JSON.parse(localStorage.getItem(k) ?? '[]');
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        return [];
      }
    };
    setFavorites(read(FAVORITES_KEY));
    setRecents(read(RECENTS_KEY));
  }, []);
  const favSet = React.useMemo(() => new Set(favorites), [favorites]);
  const toggleFavorite = React.useCallback((href: string) => {
    setFavorites((prev) => {
      const next = prev.includes(href) ? prev.filter((h) => h !== href) : [href, ...prev];
      if (typeof window !== 'undefined') localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

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
  const filterByPerm = React.useCallback(
    (groupsIn: NavGroup[]) => {
      if (!filterPerms) return groupsIn;
      const visible = (it: NavItem) => {
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
    [filterPerms, me.data, disabledModules],
  );

  // Sidebar = permission-filtered within the active workspace; ⌘K palette stays global (all workspaces).
  const wsNav = React.useMemo(() => (enableWorkspaces ? navForWorkspace(nav, workspace) : nav), [enableWorkspaces, nav, workspace]);
  const groups = React.useMemo(() => {
    const filtered = filterByPerm(wsNav);
    return filtered.length ? filtered : wsNav; // fall back while loading
  }, [filterByPerm, wsNav]);
  const paletteGroups = React.useMemo(() => {
    const filtered = filterByPerm(nav);
    return filtered.length ? filtered : nav;
  }, [filterByPerm, nav]);

  const isActive = (href: string) =>
    pathname === href || (href !== '/dashboard' && href !== '/portal/dashboard' && pathname.startsWith(href + '/'));

  const activeLabel =
    groups.flatMap((g) => allGroupItems(g)).find((it) => isActive(it.href))?.label ?? brand;

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

  const renderItem = (item: NavItem) => {
    const fav = favSet.has(item.href);
    return (
      <SidebarMenuItem key={item.href}>
        <SidebarMenuButton asChild isActive={isActive(item.href)} tooltip={item.label}>
          <Link href={item.href}>
            <item.icon />
            <span>{item.label}</span>
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
            aria-label={fav ? `เอา ${item.label} ออกจากรายการโปรด` : `เพิ่ม ${item.label} ในรายการโปรด`}
            title={fav ? 'เอาออกจากรายการโปรด' : 'เพิ่มในรายการโปรด'}
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
              <span className="truncate text-sm font-semibold">{brand}</span>
              <span className="truncate text-xs text-muted-foreground">Enterprise ERP</span>
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
        </SidebarHeader>

        <SidebarContent>
          {pinsEnabled && favItems.length > 0 && (
            <SidebarGroup>
              <SidebarGroupLabel>รายการโปรด</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>{favItems.map(renderItem)}</SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
          {pinsEnabled && recentItems.length > 0 && (
            <SidebarGroup>
              <SidebarGroupLabel>ล่าสุด</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>{recentItems.map(renderItem)}</SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
          {groups.map((group) => (
            <SidebarGroup key={group.title}>
              <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
              <SidebarGroupContent>
                {group.items && group.items.length > 0 && (
                  <SidebarMenu>{group.items.map(renderItem)}</SidebarMenu>
                )}
                {group.subgroups?.map((sub) => (
                  <NavSubSection key={sub.title} title={sub.title}>
                    <SidebarMenu>{sub.items.map(renderItem)}</SidebarMenu>
                  </NavSubSection>
                ))}
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>

        <SidebarFooter>
          {me.data && (
            <div className="flex items-center gap-2 rounded-md px-1 py-1.5 group-data-[collapsible=icon]:hidden">
              <Avatar className="size-8">
                <AvatarFallback className="bg-primary/10 text-primary">{initials(me.data.username)}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">{me.data.username}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {me.data.role}
                  {me.data.customer_name ? ` · ${me.data.customer_name}` : ''}
                </span>
              </div>
            </div>
          )}
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-5" />
          <h2 className="text-sm font-medium">{activeLabel}</h2>

          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="hidden gap-2 text-muted-foreground sm:flex"
              onClick={() => setPaletteOpen(true)}
            >
              <Search className="size-4" />
              <span>ค้นหา…</span>
              <kbd className="pointer-events-none ml-2 hidden h-5 items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium md:inline-flex">
                ⌘K
              </kbd>
            </Button>
            <Button variant="ghost" size="icon" className="sm:hidden" onClick={() => setPaletteOpen(true)} aria-label="ค้นหา">
              <Search className="size-4" />
            </Button>
            <NotificationBell />
            <LanguageToggle />
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full" aria-label="บัญชีผู้ใช้">
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
                      {me.data?.customer_name ? ` · ${me.data.customer_name}` : ''}
                    </span>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={logout}>
                  <LogOut />
                  ออกจากระบบ
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <div className={cn('flex-1 p-4 sm:p-6')}>{children}</div>
      </SidebarInset>

      <CommandPalette groups={paletteGroups} open={paletteOpen} onOpenChange={setPaletteOpen} />
    </SidebarProvider>
  );
}
