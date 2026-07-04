// No 'use client' directive needed: rendered only by the client dashboard page, so it is already
// part of that client subgraph (keeps the RSC-ratchet count honest — docs/28 §4).
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Rocket } from 'lucide-react';

import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Step = { key: string; label: string; label_en: string; done: boolean };
type Status = { steps: Step[]; percent: number; installed_packs: string[] };

/**
 * "เริ่มต้นใช้งาน" — a first-run guidance panel for the dashboard. It surfaces the (already-existing)
 * onboarding checklist (`GET /api/onboarding`) right where a new tenant lands, so the currently-buried
 * `/onboarding` + per-task screens are one click away instead of a menu hunt. Each incomplete step
 * deep-links to the screen where it gets done, and can be ticked off in place (reusing the existing
 * `POST /api/onboarding/steps/:key/complete`).
 *
 * Self-hides when: the onboarding query 403s for a user without the right (`retry:false` → `data`
 * undefined, same pattern as `today-actions`), setup is already 100% complete, or nothing is pending —
 * so it never nags an established tenant and adds no permission logic. Reuses existing endpoints only.
 */

// Each onboarding step → the screen where it gets done. Keys mirror the API's STEPS list
// (apps/api/src/modules/onboarding/onboarding.service.ts). Unknown keys fall back to /onboarding.
const STEP_HREF: Record<string, string> = {
  branding: '/setup',
  theme: '/theme',
  locale: '/localization',
  first_product: '/master-data',
  first_sale: '/pos/register',
  invite_user: '/admin/users',
};

export function GettingStarted() {
  const qc = useQueryClient();
  const { t, lang } = useLang();
  const status = useQuery<Status>({ queryKey: ['onboarding'], queryFn: () => api('/api/onboarding'), retry: false });
  const complete = useMutation({
    mutationFn: (key: string) => api(`/api/onboarding/steps/${key}/complete`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['onboarding'] }),
  });

  const data = status.data;
  // Guard against a missing/partial payload (loading, 403, or an unexpected shape) — never crash the
  // dashboard: only render once we have a real steps array and we're not already complete.
  if (!data || !Array.isArray(data.steps) || data.percent >= 100) return null; // no access / loading / already done
  const pending = data.steps.filter((s) => !s.done);
  if (pending.length === 0) return null;
  const stepLabel = (s: Step) => (lang === 'th' ? s.label : s.label_en || s.label);

  return (
    <Card className="mb-6 border-primary/30 bg-primary/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <Rocket className="size-4 text-primary" /> {t('getstarted.title')}
          </span>
          <span className="text-xs font-normal text-muted-foreground">{t('getstarted.percent_done', { p: data.percent })}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-4 h-1.5 rounded bg-primary/20">
          <div className="h-1.5 rounded bg-primary transition-all" style={{ width: `${data.percent}%` }} />
        </div>
        <ul className="grid gap-2 sm:grid-cols-2">
          {pending.map((s) => (
            <li key={s.key} className="flex items-center gap-2 rounded-lg border bg-background p-2">
              <button
                type="button"
                onClick={() => complete.mutate(s.key)}
                disabled={complete.isPending}
                aria-label={t('getstarted.mark_done_x', { label: stepLabel(s) })}
                title={t('getstarted.mark_done')}
                className="size-5 shrink-0 rounded border outline-none hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              />
              <Link
                href={STEP_HREF[s.key] ?? '/onboarding'}
                className="group flex flex-1 items-center justify-between gap-2 rounded text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>{stepLabel(s)}</span>
                <ArrowRight className="size-3.5 text-muted-foreground group-hover:text-primary" />
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-3 text-right">
          <Link href="/onboarding" className="text-xs text-primary hover:underline">
            {t('getstarted.see_all')}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
