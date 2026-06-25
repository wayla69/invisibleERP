'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { allGroupItems, type NavGroup, type NavItem } from '@/lib/nav';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

export function CommandPalette({
  groups,
  favorites = [],
  recents = [],
  open,
  onOpenChange,
}: {
  groups: NavGroup[];
  /** Pinned/recent shortcuts surfaced at the top of the palette (resolved to accessible items by the shell). */
  favorites?: NavItem[];
  recents?: NavItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();

  const go = React.useCallback(
    (href: string) => {
      onOpenChange(false);
      router.push(href);
    },
    [router, onOpenChange],
  );

  // cmdk requires unique item `value`s; the pinned/recent rows reuse an href that also appears in a normal
  // group, so prefix their value with a marker (label stays in it, so search still matches by label).
  const renderItem = (item: NavItem, valuePrefix = '') => (
    <CommandItem
      key={item.href}
      value={`${valuePrefix}${item.label} ${item.href}`}
      onSelect={() => go(item.href)}
    >
      <item.icon className="text-muted-foreground" />
      <span>{item.label}</span>
    </CommandItem>
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="ค้นหาเมนู" description="ไปยังหน้าใดก็ได้">
      <CommandInput placeholder="พิมพ์เพื่อค้นหาเมนู…" />
      <CommandList>
        <CommandEmpty>ไม่พบเมนู</CommandEmpty>
        {favorites.length > 0 && (
          <CommandGroup heading="★ รายการโปรด">{favorites.map((item) => renderItem(item, '★ '))}</CommandGroup>
        )}
        {recents.length > 0 && (
          <CommandGroup heading="ล่าสุด">{recents.map((item) => renderItem(item, '↻ '))}</CommandGroup>
        )}
        {groups.map((group) => (
          <CommandGroup key={group.title} heading={group.title}>
            {allGroupItems(group).map((item) => renderItem(item))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
