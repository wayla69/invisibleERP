import { Fragment } from 'react';
import Link from 'next/link';

import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

/**
 * `Crumbs` — the one-line breadcrumb strip for NESTED DETAIL routes (docs/39 batch 5b).
 * Per the signed batch-5 decision it is used ONLY where a parent-list crumb genuinely aids
 * navigation (e.g. `/projects/[code]`); 1-level-deep pages keep relying on the sidebar +
 * `PageHeader`. Client-side navigation via `next/link` through the primitive's `asChild` slot.
 * NO 'use client' — inherits the importing page's boundary (check-use-client stays flat).
 */
export function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <Breadcrumb className="mb-3">
      <BreadcrumbList>
        {items.map((it, i) => (
          <Fragment key={`${it.label}-${i}`}>
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {it.href ? (
                <BreadcrumbLink asChild>
                  <Link href={it.href}>{it.label}</Link>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{it.label}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
