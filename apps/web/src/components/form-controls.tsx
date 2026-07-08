import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * The one canonical NATIVE `<select>` style (docs/39 batch 0) — the same class string that was inlined
 * per page (master-io.tsx et al.). A native element on purpose: swapping to the radix Select would change
 * keyboard/form semantics and break `page.selectOption()` in the e2e specs; the standardization goal here
 * is one look + one import, not new interaction behavior. NO 'use client' — inherits the page's boundary.
 */
export const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(selectCls, className)} {...props} />;
}
