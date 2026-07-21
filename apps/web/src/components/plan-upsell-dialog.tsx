// Plan/entitlement upsell dialog (wave B2) — when the API denies a request with a plan-level code
// (SUITE_NOT_ENTITLED / PLAN_FEATURE_REQUIRED / TRIAL_EXPIRED / SUBSCRIPTION_INACTIVE /
// SUBSCRIPTION_PASTDUE_READONLY), lib/api dispatches an `ierp:plan-denied` CustomEvent and this dialog
// turns the bare 403 into an actionable upgrade path (CTA → /billing, internal variant only — the portal
// has no billing page, so it shows the message without the CTA).
// NO 'use client' directive on purpose: imported only from app-shell.tsx (already a client file), so it
// inherits the client boundary — adding the directive would trip the check-use-client ratchet.
// Noise control: while the dialog is open further events are ignored, and after a dismiss the SAME code
// stays quiet for a cooldown (parallel queries on one screen can all 403 at once — one dialog, not five).

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

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

const DISMISS_COOLDOWN_MS = 60_000;

interface DeniedDetail { code: string; message: string }

export function PlanUpsellDialog({ showBillingCta }: { showBillingCta: boolean }) {
  const { t } = useLang();
  const router = useRouter();
  const [denied, setDenied] = useState<DeniedDetail | null>(null);
  // Ref mirrors so the (mount-once) listener sees live state without re-subscribing.
  const openRef = useRef<boolean>(false);
  openRef.current = denied != null;
  const dismissedRef = useRef<{ code: string; at: number } | null>(null);

  useEffect(() => {
    const onDenied = (e: Event) => {
      const detail = (e as CustomEvent<DeniedDetail>).detail;
      if (!detail?.code || openRef.current) return;
      const d = dismissedRef.current;
      if (d && d.code === detail.code && Date.now() - d.at < DISMISS_COOLDOWN_MS) return;
      setDenied(detail);
    };
    window.addEventListener('ierp:plan-denied', onDenied);
    return () => window.removeEventListener('ierp:plan-denied', onDenied);
  }, []);

  const close = () => {
    if (denied) dismissedRef.current = { code: denied.code, at: Date.now() };
    setDenied(null);
  };

  return (
    <Dialog open={denied != null} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('plan.upsell_title')}</DialogTitle>
          {denied?.message ? <DialogDescription>{denied.message}</DialogDescription> : null}
        </DialogHeader>
        {showBillingCta && <p className="text-sm text-muted-foreground">{t('plan.upsell_hint')}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={close}>{t('plan.upsell_dismiss')}</Button>
          {showBillingCta && (
            <Button onClick={() => { close(); router.push('/billing'); }}>{t('plan.upsell_cta')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
