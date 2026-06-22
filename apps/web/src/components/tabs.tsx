'use client';

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { Tabs as ShTabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

/** Compatibility wrapper preserving the original `{ tabs: { key, label, content }[] }` API. */
export function Tabs({ tabs }: { tabs: { key: string; label: string; content: ReactNode }[] }) {
  if (!tabs.length) return null;
  return (
    <ShTabs defaultValue={tabs[0].key} className="gap-4">
      <TabsList className="flex-wrap">
        {tabs.map((t) => (
          <TabsTrigger key={t.key} value={t.key}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.key} value={t.key}>
          {t.content}
        </TabsContent>
      ))}
    </ShTabs>
  );
}

export function Msg({ ok, children }: { ok?: boolean; children: ReactNode }) {
  if (!children) return null;
  return (
    <p className={cn('my-2 text-sm', ok ? 'text-success' : 'text-destructive')}>{children}</p>
  );
}
