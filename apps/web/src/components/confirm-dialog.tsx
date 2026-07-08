import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLang } from '@/lib/i18n';

/**
 * The shared destructive-action confirmation (docs/39 batch 0) — replaces `window.confirm` so every
 * confirm reads the same, is themable/translatable, and can show a busy state while the mutation runs
 * (window.confirm blocked the main thread and looked like the browser, not the app).
 *
 * Controlled: the page keeps `open` state (usually the pending action's payload) and calls its mutation
 * from `onConfirm`. NO 'use client' directive on purpose — it inherits the importing page's client
 * boundary (docs/28 §4 ratchet pattern, same as state-view.tsx / data-table.tsx).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = true,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Defaults to the shared ยืนยัน/Confirm label. */
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  /** Destructive styling by default — that's what confirms are for. */
  destructive?: boolean;
  /** Disables both buttons while the confirmed mutation is in flight. */
  busy?: boolean;
  onConfirm: () => void;
}) {
  const { t } = useLang();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {cancelLabel ?? t('mx.cfm_cancel')}
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} disabled={busy} onClick={onConfirm}>
            {confirmLabel ?? t('mx.cfm_confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
