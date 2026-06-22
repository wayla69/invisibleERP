'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, Search } from 'lucide-react';

import { getToken, clearToken } from '@/lib/api';
import { useMe, hasPerm } from '@/lib/auth';
import type { NavGroup } from '@/lib/nav';
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

export function AppShell({
  nav,
  brand,
  filterPerms = false,
  children,
}: {
  nav: NavGroup[];
  brand: string;
  filterPerms?: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  React.useEffect(() => {
    if (typeof window !== 'undefined' && !getToken()) router.replace('/login');
  }, [router]);

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

  // Filter groups/items by permission (back-office); drop empty groups.
  const groups = React.useMemo(() => {
    if (!filterPerms) return nav;
    const filtered = nav
      .map((g) => ({ ...g, items: g.items.filter((it) => hasPerm(me.data, ...(it.perms ?? []))) }))
      .filter((g) => g.items.length > 0);
    return filtered.length ? filtered : nav; // fall back to full nav while loading
  }, [nav, filterPerms, me.data]);

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

      <CommandPalette groups={groups} open={paletteOpen} onOpenChange={setPaletteOpen} />
    </SidebarProvider>
  );
}
