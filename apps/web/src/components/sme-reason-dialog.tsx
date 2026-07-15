// SME self-approval reason dialog (docs/49 H2) — replaces the window.prompt flow with a proper modal.
// NO 'use client' directive on purpose: this island is imported only from app-shell.tsx (already a client
// file), so it inherits the client boundary — adding the directive would trip the check-use-client ratchet.
// It registers itself as the host in lib/sme-reason.ts on mount; `api()` calls requestSmeReason() there,
// which dispatches to this dialog (or falls back to window.prompt on pages without AppShell).
// Concurrency: one pending request at a time — a second request arriving while the dialog is open resolves
// null immediately (its 400 error surfaces normally), rather than queueing; approve flows are user-initiated
// one at a time, so this simplest policy is safe.

import { useEffect, useRef, useState } from 'react';

import { registerSmeReasonHost, unregisterSmeReasonHost } from '@/lib/sme-reason';
import { useLang } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const MAX_REASON_LEN = 500;

interface PendingRequest {
  msg: string;
  resolve: (reason: string | null) => void;
}

export function SmeReasonDialog() {
  const { t } = useLang();
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [reason, setReason] = useState('');
  // Ref mirror so the (mount-once) host closure sees the live pending state without re-registering.
  const pendingRef = useRef<PendingRequest | null>(null);
  pendingRef.current = pending;

  useEffect(() => {
    const hostFn = (serverMsg: string) =>
      new Promise<string | null>((resolve) => {
        if (pendingRef.current) {
          // Already showing a dialog for another request — resolve null (see concurrency note above).
          resolve(null);
          return;
        }
        setReason('');
        setPending({ msg: serverMsg, resolve });
      });
    registerSmeReasonHost(hostFn);
    return () => unregisterSmeReasonHost(hostFn);
  }, []);

  // Resolve the pending promise exactly once, then reset. Cancel/close resolves null (no retry happens).
  const finish = (value: string | null) => {
    pending?.resolve(value);
    setPending(null);
    setReason('');
  };

  const trimmed = reason.trim();
  return (
    <Dialog open={pending != null} onOpenChange={(o) => { if (!o) finish(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('sme.reason_title')}</DialogTitle>
          {pending?.msg ? <DialogDescription>{pending.msg}</DialogDescription> : null}
        </DialogHeader>
        <div className="grid gap-1">
          <textarea
            className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            maxLength={MAX_REASON_LEN}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('sme.reason_ph')}
            autoFocus
          />
          <div className="text-right text-xs text-muted-foreground">{`${reason.length}/${MAX_REASON_LEN}`}</div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => finish(null)}>{t('sme.reason_cancel')}</Button>
          <Button disabled={!trimmed} onClick={() => finish(trimmed)}>{t('sme.reason_confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
