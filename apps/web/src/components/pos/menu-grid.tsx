'use client';

import { useEffect, useMemo, useState } from 'react';
import { Star, UtensilsCrossed } from 'lucide-react';
import { baht } from '@/lib/format';
import { cn } from '@/lib/utils';
import { onBarcodeScan } from '@/lib/peripherals';
import { notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { SearchInput } from '@/components/search-input';
import type { MenuItem, MenuResp } from './types';
import { sellable } from './types';

type CatKey = 'all' | 'fav' | number | 'none';

/** Touch product grid: category chips + free-text/scan search + tap-to-add cards.
 *  Pass `favIds` + `onToggleFav` to activate the ★ Favourites tab and per-card star toggles. */
export function MenuGrid({ data, onPick, favIds, onToggleFav, className }: {
  data: MenuResp;
  onPick: (item: MenuItem) => void;
  favIds?: Set<number>;
  onToggleFav?: (id: number) => void;
  className?: string;
}) {
  const { t } = useLang();
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState<CatKey>('all');

  const catColor = useMemo(() => {
    const m = new Map<number, string | null>();
    for (const c of data.categories) m.set(c.id, c.color);
    return m;
  }, [data]);

  const allItems = useMemo<MenuItem[]>(
    () => [...data.categories.flatMap((c) => c.items), ...data.uncategorized],
    [data],
  );

  // Barcode/scan-gun: type SKU + Enter anywhere (the helper ignores focused inputs) → add the line.
  useEffect(() => {
    return onBarcodeScan((code) => {
      const sku = code.trim();
      const it = allItems.find((i) => i.sku.toLowerCase() === sku.toLowerCase());
      if (!it) { notifyError(t('px.menu_not_found', { sku })); return; }
      if (!sellable(it)) { notifyError(t('px.menu_item_disabled', { name: it.name })); return; }
      onPick(it);
    });
  }, [allItems, onPick, t]);

  const favSet = favIds ?? new Set<number>();

  const filtered = useMemo<MenuItem[]>(() => {
    const term = search.trim().toLowerCase();
    if (term) {
      return allItems.filter((i) =>
        i.sku.toLowerCase().includes(term) ||
        i.name.toLowerCase().includes(term) ||
        (i.name_en ?? '').toLowerCase().includes(term),
      );
    }
    if (cat === 'fav') return allItems.filter((i) => favSet.has(i.id));
    if (cat === 'all') return allItems;
    if (cat === 'none') return data.uncategorized;
    return data.categories.find((c) => c.id === cat)?.items ?? [];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, cat, allItems, data, favIds]);

  const chip = (active: boolean) =>
    cn(
      'shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors whitespace-nowrap',
      active ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
    );

  return (
    <div className={cn('flex min-h-0 flex-col gap-3', className)}>
      <SearchInput value={search} onChange={setSearch} placeholder={t('px.menu_search_ph')} ariaLabel={t('px.menu_search_aria')} />

      {!search && (
        <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label={t('px.menu_cats_aria')}>
          {onToggleFav && (
            <button type="button" className={chip(cat === 'fav')} onClick={() => setCat('fav')} title={t('px.menu_favorites')}>
              <Star className={cn('mr-1 inline size-3.5 align-middle', favSet.size > 0 && cat === 'fav' && 'fill-current')} />
              {t('px.menu_favorites')} {favSet.size > 0 && `(${favSet.size})`}
            </button>
          )}
          <button type="button" className={chip(cat === 'all')} onClick={() => setCat('all')}>{t('px.menu_all')}</button>
          {data.categories.filter((c) => c.items.length > 0).map((c) => (
            <button key={c.id} type="button" className={chip(cat === c.id)} onClick={() => setCat(c.id)}>
              {c.color && <span className="mr-1.5 inline-block size-2 rounded-full align-middle" style={{ background: c.color }} />}
              {c.name}
            </button>
          ))}
          {data.uncategorized.length > 0 && (
            <button type="button" className={chip(cat === 'none')} onClick={() => setCat('none')}>{t('px.menu_other')}</button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="grid h-40 place-items-center text-center text-sm text-muted-foreground">
            <div>
              <UtensilsCrossed className="mx-auto mb-2 size-7 opacity-40" />
              {search ? t('px.menu_no_results') : cat === 'fav' ? t('px.menu_no_favorites') : t('px.menu_no_items')}
            </div>
          </div>
        ) : (
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(116px,1fr))]">
            {filtered.map((it) => {
              const ok = sellable(it);
              const color = it.category_id != null ? catColor.get(it.category_id) ?? null : null;
              const isFav = favSet.has(it.id);
              return (
                <button
                  key={it.id}
                  type="button"
                  disabled={!ok}
                  onClick={() => onPick(it)}
                  title={it.name}
                  className={cn(
                    'group relative flex min-h-[92px] flex-col overflow-hidden rounded-xl border bg-card text-left transition-all',
                    ok ? 'hover:border-primary hover:shadow-sm active:scale-[0.98]' : 'cursor-not-allowed opacity-50',
                  )}
                >
                  <div className="relative h-12 w-full shrink-0" style={{ background: color ? `${color}22` : 'var(--muted)' }}>
                    {it.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={it.image_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-base font-semibold text-muted-foreground">
                        {it.name.slice(0, 2)}
                      </span>
                    )}
                    {!ok && (
                      <span className="absolute right-1 top-1 rounded bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
                        {t('px.menu_closed')}
                      </span>
                    )}
                    {it.has_modifiers && ok && (
                      <span className="absolute right-1 top-1 rounded bg-primary/90 px-1 text-[10px] font-medium text-primary-foreground">
                        {t('px.menu_options')}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col justify-between gap-1 p-2">
                    <span className="line-clamp-2 text-xs font-medium leading-tight">{it.name}</span>
                    <span className="tabular text-sm font-semibold">{baht(it.price)}</span>
                  </div>
                  {onToggleFav && (
                    <button
                      type="button"
                      aria-label={isFav ? t('px.menu_aria_unfav') : t('px.menu_aria_fav')}
                      onClick={(e) => { e.stopPropagation(); onToggleFav(it.id); }}
                      className={cn(
                        'absolute left-1 top-1 rounded p-0.5 transition-colors',
                        isFav
                          ? 'text-amber-400 hover:text-amber-500'
                          : 'text-muted-foreground/40 opacity-0 group-hover:opacity-100 hover:text-amber-400',
                      )}
                    >
                      <Star className={cn('size-3.5', isFav && 'fill-current')} />
                    </button>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
