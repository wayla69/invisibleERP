'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, Search } from 'lucide-react';

import { getToken, clearToken } from '@/lib/api';
import { useMe, hasPerm } from '@/lib/auth';
import { useModuleFlags } from '@/lib/modules';
import { navForWorkspace, defaultWorkspace, WORKSPACES, type NavGroup, type Workspace } from '@/lib/nav';
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
import { CommandPalette } from '@/components/command-palette';

function initials(name?: string | null) {
  if (!name) return '?';
  return name.slice(0, 2).toUpperCase();
}

const WORKSPACE_KEY = 'ie-workspace';

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
    if (!localStorage.getItem(WORKSPACE_KEY)) setWorkspace(defaultWorkspace(me.data.permissions, me.data.role));
  }, [enableWorkspaces, me.data]);
  const selectWorkspace = (w: Workspace) => {
    setWorkspace(w);
    if (typeof window !== 'undefined') localStorage.setItem(WORKSPACE_KEY, w);
  };

  React.useEffect(() => {
    if (typeof window !== 'undefined' && !getToken()) router.replace('/login');
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

  // Filter groups/items by permission AND module enable/disable (back-office); drop empty groups.
  // A disabled module hides for EVERYONE (incl. Admin) — faithful to the legacy "hides for all".
  const disabledModules = React.useMemo(() => new Set(moduleFlags.data?.disabled ?? []), [moduleFlags.data]);
  const filterByPerm = React.useCallback(
    (groupsIn: NavGroup[]) => {
      if (!filterPerms) return groupsIn;
      const visible = (it: NavGroup['items'][number]) => {
        if (!hasPerm(me.data, ...(it.perms ?? []))) return false;
        const perms = it.perms ?? [];
        if (perms.length && perms.every((p) => disabledModules.has(p))) return false; // all its modules off
        return true;
      };
      return groupsIn.map((g) => ({ ...g, items: g.items.filter(visible) })).filter((g) => g.items.length > 0);
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
    groups.flatMap((g) => g.items).find((it) => isActive(it.href))?.label ?? brand;

  function logout() {
    clearToken();
    router.replace('/login');
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
          {groups.map((group) => (
            <SidebarGroup key={group.title}>
              <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={isActive(item.href)} tooltip={item.label}>
                        <Link href={item.href}>
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
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
