'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Banknote, ClipboardList, FileSpreadsheet, FileText, FolderKanban, IdCard, Package, ReceiptText, ShoppingCart, Star, Truck, Users, type LucideIcon } from 'lucide-react';

import { api } from '@/lib/api';
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

type SearchType =
  | 'customer' | 'vendor' | 'item'
  | 'sale' | 'ar_invoice' | 'tax_invoice' | 'purchase_order'
  | 'member' | 'project' | 'requisition' | 'ap_invoice' | 'employee';
interface SearchResult { type: SearchType; id: string; label: string; sublabel?: string; href: string }

const TYPE_ICON: Record<SearchType, LucideIcon> = {
  customer: Users,
  vendor: Truck,
  item: Package,
  sale: ReceiptText,
  ar_invoice: FileText,
  tax_invoice: FileSpreadsheet,
  purchase_order: ShoppingCart,
  member: Star,
  project: FolderKanban,
  requisition: ClipboardList,
  ap_invoice: Banknote,
  employee: IdCard,
};
const TYPE_LABEL_KEY: Record<SearchType, string> = {
  customer: 'search.type.customer',
  vendor: 'search.type.vendor',
  item: 'search.type.item',
  sale: 'search.type.sale',
  ar_invoice: 'search.type.ar_invoice',
  tax_invoice: 'search.type.tax_invoice',
  purchase_order: 'search.type.purchase_order',
  member: 'search.type.member',
  project: 'search.type.project',
  requisition: 'search.type.requisition',
  ap_invoice: 'search.type.ap_invoice',
  employee: 'search.type.employee',
};

/** Debounce a fast-changing value so the omni-search fires ~4×/s while typing, not on every keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

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

  // Controlled query so we can both drive cmdk's own nav filtering AND feed the server omni-search.
  const [query, setQuery] = React.useState('');
  React.useEffect(() => { if (!open) setQuery(''); }, [open]);

  const debounced = useDebounced(query.trim(), 250);
  // Global record search (customers / vendors / products). Reuses the existing cookie-auth `api` helper; the
  // endpoint self-filters result types by permission, so whatever comes back is safe to show.
  const search = useQuery<{ results: SearchResult[] }>({
    queryKey: ['omnisearch', debounced],
    queryFn: () => api(`/api/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length >= 2,
    staleTime: 30_000,
    retry: false,
  });
  const results = search.data?.results ?? [];

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
      <CommandInput placeholder={t('palette.placeholder')} value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>{t('palette.empty')}</CommandEmpty>
        {/* Record results first — that's what the user is usually hunting for when they type a name/code. Each
            value embeds the live query so cmdk's own filter keeps these rows visible (they were matched
            server-side, not by cmdk). */}
        {results.length > 0 && (
          <CommandGroup heading={t('palette.records')}>
            {results.map((r) => {
              const Icon = TYPE_ICON[r.type];
              return (
                <CommandItem
                  key={`${r.type}:${r.id}`}
                  value={`record ${query} ${r.type} ${r.label} ${r.id}`}
                  onSelect={() => go(r.href)}
                >
                  <Icon className="text-muted-foreground" />
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {t(TYPE_LABEL_KEY[r.type])}
                  </span>
                  <span className="truncate">{r.label}</span>
                  {r.sublabel && <span className="ml-auto truncate text-xs text-muted-foreground">{r.sublabel}</span>}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
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
