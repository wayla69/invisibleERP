'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Loader2, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { LanguageToggle } from '@/components/language-toggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function SignupPage() {
  const { t } = useLang();
  const [f, setF] = useState({ company_name: '', tenant_code: '', admin_username: '', admin_password: '', email: '', industry: 'restaurant' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // Pack selection carried over from the public /plans configurator (?plan=&billing=&addons=), shown
  // back to the prospect and forwarded on the request so the platform admin sees it at approval.
  // Read via window.location.search in an effect (the useSearchParams hook would force a Suspense
  // boundary at prerender — same pattern as the SSO callback); unknown values are dropped.
  const [requested, setRequested] = useState<{ plan?: string; billing?: 'monthly' | 'annual'; addons: string[] }>({ addons: [] });
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const KNOWN_PLANS = ['essential', 'growth', 'scale', 'franchise', 'enterprise'];
    const KNOWN_ADDONS = ['scm_advanced', 'integrations', 'cdp', 'sandbox'];
    const plan = q.get('plan') ?? '';
    const billing = q.get('billing');
    setRequested({
      plan: KNOWN_PLANS.includes(plan) ? plan : undefined,
      billing: billing === 'annual' || billing === 'monthly' ? billing : undefined,
      addons: (q.get('addons') ?? '').split(',').filter((a) => KNOWN_ADDONS.includes(a)),
    });
  }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // Company creation is reserved to the platform owner (ITGC-AC-18). The public path submits a
      // request that the platform owner reviews and approves — no company is created here.
      await api('/api/auth/signup-requests', {
        method: 'POST',
        body: JSON.stringify({
          ...f,
          ...(requested.plan
            ? { requested_plan: requested.plan, requested_billing: requested.billing ?? 'monthly', requested_addons: requested.addons }
            : {}),
        }),
      });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.su_failed'));
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <main className="relative grid min-h-svh place-items-center overflow-hidden bg-muted/30 p-5">
        <div className="pointer-events-none absolute -top-24 -right-24 size-96 rounded-full bg-primary/5 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-24 size-96 rounded-full bg-primary/5 blur-3xl" />
        <Card className="w-full max-w-md gap-0 p-8 text-center shadow-lg">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400">
            <CheckCircle2 className="size-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{t('auth.su_done_title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('auth.su_done_body', { company: f.company_name, user: f.admin_username })}
          </p>
          <Link href="/login" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">
            {t('auth.back_to_login')}
          </Link>
        </Card>
      </main>
    );
  }

  return (
    <main className="relative grid min-h-svh place-items-center overflow-hidden bg-muted/30 p-5">
      <div className="pointer-events-none absolute -top-24 -right-24 size-96 rounded-full bg-primary/5 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-24 size-96 rounded-full bg-primary/5 blur-3xl" />
      <div className="absolute top-4 right-4"><LanguageToggle /></div>

      <Card className="w-full max-w-md gap-0 p-8 shadow-lg">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground shadow-sm">
            IE
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{t('auth.su_title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('auth.su_subtitle')}</p>
          {requested.plan && (
            <p className="mt-3 inline-flex flex-wrap items-center justify-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              {t('auth.su_requested')}: <span className="font-semibold capitalize">{requested.plan}</span>
              {' · '}{t(requested.billing === 'annual' ? 'price.annual' : 'price.monthly')}
              {requested.addons.length > 0 && <> · {t('price.addon_count', { n: requested.addons.length })}</>}
            </p>
          )}
        </div>

        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="company_name">{t('auth.su_company')}</Label>
            <Input id="company_name" value={f.company_name} onChange={set('company_name')} placeholder={t('auth.su_company_ph')} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="industry">{t('auth.su_industry')}</Label>
            <select
              id="industry"
              value={f.industry}
              onChange={set('industry')}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            >
              <option value="restaurant">{t('auth.su_ind_restaurant')}</option>
              <option value="retail">{t('auth.su_ind_retail')}</option>
              <option value="distribution">{t('auth.su_ind_distribution')}</option>
              <option value="services">{t('auth.su_ind_services')}</option>
              <option value="manufacturing">{t('auth.su_ind_manufacturing')}</option>
              <option value="construction">{t('auth.su_ind_construction')}</option>
              <option value="ecommerce">{t('auth.su_ind_ecommerce')}</option>
              <option value="hospitality">{t('auth.su_ind_hospitality')}</option>
              <option value="healthcare">{t('auth.su_ind_healthcare')}</option>
              <option value="professional">{t('auth.su_ind_professional')}</option>
              <option value="agriculture">{t('auth.su_ind_agriculture')}</option>
              <option value="automotive">{t('auth.su_ind_automotive')}</option>
              <option value="logistics">{t('auth.su_ind_logistics')}</option>
              <option value="education">{t('auth.su_ind_education')}</option>
              <option value="nonprofit">{t('auth.su_ind_nonprofit')}</option>
              <option value="realestate">{t('auth.su_ind_realestate')}</option>
              <option value="general">{t('auth.su_ind_general')}</option>
            </select>
            <p className="text-xs text-muted-foreground">{t('auth.su_industry_hint')}</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tenant_code">{t('auth.su_code')}</Label>
            <Input id="tenant_code" value={f.tenant_code} onChange={set('tenant_code')} placeholder="invisible" autoCapitalize="none" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="email">{t('auth.su_email')}</Label>
            <Input id="email" type="email" value={f.email} onChange={set('email')} placeholder="you@email.com" required />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="admin_username">{t('auth.su_admin_user')}</Label>
              <Input id="admin_username" value={f.admin_username} onChange={set('admin_username')} autoComplete="username" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="admin_password">{t('auth.password')}</Label>
              <PasswordInput id="admin_password" value={f.admin_password} onChange={set('admin_password')} autoComplete="new-password" minLength={8} required />
            </div>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {loading ? t('auth.su_sending') : t('auth.su_submit')}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {t('auth.su_terms_pre')}{' '}
            <Link href="/legal/privacy" className="underline hover:text-primary" target="_blank">
              {t('auth.su_privacy')}
            </Link>{' '}
            {t('auth.su_terms_post')}
          </p>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          {t('auth.su_have_account')}{' '}
          <Link href="/login" className="font-medium text-primary hover:underline">
            {t('auth.sign_in')}
          </Link>
          {' · '}
          <Link href="/plans" className="font-medium text-primary hover:underline">
            {t('auth.pricing_link')}
          </Link>
        </p>
      </Card>
    </main>
  );
}
