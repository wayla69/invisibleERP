'use client';

import { useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { Tabs as ShTabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

export interface TabDef {
  key: string;
  label: string;
  content: ReactNode;
}

/**
 * Compatibility wrapper preserving the original `{ tabs: { key, label, content }[] }` API.
 *
 * Pass `urlParam` to make the active tab **deep-linkable** — the selection is read from and written to that
 * query-string key (e.g. `urlParam="tab"` ↔ `/finance?tab=payables`), so a link or the dashboard action
 * center can open the page on a specific tab. URL sync is purely client-side via `history.replaceState`
 * (no router navigation / refetch, no `useSearchParams` Suspense requirement); the first tab is the default
 * and clears the param. Omit `urlParam` for the original uncontrolled behavior.
 */
export function Tabs({ tabs, urlParam }: { tabs: TabDef[]; urlParam?: string }) {
  if (!tabs.length) return null;
  if (urlParam) return <UrlSyncedTabs tabs={tabs} param={urlParam} />;
  return <TabsShell tabs={tabs} defaultValue={tabs[0].key} />;
}

function UrlSyncedTabs({ tabs, param }: { tabs: TabDef[]; param: string }) {
  const keys = tabs.map((t) => t.key);
  const [value, setValue] = useState(() => {
    if (typeof window === 'undefined') return tabs[0].key;
    const p = new URLSearchParams(window.location.search).get(param);
    return p && keys.includes(p) ? p : tabs[0].key;
  });
  const onValueChange = (v: string) => {
    setValue(v);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (v === tabs[0].key) url.searchParams.delete(param);
    else url.searchParams.set(param, v);
    window.history.replaceState(window.history.state, '', url.toString());
  };
  return <TabsShell tabs={tabs} value={value} onValueChange={onValueChange} />;
}

function TabsShell({
  tabs,
  ...rootProps
}: {
  tabs: TabDef[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
}) {
  return (
    <ShTabs className="gap-4" {...rootProps}>
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
