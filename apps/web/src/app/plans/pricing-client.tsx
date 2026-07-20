'use client';

// Public pricing & module configurator (/plans) — the buying-experience surface for prospects:
// 5 tiered starter packs + à-la-carte add-ons + a monthly/annual toggle with a live itemized total.
// Prices are indicative THB aligned with the seeded plans (billing.service.ts SEED_PLANS): Essential/
// Growth/Scale map to starter(Standard)/business/pro; Franchise and the Enterprise starting-at price
// have no seeded plan. Annual = 10 × monthly ("2 months free"), the same policy as every seeded
// priceYearly. The SoD feature line states the real 23-rule registry (permissions.ts SOD_RULES).
// Static page data by design (no API surface) — see docs/user-manual/00-getting-started.md §0.
import * as React from 'react';
import Link from 'next/link';
import {
  ArrowLeftRight, BarChart3, Bike, BookOpenCheck, Boxes, Building2, CalendarRange, Check, ChefHat,
  ChevronUp, Factory, FileCheck2, FlaskConical, Gift, Handshake, KeyRound, LayoutDashboard, Network,
  Percent, Phone, QrCode, Share2, ShieldCheck, Sparkles, Store, TrendingUp, Truck, UserCog, Users,
  Webhook,
} from 'lucide-react';
import { useLang } from '@/lib/i18n';

type IconType = React.ComponentType<{ className?: string }>;
type Billing = 'monthly' | 'annual';
/** 'pos' = front-of-house POS module (primary-tinted chip) · 'erp' = back-office ERP module (muted chip) */
type ModuleKind = 'pos' | 'erp';

interface TierFeature { key: string; icon: IconType; kind: ModuleKind }
interface Tier {
  id: string;
  /** Brand tier name — stays English in every locale. */
  name: string;
  audKey: string;
  icon: IconType;
  /** THB per month; annual billing charges 10 × monthly (2 months free). */
  priceMonthly: number;
  startingAt?: boolean;
  popular?: boolean;
  inherits?: string;
  features: TierFeature[];
}
interface Addon { id: string; nameKey: string; descKey: string; icon: IconType; kind: ModuleKind; priceMonthly: number }

/** Annual billing = pay 10 of 12 months (matches the seeded plans' priceYearly). */
const ANNUAL_MONTHS = 10;

const TIERS: Tier[] = [
  {
    id: 'essential', name: 'Essential', audKey: 'price.aud_essential', icon: Store, priceMonthly: 2900,
    features: [
      { key: 'price.f_pos', icon: Store, kind: 'pos' },
      { key: 'price.f_gl', icon: BookOpenCheck, kind: 'erp' },
      { key: 'price.f_inv', icon: Boxes, kind: 'erp' },
      { key: 'price.f_cashier', icon: UserCog, kind: 'pos' },
    ],
  },
  {
    id: 'growth', name: 'Growth', audKey: 'price.aud_growth', icon: TrendingUp, priceMonthly: 4900, popular: true, inherits: 'Essential',
    features: [
      { key: 'price.f_kds', icon: ChefHat, kind: 'pos' },
      { key: 'price.f_qr', icon: QrCode, kind: 'pos' },
      { key: 'price.f_delivery', icon: Bike, kind: 'pos' },
      { key: 'price.f_loyalty', icon: Gift, kind: 'pos' },
    ],
  },
  {
    id: 'scale', name: 'Scale', audKey: 'price.aud_scale', icon: Factory, priceMonthly: 9900, inherits: 'Growth',
    features: [
      { key: 'price.f_mfg', icon: Factory, kind: 'erp' },
      { key: 'price.f_proc', icon: Handshake, kind: 'erp' },
      { key: 'price.f_mrp', icon: CalendarRange, kind: 'erp' },
      { key: 'price.f_bi', icon: BarChart3, kind: 'erp' },
      { key: 'price.f_hr', icon: Users, kind: 'erp' },
    ],
  },
  {
    id: 'franchise', name: 'Franchise', audKey: 'price.aud_franchise', icon: Network, priceMonthly: 14900, inherits: 'Scale',
    features: [
      { key: 'price.f_brand', icon: Network, kind: 'erp' },
      { key: 'price.f_interco', icon: ArrowLeftRight, kind: 'erp' },
      { key: 'price.f_royalty', icon: Percent, kind: 'erp' },
      { key: 'price.f_fportal', icon: LayoutDashboard, kind: 'erp' },
    ],
  },
  {
    id: 'enterprise', name: 'Enterprise', audKey: 'price.aud_enterprise', icon: Building2, priceMonthly: 19900, startingAt: true, inherits: 'Franchise',
    features: [
      { key: 'price.f_consol', icon: Building2, kind: 'erp' },
      { key: 'price.f_sso', icon: KeyRound, kind: 'erp' },
      { key: 'price.f_sod', icon: ShieldCheck, kind: 'erp' },
      { key: 'price.f_etax', icon: FileCheck2, kind: 'erp' },
    ],
  },
];

const ADDONS: Addon[] = [
  { id: 'supply-chain', nameKey: 'price.a_scm', descKey: 'price.a_scm_d', icon: Truck, kind: 'erp', priceMonthly: 1500 },
  { id: 'webhooks', nameKey: 'price.a_webhook', descKey: 'price.a_webhook_d', icon: Webhook, kind: 'erp', priceMonthly: 990 },
  { id: 'cdp-sync', nameKey: 'price.a_cdp', descKey: 'price.a_cdp_d', icon: Share2, kind: 'erp', priceMonthly: 1290 },
  { id: 'sandbox', nameKey: 'price.a_sandbox', descKey: 'price.a_sandbox_d', icon: FlaskConical, kind: 'erp', priceMonthly: 2900 },
];

/** Effective per-month price under the active billing interval. */
const perMonth = (monthly: number, billing: Billing): number =>
  billing === 'annual' ? (monthly * ANNUAL_MONTHS) / 12 : monthly;

function ModuleChip({ icon: Icon, kind }: { icon: IconType; kind: ModuleKind }) {
  const styles = kind === 'pos' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${styles}`}>
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

export function PricingClient() {
  const { t, lang, setLang, fmtNumber } = useLang();
  const [billing, setBilling] = React.useState<Billing>('monthly');
  const [tierId, setTierId] = React.useState<string>('growth');
  const [addonIds, setAddonIds] = React.useState<Set<string>>(new Set());
  const [mobileOpen, setMobileOpen] = React.useState(false);

  const baht = React.useCallback((n: number) => `฿${fmtNumber(Math.round(n), { maximumFractionDigits: 0 })}`, [fmtNumber]);
  const toggleAddon = (id: string) =>
    setAddonIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const totals = React.useMemo(() => {
    const tier = TIERS.find((x) => x.id === tierId) ?? (TIERS[0] as Tier);
    const selectedAddons = ADDONS.filter((a) => addonIds.has(a.id));
    const monthlySum = tier.priceMonthly + selectedAddons.reduce((s, a) => s + a.priceMonthly, 0);
    return {
      tier,
      selectedAddons,
      monthlyEq: perMonth(monthlySum, billing),
      billedNow: billing === 'annual' ? monthlySum * ANNUAL_MONTHS : monthlySum,
      annualSavings: billing === 'annual' ? monthlySum * (12 - ANNUAL_MONTHS) : 0,
    };
  }, [tierId, addonIds, billing]);

  const summaryLines = (
    <>
      <ul className="space-y-2 text-sm">
        <li className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">
            {t('price.plan_line', { name: totals.tier.name })}
            {totals.tier.startingAt && <span className="text-muted-foreground/70"> {t('price.starting_at_paren')}</span>}
          </span>
          <span className="font-medium">{baht(perMonth(totals.tier.priceMonthly, billing))}{t('price.per_month')}</span>
        </li>
        {totals.selectedAddons.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-3">
            <span className="truncate text-muted-foreground">{t(a.nameKey)}</span>
            <span className="shrink-0 font-medium">{baht(perMonth(a.priceMonthly, billing))}{t('price.per_month')}</span>
          </li>
        ))}
        {billing === 'annual' && (
          <li className="flex items-center justify-between gap-3 text-emerald-600 dark:text-emerald-400">
            <span className="flex items-center gap-1 font-medium"><Sparkles className="h-3.5 w-3.5" /> {t('price.annual_savings')}</span>
            <span className="font-semibold">− {baht(totals.annualSavings)}/{lang === 'en' ? 'yr' : 'ปี'}</span>
          </li>
        )}
      </ul>
      <div className="mt-4 border-t pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-semibold">{t('price.total')}</span>
          <span className="text-2xl font-extrabold tracking-tight">
            {baht(totals.monthlyEq)}<span className="text-sm font-medium text-muted-foreground">{t('price.per_month')}</span>
          </span>
        </div>
        <div className="mt-1 text-right text-xs text-muted-foreground">
          {billing === 'annual' ? t('price.billed_annually_as', { amount: baht(totals.billedNow) }) : t('price.billed_monthly')}
        </div>
      </div>
      <Link
        href="/signup"
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground shadow transition-opacity hover:opacity-90"
      >
        {totals.tier.startingAt ? (<><Phone className="h-4 w-4" /> {t('price.contact_sales')}</>) : t('price.start_trial')}
      </Link>
      <p className="mt-3 text-center text-[11px] leading-relaxed text-muted-foreground">
        {t('price.disclaimer')}{totals.tier.startingAt && <> {t('price.enterprise_note')}</>}
      </p>
    </>
  );

  return (
    <div className="min-h-screen bg-background pb-44 text-foreground antialiased lg:pb-12">
      <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        {/* ------- Header ------- */}
        <header className="mx-auto max-w-2xl text-center">
          <div className="flex items-center justify-center gap-2 text-xs">
            {(['th', 'en'] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                aria-pressed={lang === l}
                className={`rounded-full px-2.5 py-0.5 font-medium transition-colors ${lang === l ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {l === 'th' ? 'ไทย' : 'EN'}
              </button>
            ))}
          </div>
          <div className="mt-3 text-xs font-semibold uppercase tracking-widest text-primary">{t('price.eyebrow')}</div>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">{t('price.title')}</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{t('price.subtitle')}</p>
          <div className="mt-6 flex flex-col items-center gap-2">
            <div className="inline-flex items-center rounded-full border bg-card p-1 shadow-sm" role="tablist" aria-label={t('price.monthly') + ' / ' + t('price.annual')}>
              {(['monthly', 'annual'] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  role="tab"
                  aria-selected={billing === b}
                  onClick={() => setBilling(b)}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${billing === b ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {t(b === 'monthly' ? 'price.monthly' : 'price.annual')}
                </button>
              ))}
            </div>
            <span
              className={`inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 transition-opacity dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900 ${billing === 'annual' ? 'opacity-100' : 'opacity-60'}`}
            >
              <Sparkles className="h-3 w-3" />
              {t('price.annual_badge')}
            </span>
          </div>
        </header>

        {/* ------- Tier cards ------- */}
        <section aria-label={t('price.packs')} className="mt-10">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold">{t('price.packs')}</h2>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-primary" /> {t('price.legend_pos')}</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-muted-foreground/50" /> {t('price.legend_erp')}</span>
            </div>
          </div>
          <div role="radiogroup" aria-label={t('price.packs')} className="grid grid-cols-1 gap-4 pt-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {TIERS.map((tier) => {
              const HeaderIcon = tier.icon;
              const selected = tierId === tier.id;
              const monthlyEq = perMonth(tier.priceMonthly, billing);
              return (
                <button
                  key={tier.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setTierId(tier.id)}
                  className={`relative flex h-full flex-col rounded-2xl border bg-card p-5 text-left shadow-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'border-primary ring-2 ring-primary' : 'hover:border-primary/40 hover:shadow-md'}`}
                >
                  {tier.popular && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-3 py-0.5 text-xs font-semibold text-primary-foreground shadow">
                      {t('price.most_popular')}
                    </span>
                  )}
                  <div className="flex items-center gap-2.5">
                    <span className={`inline-flex h-9 w-9 items-center justify-center rounded-xl ${selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                      <HeaderIcon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-bold">{tier.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{t(tier.audKey)}</div>
                    </div>
                  </div>
                  <div className="mt-4">
                    {tier.startingAt && <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{t('price.starting_at')}</div>}
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-2xl font-extrabold tracking-tight">{baht(monthlyEq)}</span>
                      <span className="text-xs text-muted-foreground">{t('price.per_month')}</span>
                    </div>
                    {billing === 'annual' ? (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        <s className="text-muted-foreground/60">{baht(tier.priceMonthly)}{t('price.per_month')}</s>{' '}
                        <span className="font-medium text-emerald-600 dark:text-emerald-400">{t('price.billed_yearly', { amount: baht(tier.priceMonthly * ANNUAL_MONTHS) })}</span>
                      </div>
                    ) : (
                      <div className="mt-0.5 text-xs text-muted-foreground/70">{t('price.billed_monthly')}</div>
                    )}
                  </div>
                  <ul className="mt-4 flex-1 space-y-2.5 border-t pt-4">
                    {tier.inherits && (
                      <li className="flex items-center gap-2 text-xs font-semibold text-primary">
                        <Check className="h-3.5 w-3.5 shrink-0" />
                        {t('price.everything_in', { tier: tier.inherits })}
                      </li>
                    )}
                    {tier.features.map((f) => (
                      <li key={f.key} className="flex items-start gap-2">
                        <ModuleChip icon={f.icon} kind={f.kind} />
                        <span className="text-xs leading-6">{t(f.key)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className={`mt-4 rounded-lg py-2 text-center text-sm font-semibold ${selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                    {t(selected ? 'price.selected' : 'price.choose')}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* ------- Add-ons + summary ------- */}
        <section className="mt-12 grid grid-cols-1 gap-8 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <h2 className="text-lg font-bold">{t('price.addons_title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('price.addons_sub')}</p>
            <div className="mt-4 space-y-3">
              {ADDONS.map((addon) => {
                const checked = addonIds.has(addon.id);
                return (
                  <div key={addon.id} className={`flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition-colors ${checked ? 'border-primary/50 ring-1 ring-primary/30' : ''}`}>
                    <ModuleChip icon={addon.icon} kind={addon.kind} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold">{t(addon.nameKey)}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{t(addon.descKey)}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-bold">{baht(perMonth(addon.priceMonthly, billing))}</div>
                      <div className="text-[11px] text-muted-foreground/70">{t('price.per_month')}</div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={checked}
                      aria-label={t(addon.nameKey)}
                      onClick={() => toggleAddon(addon.id)}
                      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${checked ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                    >
                      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-card shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="mt-8 text-sm">
              <Link href="/login" className="font-medium text-primary hover:underline">{t('price.back_to_login')}</Link>
            </p>
          </div>

          {/* Desktop: sticky summary card */}
          <aside className="hidden lg:block">
            <div className="sticky top-6 rounded-2xl border bg-card p-6 shadow-lg">
              <h3 className="text-base font-bold">{t('price.summary_title')}</h3>
              <p className="mb-4 mt-0.5 text-xs text-muted-foreground">{t(billing === 'annual' ? 'price.summary_annual' : 'price.summary_monthly')}</p>
              {summaryLines}
            </div>
          </aside>
        </section>
      </div>

      {/* Mobile: fixed bottom summary bar */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.35)] backdrop-blur lg:hidden">
        {mobileOpen && (
          <div className="max-h-[50vh] overflow-y-auto border-b px-4 pb-2 pt-4">{summaryLines}</div>
        )}
        <button
          type="button"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        >
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">
              {totals.tier.name}
              {totals.selectedAddons.length > 0 && ` ${t('price.addon_count', { n: totals.selectedAddons.length })}`}
              {billing === 'annual' && ` · ${t('price.annual_short')}`}
            </div>
            <div className="text-lg font-extrabold tracking-tight">
              {baht(totals.monthlyEq)}
              <span className="text-xs font-medium text-muted-foreground">{t('price.per_month')}{totals.tier.startingAt ? ` · ${t('price.starting_at')}` : ''}</span>
            </div>
          </div>
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground">
            {t(mobileOpen ? 'price.hide' : 'price.details')}
            <ChevronUp className={`h-3.5 w-3.5 transition-transform ${mobileOpen ? 'rotate-180' : ''}`} />
          </span>
        </button>
      </div>
    </div>
  );
}
