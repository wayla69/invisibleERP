// Reusable multi-select batch action bar for maker-checker approval queues.
//
// Batching is a pure UX convenience: `run(item, action)` fires the item's OWN existing
// per-item endpoint, so every item's control and segregation of duties (approver ≠ requester)
// is enforced server-side per item exactly as a one-by-one approval — this component adds no
// authority. A `Promise.allSettled` loop means a per-item failure (e.g. self-approval →
// SOD_VIOLATION) only fails THAT item; the rest still go through, and a summary reports how
// many succeeded and the first error.
//
// NB: no own 'use client' directive — this island is imported only by already-'use client'
// pages and inherits the boundary (keeps the check-use-client ratchet flat; see state-view.tsx).
import { useState } from 'react';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { Button } from '@/components/ui/button';

type Action = 'approve' | 'reject';

export function useBatchActions<T>(opts: {
  items: T[];
  keyOf: (it: T) => string;
  run: (it: T, action: Action, reason?: string) => Promise<unknown>;
  onDone?: () => void;
  eligible?: (it: T) => boolean;
}) {
  const { items, keyOf, run, onDone, eligible } = opts;
  const { t } = useLang();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);

  const pool = eligible ? items.filter(eligible) : items;
  const isEligible = (it: T) => (eligible ? eligible(it) : true);
  const isSel = (it: T) => sel.has(keyOf(it));
  const toggle = (it: T) =>
    setSel((s) => {
      const n = new Set(s);
      const k = keyOf(it);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  const clear = () => setSel(new Set());
  const selectAll = () => setSel(new Set(pool.map(keyOf)));

  async function runBatch(action: Action) {
    const chosen = pool.filter(isSel);
    if (!chosen.length) return;
    let reason: string | undefined;
    if (action === 'reject') {
      const r = window.prompt(t('batch.confirm_reject', { n: String(chosen.length) }));
      if (r === null) return; // cancelled
      reason = r || undefined;
    }
    setRunning(true);
    const results = await Promise.allSettled(chosen.map((it) => run(it, action, reason)));
    setRunning(false);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fails = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    const failNote = fails.length
      ? t('batch.fail_note', { fail: String(fails.length), firstError: String(fails[0]!.reason?.message ?? 'error').slice(0, 60) })
      : '';
    (fails.length ? notifyError : notifySuccess)(t('batch.done', { ok: String(ok), failNote }));
    clear();
    onDone?.();
  }

  return { sel, isSel, isEligible, toggle, clear, selectAll, running, eligibleCount: pool.length, selectedCount: sel.size, runBatch };
}

/** The action toolbar. Render above the queue table; shows once ≥1 item is batch-eligible. */
export function BatchBar(props: {
  eligibleCount: number;
  selectedCount: number;
  running: boolean;
  onSelectAll: () => void;
  onApprove: () => void;
  onReject?: () => void;
  onClear: () => void;
  /** Hide the reject button on queues where the only batch action is approve (e.g. tax-note approval). */
  showReject?: boolean;
}) {
  const { t } = useLang();
  const showReject = props.showReject !== false && !!props.onReject;
  if (props.eligibleCount === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-2 text-sm">
      <Button size="sm" variant="ghost" onClick={props.onSelectAll}>
        {t('batch.select_all')} ({props.eligibleCount})
      </Button>
      {props.selectedCount > 0 && (
        <>
          <span className="font-medium">{t('batch.selected_n', { n: String(props.selectedCount) })}</span>
          <Button size="sm" disabled={props.running} onClick={props.onApprove}>{t('batch.approve')}</Button>
          {showReject && <Button size="sm" variant="outline" disabled={props.running} onClick={props.onReject}>{t('batch.reject')}</Button>}
          <Button size="sm" variant="ghost" disabled={props.running} onClick={props.onClear}>{t('batch.clear')}</Button>
        </>
      )}
    </div>
  );
}

/** A DataTable checkbox column for the batch selection. Spread into a `columns` array as the leader. */
export function batchColumn<T>(b: { isSel: (it: T) => boolean; isEligible: (it: T) => boolean; toggle: (it: T) => void; refOf: (it: T) => string }) {
  return {
    key: '_sel',
    label: '',
    sortable: false,
    render: (r: T) =>
      b.isEligible(r) ? (
        <input type="checkbox" aria-label={`select ${b.refOf(r)}`} checked={b.isSel(r)} onChange={() => b.toggle(r)} />
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      ),
  };
}
