/**
 * Invisible ERP — Pricing & Module Configurator (single-file prototype)
 *
 * A self-contained, artifact-ready React component: React + Tailwind CSS classes +
 * lucide-react icons only. Default export renders the full configurator.
 *
 * Content grounding (see README.md in this folder):
 * - Tier prices align with the seeded SaaS plans in
 *   apps/api/src/modules/billing/billing.service.ts (annual = 10 × monthly, "2 months free").
 * - Module names follow packages/shared/src/entitlements.ts suite labels.
 * - The SoD count (23 rules) matches packages/shared/src/permissions.ts SOD_RULES.
 * - The Franchise tier and all add-on prices are indicative (no seeded plan yet).
 */
import { useMemo, useState } from 'react';
import {
  ArrowLeftRight,
  BarChart3,
  Bike,
  BookOpenCheck,
  Boxes,
  Building2,
  CalendarRange,
  Check,
  ChefHat,
  ChevronUp,
  Factory,
  FileCheck2,
  FlaskConical,
  Gift,
  Handshake,
  KeyRound,
  LayoutDashboard,
  Network,
  Percent,
  Phone,
  QrCode,
  Share2,
  ShieldCheck,
  Sparkles,
  Store,
  TrendingUp,
  Truck,
  UserCog,
  Users,
  Webhook,
} from 'lucide-react';

type IconType = React.ComponentType<{ className?: string }>;
type Billing = 'monthly' | 'annual';
/** 'pos' = front-of-house POS module (indigo chip) · 'erp' = back-office ERP module (slate chip) */
type ModuleKind = 'pos' | 'erp';

interface TierFeature {
  label: string;
  icon: IconType;
  kind: ModuleKind;
}

interface Tier {
  id: string;
  name: string;
  audience: string;
  icon: IconType;
  /** THB per month; annual billing charges 10 × monthly (2 months free). */
  priceMonthly: number;
  startingAt?: boolean;
  popular?: boolean;
  inherits?: string;
  features: TierFeature[];
}

interface Addon {
  id: string;
  name: string;
  description: string;
  icon: IconType;
  kind: ModuleKind;
  priceMonthly: number;
}

/** Annual billing = pay 10 of 12 months (matches the seeded plans' priceYearly). */
const ANNUAL_MONTHS = 10;

const TIERS: Tier[] = [
  {
    id: 'essential',
    name: 'Essential',
    audience: 'Single branch',
    icon: Store,
    priceMonthly: 2900,
    features: [
      { label: 'Basic POS', icon: Store, kind: 'pos' },
      { label: 'Standard Ledger (GL)', icon: BookOpenCheck, kind: 'erp' },
      { label: 'Basic Inventory', icon: Boxes, kind: 'erp' },
      { label: 'Cashier Role', icon: UserCog, kind: 'pos' },
    ],
  },
  {
    id: 'growth',
    name: 'Growth',
    audience: 'Multi-branch',
    icon: TrendingUp,
    priceMonthly: 4900,
    popular: true,
    inherits: 'Essential',
    features: [
      { label: 'Kitchen Display System (KDS)', icon: ChefHat, kind: 'pos' },
      { label: 'Diner QR Ordering', icon: QrCode, kind: 'pos' },
      { label: 'Delivery & Marketplace Integrations', icon: Bike, kind: 'pos' },
      { label: 'Customer Loyalty Portal', icon: Gift, kind: 'pos' },
    ],
  },
  {
    id: 'scale',
    name: 'Scale',
    audience: 'Central kitchen & ops',
    icon: Factory,
    priceMonthly: 9900,
    inherits: 'Growth',
    features: [
      { label: 'Central Kitchen & Manufacturing', icon: Factory, kind: 'erp' },
      { label: 'Advanced Procurement & Supplier Scorecards', icon: Handshake, kind: 'erp' },
      { label: 'Planning, MRP & Forecasting', icon: CalendarRange, kind: 'erp' },
      { label: 'BI Dashboards & Scheduled Reports', icon: BarChart3, kind: 'erp' },
      { label: 'HR & Payroll', icon: Users, kind: 'erp' },
    ],
  },
  {
    id: 'franchise',
    name: 'Franchise',
    audience: 'Multi-brand',
    icon: Network,
    priceMonthly: 14900,
    inherits: 'Scale',
    features: [
      { label: 'Multi-Brand & Franchise Management', icon: Network, kind: 'erp' },
      { label: 'Intercompany Transactions', icon: ArrowLeftRight, kind: 'erp' },
      { label: 'Royalty & Fee Billing', icon: Percent, kind: 'erp' },
      { label: 'Franchisee Portal & Branch Benchmarking', icon: LayoutDashboard, kind: 'erp' },
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    audience: 'Corporate',
    icon: Building2,
    priceMonthly: 19900,
    startingAt: true,
    inherits: 'Franchise',
    features: [
      { label: 'Multi-tenant Consolidation', icon: Building2, kind: 'erp' },
      { label: 'Enterprise SSO (SAML / OIDC)', icon: KeyRound, kind: 'erp' },
      { label: '23 Segregation-of-Duty (SoD) Rules', icon: ShieldCheck, kind: 'erp' },
      { label: 'National e-Tax Integration', icon: FileCheck2, kind: 'erp' },
    ],
  },
];

const ADDONS: Addon[] = [
  {
    id: 'supply-chain',
    name: 'Advanced Supply Chain & Procurement Routing',
    description: 'RFQs, three-way match holds, sourcing suggestions and approval routing.',
    icon: Truck,
    kind: 'erp',
    priceMonthly: 1500,
  },
  {
    id: 'webhooks',
    name: 'Inbound Webhook for Chat / CRM Integration',
    description: 'HMAC-signed inbound webhooks to capture leads and chat orders into CRM.',
    icon: Webhook,
    kind: 'erp',
    priceMonthly: 990,
  },
  {
    id: 'cdp-sync',
    name: 'Ad-network Audience Export (CDP Sync)',
    description: 'PDPA-aware audience segments exported to ad networks and CDPs.',
    icon: Share2,
    kind: 'erp',
    priceMonthly: 1290,
  },
  {
    id: 'sandbox',
    name: 'Dedicated Sandbox / Staging Environment',
    description: 'An isolated environment with API keys for integration testing.',
    icon: FlaskConical,
    kind: 'erp',
    priceMonthly: 2900,
  },
];

const thb = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 0 });
const baht = (n: number): string => `฿${thb.format(Math.round(n))}`;

/** Effective per-month price under the active billing interval. */
const perMonth = (monthly: number, billing: Billing): number =>
  billing === 'annual' ? (monthly * ANNUAL_MONTHS) / 12 : monthly;

function ModuleChip({ icon: Icon, kind }: { icon: IconType; kind: ModuleKind }) {
  const styles =
    kind === 'pos'
      ? 'bg-indigo-50 text-indigo-600 ring-indigo-100'
      : 'bg-slate-100 text-slate-600 ring-slate-200';
  return (
    <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 ${styles}`}>
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function BillingToggle({ billing, onChange }: { billing: Billing; onChange: (b: Billing) => void }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="inline-flex items-center rounded-full border border-slate-200 bg-white p-1 shadow-sm" role="tablist" aria-label="Billing interval">
        {(['monthly', 'annual'] as const).map((b) => (
          <button
            key={b}
            type="button"
            role="tab"
            aria-selected={billing === b}
            onClick={() => onChange(b)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              billing === b ? 'bg-indigo-600 text-white shadow' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {b === 'monthly' ? 'Monthly' : 'Annual'}
          </button>
        ))}
      </div>
      <span
        className={`inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 transition-opacity ${
          billing === 'annual' ? 'opacity-100' : 'opacity-60'
        }`}
      >
        <Sparkles className="h-3 w-3" />
        Annual billing: 2 months free (save ~17%)
      </span>
    </div>
  );
}

function TierCard({ tier, billing, selected, onSelect }: { tier: Tier; billing: Billing; selected: boolean; onSelect: () => void }) {
  const HeaderIcon = tier.icon;
  const monthlyEq = perMonth(tier.priceMonthly, billing);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`relative flex h-full flex-col rounded-2xl border bg-white p-5 text-left shadow-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
        selected
          ? 'border-indigo-600 ring-2 ring-indigo-600'
          : 'border-slate-200 hover:border-indigo-300 hover:shadow-md'
      }`}
    >
      {tier.popular && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-indigo-600 px-3 py-0.5 text-xs font-semibold text-white shadow">
          Most popular
        </span>
      )}
      <div className="flex items-center gap-2.5">
        <span className={`inline-flex h-9 w-9 items-center justify-center rounded-xl ${selected ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
          <HeaderIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-bold text-slate-900">{tier.name}</div>
          <div className="truncate text-xs text-slate-500">{tier.audience}</div>
        </div>
      </div>

      <div className="mt-4">
        {tier.startingAt && <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">starting at</div>}
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-extrabold tracking-tight text-slate-900">{baht(monthlyEq)}</span>
          <span className="text-xs text-slate-500">/mo</span>
        </div>
        {billing === 'annual' ? (
          <div className="mt-0.5 text-xs text-slate-500">
            <s className="text-slate-400">{baht(tier.priceMonthly)}/mo</s>{' '}
            <span className="font-medium text-emerald-600">billed {baht(tier.priceMonthly * ANNUAL_MONTHS)}/yr</span>
          </div>
        ) : (
          <div className="mt-0.5 text-xs text-slate-400">billed monthly</div>
        )}
      </div>

      <ul className="mt-4 flex-1 space-y-2.5 border-t border-slate-100 pt-4">
        {tier.inherits && (
          <li className="flex items-center gap-2 text-xs font-semibold text-indigo-700">
            <Check className="h-3.5 w-3.5 shrink-0" />
            Everything in {tier.inherits}, plus
          </li>
        )}
        {tier.features.map((f) => (
          <li key={f.label} className="flex items-start gap-2">
            <ModuleChip icon={f.icon} kind={f.kind} />
            <span className="text-xs leading-6 text-slate-700">{f.label}</span>
          </li>
        ))}
      </ul>

      <div
        className={`mt-4 rounded-lg py-2 text-center text-sm font-semibold ${
          selected ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'
        }`}
      >
        {selected ? 'Selected' : 'Choose plan'}
      </div>
    </button>
  );
}

function AddonRow({ addon, billing, checked, onToggle }: { addon: Addon; billing: Billing; checked: boolean; onToggle: () => void }) {
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border bg-white p-4 shadow-sm transition-colors ${
        checked ? 'border-indigo-300 ring-1 ring-indigo-200' : 'border-slate-200'
      }`}
    >
      <ModuleChip icon={addon.icon} kind={addon.kind} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-slate-900">{addon.name}</div>
        <div className="mt-0.5 text-xs text-slate-500">{addon.description}</div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-bold text-slate-900">{baht(perMonth(addon.priceMonthly, billing))}</div>
        <div className="text-[11px] text-slate-400">/mo</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={`Toggle ${addon.name}`}
        onClick={onToggle}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
          checked ? 'bg-indigo-600' : 'bg-slate-300'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`}
        />
      </button>
    </div>
  );
}

interface Totals {
  tier: Tier;
  selectedAddons: Addon[];
  monthlyEq: number;
  billedNow: number;
  annualSavings: number;
}

function SummaryLines({ totals, billing }: { totals: Totals; billing: Billing }) {
  return (
    <>
      <ul className="space-y-2 text-sm">
        <li className="flex items-center justify-between gap-3">
          <span className="text-slate-600">
            {totals.tier.name} plan
            {totals.tier.startingAt && <span className="text-slate-400"> (starting at)</span>}
          </span>
          <span className="font-medium text-slate-900">{baht(perMonth(totals.tier.priceMonthly, billing))}/mo</span>
        </li>
        {totals.selectedAddons.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-3">
            <span className="truncate text-slate-600">{a.name}</span>
            <span className="shrink-0 font-medium text-slate-900">{baht(perMonth(a.priceMonthly, billing))}/mo</span>
          </li>
        ))}
        {billing === 'annual' && (
          <li className="flex items-center justify-between gap-3 text-emerald-600">
            <span className="flex items-center gap-1 font-medium">
              <Sparkles className="h-3.5 w-3.5" /> Annual savings
            </span>
            <span className="font-semibold">− {baht(totals.annualSavings)}/yr</span>
          </li>
        )}
      </ul>
      <div className="mt-4 border-t border-slate-200 pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-semibold text-slate-700">Total estimated cost</span>
          <span className="text-2xl font-extrabold tracking-tight text-slate-900">
            {baht(totals.monthlyEq)}
            <span className="text-sm font-medium text-slate-500">/mo</span>
          </span>
        </div>
        <div className="mt-1 text-right text-xs text-slate-500">
          {billing === 'annual' ? <>billed annually as {baht(totals.billedNow)}/yr</> : <>billed monthly</>}
        </div>
      </div>
      {totals.tier.startingAt ? (
        <a
          href="#contact-sales"
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white shadow transition-colors hover:bg-indigo-700"
        >
          <Phone className="h-4 w-4" /> Contact sales for a quote
        </a>
      ) : (
        <a
          href="#start-trial"
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white shadow transition-colors hover:bg-indigo-700"
        >
          Start free trial
        </a>
      )}
      <p className="mt-3 text-center text-[11px] leading-relaxed text-slate-400">
        Prices are indicative, in Thai Baht (฿), excluding VAT.
        {totals.tier.startingAt && ' Enterprise pricing is customized to your fleet size.'}
      </p>
    </>
  );
}

export default function PricingConfigurator() {
  const [billing, setBilling] = useState<Billing>('monthly');
  const [tierId, setTierId] = useState<string>('growth');
  const [addonIds, setAddonIds] = useState<Set<string>>(new Set());
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleAddon = (id: string) =>
    setAddonIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const totals = useMemo<Totals>(() => {
    const tier = TIERS.find((t) => t.id === tierId) ?? (TIERS[0] as Tier);
    const selectedAddons = ADDONS.filter((a) => addonIds.has(a.id));
    const monthlySum = tier.priceMonthly + selectedAddons.reduce((s, a) => s + a.priceMonthly, 0);
    const monthlyEq = perMonth(monthlySum, billing);
    const billedNow = billing === 'annual' ? monthlySum * ANNUAL_MONTHS : monthlySum;
    const annualSavings = billing === 'annual' ? monthlySum * (12 - ANNUAL_MONTHS) : 0;
    return { tier, selectedAddons, monthlyEq, billedNow, annualSavings };
  }, [tierId, addonIds, billing]);

  return (
    <div className="min-h-screen bg-slate-50 pb-44 font-sans text-slate-900 antialiased lg:pb-12">
      <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        {/* ------- Header ------- */}
        <header className="mx-auto max-w-2xl text-center">
          <div className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Invisible ERP · F&amp;B Platform</div>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">Build your plan</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            Start with a pack that fits your operation today, then bolt on advanced modules as you grow —
            one platform from a single POS to a multi-brand franchise group.
          </p>
          <div className="mt-6">
            <BillingToggle billing={billing} onChange={setBilling} />
          </div>
        </header>

        {/* ------- Tier cards ------- */}
        <section aria-label="Starter packs" className="mt-10">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold">Starter packs</h2>
            <div className="flex items-center gap-4 text-xs text-slate-500">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-indigo-500" /> POS / front-of-house
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-slate-400" /> Back-office ERP
              </span>
            </div>
          </div>
          <div role="radiogroup" aria-label="Choose a starter pack" className="grid grid-cols-1 gap-4 pt-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {TIERS.map((tier) => (
              <TierCard key={tier.id} tier={tier} billing={billing} selected={tierId === tier.id} onSelect={() => setTierId(tier.id)} />
            ))}
          </div>
        </section>

        {/* ------- Add-ons + summary ------- */}
        <section className="mt-12 grid grid-cols-1 gap-8 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <h2 className="text-lg font-bold">Advanced add-ons</h2>
            <p className="mt-1 text-sm text-slate-500">À la carte modules — toggle them on and watch the total update.</p>
            <div className="mt-4 space-y-3">
              {ADDONS.map((addon) => (
                <AddonRow key={addon.id} addon={addon} billing={billing} checked={addonIds.has(addon.id)} onToggle={() => toggleAddon(addon.id)} />
              ))}
            </div>
          </div>

          {/* Desktop: sticky summary card */}
          <aside className="hidden lg:block">
            <div className="sticky top-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-lg shadow-slate-200/60">
              <h3 className="text-base font-bold">Your configuration</h3>
              <p className="mb-4 mt-0.5 text-xs text-slate-500">
                {billing === 'annual' ? 'Annual billing · 2 months free' : 'Monthly billing'}
              </p>
              <SummaryLines totals={totals} billing={billing} />
            </div>
          </aside>
        </section>
      </div>

      {/* Mobile: fixed bottom summary bar */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 shadow-[0_-8px_24px_-12px_rgba(15,23,42,0.25)] backdrop-blur lg:hidden">
        {mobileOpen && (
          <div className="max-h-[50vh] overflow-y-auto border-b border-slate-100 px-4 pb-2 pt-4">
            <SummaryLines totals={totals} billing={billing} />
          </div>
        )}
        <button
          type="button"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        >
          <div className="min-w-0">
            <div className="text-xs text-slate-500">
              {totals.tier.name}
              {totals.selectedAddons.length > 0 && ` + ${totals.selectedAddons.length} add-on${totals.selectedAddons.length > 1 ? 's' : ''}`}
              {billing === 'annual' && ' · annual'}
            </div>
            <div className="text-lg font-extrabold tracking-tight">
              {baht(totals.monthlyEq)}
              <span className="text-xs font-medium text-slate-500">/mo{totals.tier.startingAt ? ' · starting at' : ''}</span>
            </div>
          </div>
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white">
            {mobileOpen ? 'Hide' : 'Details'}
            <ChevronUp className={`h-3.5 w-3.5 transition-transform ${mobileOpen ? 'rotate-180' : ''}`} />
          </span>
        </button>
      </div>
    </div>
  );
}
