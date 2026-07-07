// Master-data change-history timeline (master-data audit Phase 6). Renders the append-only field-level
// trail (ITGC-AC-14) for a customer/vendor master record. No 'use client' directive: this island is imported
// only by already-'use client' pages (/customers, /inventory/suppliers) and inherits their boundary — adding
// the directive here would needlessly trip the use-client ratchet.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { thaiDate } from '@/lib/format';

interface ChangeEntry {
  ts: string; action: 'created' | 'updated' | 'deleted'; actor: string | null;
  changes: { field: string; old: unknown; new: unknown }[];
}

export function ChangeHistorySection({ url, queryKey }: { url: string; queryKey: unknown[] }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const q = useQuery<{ history: ChangeEntry[]; count: number }>({ queryKey, queryFn: () => api(url), enabled: open });
  const entries = q.data?.history ?? [];
  const fmt = (v: unknown) => v === null || v === undefined || v === '' ? '—' : String(v);
  return (
    <div className="grid gap-2">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-sm font-medium">
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <History className="size-4" /> {t('mx.cm_history')}
      </button>
      {open && (
        <div className="grid gap-2 pl-1">
          {q.isLoading && <p className="text-xs text-muted-foreground">…</p>}
          {q.data && entries.length === 0 && <p className="text-xs text-muted-foreground">{t('mx.cm_history_none')}</p>}
          {entries.map((e, i) => (
            <div key={i} className="rounded-md border border-border/60 p-2 text-xs">
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="font-medium text-foreground">{t(`mx.cm_history_${e.action}` as any)}</span>
                <span>·</span><span>{e.actor ?? '—'}</span>
                <span className="ml-auto tabular">{thaiDate(e.ts)}</span>
              </div>
              {e.changes.length > 0 && (
                <ul className="mt-1 grid gap-0.5">
                  {e.changes.map((c, j) => (
                    <li key={j} className="text-muted-foreground">
                      <span className="font-medium">{c.field}</span>: <span className="line-through">{fmt(c.old)}</span> → <span className="text-foreground">{fmt(c.new)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
