'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { useLang } from '@/lib/i18n';
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
  const { t } = useLang();

  const go = React.useCallback(
    (href: string) => {
      onOpenChange(false);
      router.push(href);
    },
    [router, onOpenChange],
  );

  // cmdk requires unique item `value`s; the pinned/recent rows reuse an href that also appears in a normal
  // group, so prefix their value with a marker (label stays in it, so search still matches by label).
  const renderItem = (item: NavItem, valuePrefix = '') => {
    const label = t(item.label);
    return (
      <CommandItem
        key={item.href}
        value={`${valuePrefix}${label} ${item.href}`}
        onSelect={() => go(item.href)}
      >
        <item.icon className="text-muted-foreground" />
        <span>{label}</span>
      </CommandItem>
    );
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t('palette.title')} description={t('palette.description')}>
      <CommandInput placeholder={t('palette.placeholder')} />
      <CommandList>
        <CommandEmpty>{t('palette.empty')}</CommandEmpty>
        {favorites.length > 0 && (
          <CommandGroup heading={`★ ${t('nav.favorites')}`}>{favorites.map((item) => renderItem(item, '★ '))}</CommandGroup>
        )}
        {recents.length > 0 && (
          <CommandGroup heading={t('nav.recents')}>{recents.map((item) => renderItem(item, '↻ '))}</CommandGroup>
        )}
        {groups.map((group) => (
          <CommandGroup key={group.title} heading={t(group.title)}>
            {allGroupItems(group).map((item) => renderItem(item))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
