'use client';

import type { ComponentProps, ReactNode } from 'react';
import { Search, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

/**
 * Standard search box: leading magnifier, a **clear (✕) button** that appears once there's text, and an
 * optional result `count` to its right. Replaces the hand-rolled `relative + Search icon + Input` markup
 * repeated across list screens, and makes "type to filter" friendlier (one-click clear, visible count).
 */
export function SearchInput({
  value,
  onChange,
  placeholder = 'ค้นหา…',
  count,
  ariaLabel,
  className,
  inputClassName,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Optional result count shown to the right (e.g. `12 รายการ`). */
  count?: ReactNode;
  ariaLabel?: string;
  className?: string;
  inputClassName?: string;
} & Omit<ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="relative w-full sm:max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className={cn('pl-9 pr-9', inputClassName)}
          inputMode="search"
          enterKeyHint="search"
          aria-label={ariaLabel ?? placeholder}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...rest}
        />
        {value && (
          <button
            type="button"
            aria-label="ล้างคำค้นหา"
            onClick={() => onChange('')}
            className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {count != null && (
        <span aria-live="polite" className="tabular shrink-0 text-xs text-muted-foreground">
          {count}
        </span>
      )}
    </div>
  );
}
