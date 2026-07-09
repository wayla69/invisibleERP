// Pure presentational (no hooks/state/browser APIs) — deliberately NOT 'use client': server pages render
// it on the server; client pages that import it still bundle it client-side. Keeps the RSC ratchet honest.
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-6 flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {/* max-w-full + wrap (NOT shrink-0): a wide action cluster must wrap inside the viewport — a
          shrink-0 block keeps its intrinsic width, and on a phone that widens the layout viewport and
          shifts every position:fixed surface off-screen (the /shop overflow class, CLAUDE.md). */}
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
