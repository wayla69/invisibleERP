import React, { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  Boxes,
  BrainCircuit,
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  CreditCard,
  Database,
  Factory,
  FileCheck2,
  Fingerprint,
  Gauge,
  GitBranch,
  Globe,
  HeartHandshake,
  KeyRound,
  Landmark,
  Layers,
  Lock,
  Megaphone,
  MessageSquare,
  Minus,
  Monitor,
  Network,
  QrCode,
  Rocket,
  Scale,
  Server,
  ShieldCheck,
  ShieldOff,
  ShoppingCart,
  Sparkles,
  Split,
  Store,
  TrendingUp,
  Truck,
  Unplug,
  UtensilsCrossed,
  Users,
  Wallet,
  Webhook,
  X,
  Zap,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Design rule (per product owner): every slide uses a WHITE          */
/*  background with PASTEL accents and dark, highly readable text.     */
/* ------------------------------------------------------------------ */

const TONES = {
  blue: { text: "text-blue-700", bg: "bg-blue-50", border: "border-blue-200", badge: "bg-blue-100 text-blue-600" },
  emerald: { text: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200", badge: "bg-emerald-100 text-emerald-600" },
  violet: { text: "text-violet-700", bg: "bg-violet-50", border: "border-violet-200", badge: "bg-violet-100 text-violet-600" },
  amber: { text: "text-amber-700", bg: "bg-amber-50", border: "border-amber-200", badge: "bg-amber-100 text-amber-600" },
  rose: { text: "text-rose-700", bg: "bg-rose-50", border: "border-rose-200", badge: "bg-rose-100 text-rose-600" },
  sky: { text: "text-sky-700", bg: "bg-sky-50", border: "border-sky-200", badge: "bg-sky-100 text-sky-600" },
  slate: { text: "text-slate-600", bg: "bg-slate-50", border: "border-slate-200", badge: "bg-slate-100 text-slate-600" },
};

function Chip({ icon: Icon, tone = "blue", children }) {
  const t = TONES[tone];
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-semibold ${t.bg} ${t.border} ${t.text}`}>
      <Icon className="h-4 w-4" />
      {children}
    </span>
  );
}

function IconBadge({ icon: Icon, tone = "blue", size = "md" }) {
  const t = TONES[tone];
  const s = size === "lg" ? "h-14 w-14" : size === "sm" ? "h-10 w-10" : "h-11 w-11";
  const i = size === "lg" ? "h-7 w-7" : "h-5 w-5";
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-xl ${s} ${t.badge}`}>
      <Icon className={i} />
    </span>
  );
}

function Stat({ value, label, tone = "blue" }) {
  const t = TONES[tone];
  return (
    <div className={`rounded-2xl border px-5 py-4 text-center ${t.bg} ${t.border}`}>
      <div className={`text-3xl font-extrabold tabular-nums md:text-4xl ${t.text}`}>{value}</div>
      <div className="mt-1 text-xs font-bold uppercase tracking-wider text-slate-500">{label}</div>
    </div>
  );
}

function Card({ icon, tone, title, children }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm">
      <IconBadge icon={icon} tone={tone} />
      <div className="text-base font-bold text-slate-900">{title}</div>
      <div className="text-sm leading-relaxed text-slate-600">{children}</div>
    </div>
  );
}

function FlowNode({ icon, label, sub, tone = "blue" }) {
  return (
    <div className="flex min-w-[7.5rem] flex-col items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <IconBadge icon={icon} tone={tone} size="sm" />
      <div className="text-sm font-bold text-slate-900">{label}</div>
      {sub && <div className="text-[11px] leading-tight text-slate-500">{sub}</div>}
    </div>
  );
}

function FlowArrow() {
  return <ArrowRight className="h-5 w-5 shrink-0 text-slate-400" />;
}

function ModuleTile({ icon, tone, label, sub }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-sm">
      <IconBadge icon={icon} tone={tone} size="sm" />
      <div>
        <div className="text-sm font-bold text-slate-900">{label}</div>
        <div className="text-xs text-slate-500">{sub}</div>
      </div>
    </div>
  );
}

function Mark({ kind }) {
  const map = {
    yes: { icon: Check, cls: "bg-emerald-100 text-emerald-600" },
    no: { icon: X, cls: "bg-rose-100 text-rose-600" },
    mid: { icon: Minus, cls: "bg-amber-100 text-amber-600" },
  };
  const { icon: Icon, cls } = map[kind];
  return (
    <span className={`mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full align-middle ${cls}`}>
      <Icon className="h-3 w-3" strokeWidth={3} />
    </span>
  );
}

function SlideHeading({ kicker, title, tone = "blue" }) {
  return (
    <div className="mb-7">
      <div className={`mb-2 text-xs font-extrabold uppercase tracking-[0.2em] ${TONES[tone].text}`}>{kicker}</div>
      <h2 className="text-3xl font-extrabold text-slate-900 md:text-4xl">{title}</h2>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Slides                                                             */
/* ------------------------------------------------------------------ */

function TitleSlide() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <Chip icon={Landmark} tone="emerald">NASDAQ IPO track · SOX-ICFR ready</Chip>
      <h1 className="mt-6 bg-gradient-to-r from-blue-500 via-sky-500 to-emerald-500 bg-clip-text text-5xl font-extrabold leading-tight text-transparent md:text-7xl">
        Next-Gen Enterprise ERP
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-relaxed text-slate-600 md:text-xl">
        A multi-tenant, Thai-localized ERP + POS platform for retail, food service, and every
        branch-based business — bridging financial controls with operations, from the point of
        sale to the general ledger.
      </p>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <Chip icon={Zap} tone="blue">Lean &amp; fast — TypeScript end-to-end</Chip>
        <Chip icon={Building2} tone="emerald">True multi-tenancy — Postgres RLS</Chip>
        <Chip icon={Globe} tone="violet">Omnichannel ready</Chip>
      </div>
    </div>
  );
}

function ProblemSlide() {
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="The Problem" title="Legacy ERPs weren't built for this decade" tone="rose" />
      <div className="grid gap-4 md:grid-cols-3">
        <Card icon={Boxes} tone="rose" title="Bulky and slow">
          Monolithic suites with multi-million-line codebases, upgrade cycles measured in
          years, and consultants required for every change.
        </Card>
        <Card icon={ShieldOff} tone="amber" title="Compliance as an afterthought">
          Access controls and segregation-of-duty rules are bolted on after the fact —
          making SOX audits painful, manual, and expensive.
        </Card>
        <Card icon={Unplug} tone="rose" title="Brittle integrations">
          Modern delivery marketplaces, payment gateways, and POS terminals are wired in
          through fragile point-to-point connectors that break silently.
        </Card>
      </div>
      <p className="mt-8 text-center text-lg text-slate-700">
        Growing businesses are forced to choose between{" "}
        <span className="font-bold text-blue-700">operational agility</span> and{" "}
        <span className="font-bold text-emerald-700">financial control</span>.
        <span className="text-slate-400"> They shouldn&apos;t have to.</span>
      </p>
    </div>
  );
}

function SolutionSlide() {
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="The Solution" title="A lean, high-performance architecture" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat value="~275k" label="Lines of code — total" tone="blue" />
        <Stat value="100%" label="TypeScript end-to-end" tone="emerald" />
        <Stat value="1" label="Source of truth — the ledger" tone="violet" />
      </div>
      <div className="mt-7 rounded-2xl border border-slate-200 bg-slate-50 p-6">
        <div className="mb-4 text-center text-xs font-extrabold uppercase tracking-[0.2em] text-slate-500">
          One order, one flow — table-side scan to audited journal entry
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <FlowNode icon={QrCode} label="Diner QR" sub="table-side ordering" tone="blue" />
          <FlowArrow />
          <FlowNode icon={UtensilsCrossed} label="POS / KDS" sub="Next.js 15" tone="blue" />
          <FlowArrow />
          <FlowNode icon={Server} label="API tier" sub="NestJS · Fastify" tone="emerald" />
          <FlowArrow />
          <FlowNode icon={Database} label="PostgreSQL" sub="Drizzle ORM · RLS" tone="emerald" />
          <FlowArrow />
          <FlowNode icon={Landmark} label="General Ledger" sub="auto-posted, balanced" tone="emerald" />
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Chip icon={Layers} tone="violet">Modular bounded contexts</Chip>
        <Chip icon={Gauge} tone="blue">No batch lag — postings in the request</Chip>
        <Chip icon={Network} tone="emerald">Registry-driven extension seams</Chip>
      </div>
    </div>
  );
}

function ProductSlide() {
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="Product Tour" title="One platform, every business cycle" tone="violet" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ModuleTile icon={UtensilsCrossed} tone="blue" label="POS · KDS · QR" sub="dine-in, takeaway, kitchen display" />
        <ModuleTile icon={Boxes} tone="emerald" label="Inventory & WMS" sub="stock, putaway, replenishment" />
        <ModuleTile icon={ShoppingCart} tone="amber" label="Procurement" sub="PR → PO → blind-count GRN" />
        <ModuleTile icon={Landmark} tone="violet" label="Finance & GL" sub="AR/AP, close manager, cash flow" />
        <ModuleTile icon={Factory} tone="rose" label="Manufacturing" sub="BOM, MRP, shop-floor, QC" />
        <ModuleTile icon={ClipboardList} tone="sky" label="Projects & PPM" sub="WBS, EVM, subcontracts" />
        <ModuleTile icon={HeartHandshake} tone="rose" label="CRM & Loyalty" sub="members, points, campaigns" />
        <ModuleTile icon={TrendingUp} tone="emerald" label="BI & Analytics" sub="live KPIs, scheduled reports" />
        <ModuleTile icon={BrainCircuit} tone="violet" label="AI Demand Planning" sub="ML forecasts → order plans → PR" />
        <ModuleTile icon={Megaphone} tone="amber" label="Marketing Intelligence" sub="RFM, budget optimizer, closed-loop" />
        <ModuleTile icon={Wallet} tone="blue" label="Thai Payment Rails" sub="PromptPay QR, slip verify & OCR" />
        <ModuleTile icon={Users} tone="sky" label="HR & Payroll" sub="time, leave, payroll to GL" />
      </div>
      <p className="mt-7 text-center text-sm text-slate-600">
        Every module posts to the <span className="font-bold text-emerald-700">same audited ledger</span> —
        no reconciliation projects, no batch ETL, no version drift between operations and finance.
      </p>
    </div>
  );
}

function SecuritySlide() {
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="Security & Compliance" title="Uncompromised financial integrity" tone="emerald" />
      <div className="mb-7 flex items-center justify-center gap-4">
        <IconBadge icon={ShieldCheck} tone="emerald" size="lg" />
        <div className="text-left">
          <div className="text-lg font-bold text-slate-900">Fail-closed by design</div>
          <div className="text-sm text-slate-600">
            If a control can&apos;t verify, the system refuses — it never silently allows.
          </div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat value="24" label="User roles" tone="blue" />
        <Stat value="82" label="Granular permissions" tone="blue" />
        <Stat value="24" label="Segregation-of-duty rules" tone="emerald" />
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <Card icon={Lock} tone="emerald" title="Row-Level Security multi-tenancy">
          Every query is tenant-scoped at the database itself. The API even refuses to boot
          if its DB role could bypass RLS.
        </Card>
        <Card icon={Scale} tone="blue" title="Maker-checker everywhere">
          No journal entry reaches the balances until a different human approves it —
          enforced in code, not in policy documents.
        </Card>
        <Card icon={FileCheck2} tone="violet" title="SOX-ICFR readiness">
          A living Risk &amp; Control Matrix, process narratives, and automated control-test
          harnesses run on every change.
        </Card>
      </div>
    </div>
  );
}

function IntegrationsSlide() {
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="Omnichannel Supply Chain" title="Every channel in — one trusted tier out" />
      <div className="grid items-stretch gap-4 lg:grid-cols-[1fr_auto_1fr]">
        <div className="rounded-2xl border-2 border-dashed border-rose-300 bg-rose-50 p-5">
          <div className="mb-4 flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.16em] text-rose-600">
            <Webhook className="h-4 w-4" /> Untrusted boundary — inbound webhooks
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FlowNode icon={CreditCard} label="Payments" sub="3 gateways" tone="rose" />
            <FlowNode icon={Truck} label="Delivery" sub="3 marketplaces" tone="rose" />
            <FlowNode icon={MessageSquare} label="Chat" sub="order capture" tone="rose" />
            <FlowNode icon={QrCode} label="Diner QR" sub="public ordering" tone="rose" />
          </div>
        </div>
        <div className="flex flex-row items-center justify-center gap-2 lg:flex-col">
          <div className="hidden h-full w-0.5 bg-gradient-to-b from-transparent via-emerald-300 to-transparent lg:block" />
          <div className="flex flex-col items-center gap-1 rounded-xl border border-emerald-300 bg-emerald-100 px-3 py-2">
            <Fingerprint className="h-5 w-5 text-emerald-600" />
            <div className="text-center text-[11px] font-bold leading-tight text-emerald-700">
              HMAC-signed
              <br />
              fail-closed
            </div>
          </div>
          <div className="hidden h-full w-0.5 bg-gradient-to-b from-transparent via-emerald-300 to-transparent lg:block" />
        </div>
        <div className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-5">
          <div className="mb-4 flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.16em] text-emerald-700">
            <ShieldCheck className="h-4 w-4" /> Trusted API tier
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FlowNode icon={Server} label="NestJS API" sub="authZ on every object" tone="emerald" />
            <FlowNode icon={Database} label="PostgreSQL" sub="tenant RLS" tone="emerald" />
            <FlowNode icon={FileCheck2} label="e-Tax" sub="Thai e-invoicing" tone="emerald" />
            <FlowNode icon={Monitor} label="POS / KDS" sub="terminals" tone="emerald" />
          </div>
        </div>
      </div>
      <p className="mt-6 text-center text-sm text-slate-600">
        Every external event is verified at the boundary before it can touch inventory or the
        ledger — <span className="font-bold text-emerald-700">integrations that fail loudly, never silently</span>.
      </p>
    </div>
  );
}

function MarketSlide() {
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="Market Opportunity" title="A huge market still running on paper and spreadsheets" tone="amber" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat value="฿1.4T+" label="Thai food-service market (est.)" tone="amber" />
        <Stat value="600k+" label="F&B outlets in Thailand (est.)" tone="blue" />
        <Stat value="<10%" label="Mid-market chains on a real ERP (est.)" tone="rose" />
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <Card icon={Store} tone="amber" title="Underserved mid-market">
          Branch businesses of 5–100 locations — restaurants, cafés, retail, services — too
          big for spreadsheets, too small for SAP; exactly where compliance pressure is arriving.
        </Card>
        <Card icon={TrendingUp} tone="emerald" title="Compliance tailwind">
          e-Tax mandates, PDPA, and listing ambitions push Thai operators toward audited,
          controlled systems — our home turf.
        </Card>
        <Card icon={Globe} tone="sky" title="SEA expansion path">
          The same multi-tenant, multi-language core localizes to neighboring markets without
          re-architecture.
        </Card>
      </div>
      <p className="mt-5 text-center text-xs text-slate-400">
        Market figures are company estimates from public industry data, for illustration.
      </p>
    </div>
  );
}

function PlanLineTag({ tone, children }) {
  return (
    <div className={`flex w-28 shrink-0 items-center justify-center rounded-xl border px-2 text-center text-[11px] font-extrabold leading-tight ${TONES[tone].bg} ${TONES[tone].border} ${TONES[tone].text}`}>
      {children}
    </div>
  );
}

function PlanTier({ name, price, per, sub, tone }) {
  return (
    <div className="flex-1 rounded-2xl border border-slate-200 bg-white px-2 py-3 text-center shadow-sm">
      <div className="text-sm font-extrabold text-slate-900">{name}</div>
      <div className={`mt-1 text-lg font-extrabold ${TONES[tone].text}`}>{price}</div>
      <div className="text-[10px] font-semibold text-slate-400">{per || " "}</div>
      <div className="mt-1 text-[10px] leading-snug text-slate-500">{sub}</div>
    </div>
  );
}

function BusinessModelSlide() {
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="Business Model" title="SaaS economics on one multi-tenant core" tone="emerald" />
      <div className="space-y-2.5">
        <div className="flex items-stretch gap-2.5">
          <PlanLineTag tone="blue">POS line · per branch</PlanLineTag>
          <PlanTier name="POS Lite" price="฿590" per="/br/mo" sub="counter register · 3 seats" tone="blue" />
          <PlanTier name="POS Pro" price="฿1,190" per="/br/mo" sub="full front of house · QR · channels" tone="blue" />
        </div>
        <div className="flex items-stretch gap-2.5">
          <PlanLineTag tone="emerald">ERP line · per company</PlanLineTag>
          <PlanTier name="ERP Essentials" price="฿1,900" per="/mo" sub="finance · orders · inventory" tone="emerald" />
          <PlanTier name="ERP Growth" price="฿3,900" per="/mo" sub="+ procurement · planning" tone="emerald" />
        </div>
        <div className="flex items-stretch gap-2.5">
          <PlanLineTag tone="violet">Complete bundles</PlanLineTag>
          <PlanTier name="Solo" price="฿690" per="/mo" sub="1 seat" tone="slate" />
          <PlanTier name="Standard" price="฿2,900" per="/mo" sub="+ procurement" tone="violet" />
          <PlanTier name="Business" price="฿4,900" per="/mo" sub="multi-branch" tone="violet" />
          <PlanTier name="Professional" price="฿9,900" per="/mo" sub="planning · AI" tone="amber" />
          <PlanTier name="Franchise" price="฿14,900" per="/mo" sub="verticals" tone="rose" />
          <PlanTier name="Enterprise" price="Custom" per="" sub="unlimited" tone="rose" />
        </div>
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <Card icon={Wallet} tone="emerald" title="Per-company subscriptions">
          Every company in a fleet subscribes to its own plan on one deployment — gross margin
          scales with tenants, not headcount. Yearly billing is priced at ten months.
        </Card>
        <Card icon={Sparkles} tone="violet" title="Usage-metered expansion">
          AI tokens, e-Tax documents, and POS transactions carry plan quotas with automatic
          overage billing — expansion revenue grows with customer usage.
        </Card>
        <Card icon={Rocket} tone="blue" title="Split-sell, land and expand">
          Buy POS only, ERP only, or the Complete bundle — a 14-day trial lands the account,
          and every upgrade between lines is a plan change on the same tenant, never a migration.
        </Card>
      </div>
    </div>
  );
}

function TractionSlide() {
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="Traction & Quality Assurance" title="Enterprise-grade, provably" tone="emerald" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat value="100%" label="Core-logic test coverage" tone="emerald" />
        <Stat value="0" label="Diffs vs. golden master" tone="blue" />
        <Stat value="24/7" label="CI gates on every change" tone="violet" />
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <Card icon={BadgeCheck} tone="emerald" title="Golden zero-diff parity">
          Every financial output is deep-compared against a pinned golden master. A single
          unintended satang of drift fails the build.
        </Card>
        <Card icon={GitBranch} tone="blue" title="CI/CD with down-only ratchets">
          Control-test harnesses, migration gates, and code-quality ratchets that only ever
          tighten — technical debt can shrink, never grow.
        </Card>
        <Card icon={KeyRound} tone="violet" title="Enterprise SSO / SCIM">
          Single sign-on and automated user provisioning out of the box — IT teams onboard
          and offboard staff from their existing identity provider.
        </Card>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Chip icon={Users} tone="blue">Multi-company fleet operations</Chip>
        <Chip icon={Split} tone="emerald">SoD-tested on every pipeline run</Chip>
      </div>
    </div>
  );
}

function WhyWeWinSlide() {
  const rows = [
    ["Time to deploy", ["mid", "12–24 months"], ["yes", "Days"], ["yes", "Weeks, full stack"]],
    ["Financial controls (SOX-ICFR)", ["mid", "Bolt-on, consultant-led"], ["no", "None"], ["yes", "Built-in, fail-closed"]],
    ["Omnichannel F&B operations", ["no", "Custom integration projects"], ["mid", "Front-of-house only"], ["yes", "Native — QR, delivery, e-Tax"]],
    ["Real-time audited ledger", ["mid", "Batch ETL, month-end lag"], ["no", "No general ledger"], ["yes", "Posted in the request"]],
    ["Total cost of ownership", ["no", "License + integrators"], ["mid", "Cheap but fragmented"], ["yes", "One SaaS platform"]],
  ];
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="Why We Win" title="Built for F&B, built for audit — from day one" />
      <div className="overflow-x-auto rounded-2xl border border-slate-200 shadow-sm">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-xs font-extrabold uppercase tracking-wider text-slate-500">
              <th className="px-4 py-3" />
              <th className="px-4 py-3">Legacy ERP suites</th>
              <th className="px-4 py-3">POS point solutions</th>
              <th className="bg-emerald-100 px-4 py-3 text-emerald-700">Invisible ERP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, legacy, pos, us]) => (
              <tr key={label} className="border-t border-slate-200">
                <td className="px-4 py-3 font-bold text-slate-900">{label}</td>
                <td className="px-4 py-3 text-slate-600"><Mark kind={legacy[0]} />{legacy[1]}</td>
                <td className="px-4 py-3 text-slate-600"><Mark kind={pos[0]} />{pos[1]}</td>
                <td className="bg-emerald-50 px-4 py-3 font-bold text-emerald-800"><Mark kind={us[0]} />{us[1]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RoadmapSlide() {
  const items = [
    { icon: BadgeCheck, tone: "emerald", dot: "bg-emerald-400", title: "Delivered",
      body: "Full ERP spine — POS to GL, WMS, MRP, projects, CRM, BI — plus ML demand forecasting, marketing intelligence, and Thai payment rails, with 307 documented controls and automated harnesses." },
    { icon: FileCheck2, tone: "blue", dot: "bg-blue-400", title: "Now — IPO readiness",
      body: "External audit support, SOX-ICFR evidence packs, pentest remediation ratchets, ISO 27001 alignment." },
    { icon: Globe, tone: "amber", dot: "bg-amber-400", title: "Next — regional scale",
      body: "SEA localization (tax, language, payments), partner & franchise marketplace, deeper channel coverage." },
    { icon: Sparkles, tone: "violet", dot: "bg-violet-400", title: "Future — AI-native ops",
      body: "Self-tuning forecast models at fleet scale, anomaly-detecting controls, and multi-echelon autonomous replenishment — on the forecasting spine already shipped." },
  ];
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="Roadmap" title="The ratchet only tightens" tone="violet" />
      <div className="relative mt-4">
        <div className="absolute left-0 right-0 top-2 h-1 rounded bg-gradient-to-r from-emerald-300 via-blue-300 via-amber-300 to-violet-300" />
        <div className="grid gap-5 md:grid-cols-4">
          {items.map(({ icon, tone, dot, title, body }) => (
            <div key={title} className="relative pt-7">
              <span className={`absolute left-1 top-0 h-4 w-4 rounded-full border-4 border-white shadow ${dot}`} />
              <IconBadge icon={icon} tone={tone} size="sm" />
              <div className="mb-1.5 mt-3 text-base font-extrabold text-slate-900">{title}</div>
              <div className="text-xs leading-relaxed text-slate-600">{body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CostBar({ tone, label, sub, pct, amount }) {
  const fills = {
    blue: "bg-blue-300", emerald: "bg-emerald-300", amber: "bg-amber-300",
    violet: "bg-violet-300", rose: "bg-rose-300",
  };
  return (
    <div className="flex items-center gap-4 py-2">
      <div className="w-72 shrink-0">
        <div className="text-sm font-bold text-slate-900">{label}</div>
        <div className="text-xs text-slate-500">{sub}</div>
      </div>
      <div className="h-3.5 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${fills[tone]}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-20 shrink-0 text-right text-base font-extrabold text-slate-900">{amount}</div>
    </div>
  );
}

function Milestone({ title, sub }) {
  return (
    <div className="flex items-start gap-1 py-2">
      <Mark kind="yes" />
      <div>
        <div className="text-sm font-bold text-slate-900">{title}</div>
        <div className="text-xs text-slate-500">{sub}</div>
      </div>
    </div>
  );
}

function ProjectCostSlide() {
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="Project Cost" title="The seed buys a platform that already exists" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat value="฿60M+" label="Replacement cost to date (est.)" tone="blue" />
        <Stat value="~12" label="Person-years of senior engineering" tone="violet" />
        <Stat value="307" label="Documented controls shipped" tone="emerald" />
      </div>
      <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-6">
        <div className="mb-3 text-center text-xs font-extrabold uppercase tracking-[0.2em] text-slate-500">
          Where the ฿60M of build value sits (replacement-cost estimate)
        </div>
        <CostBar tone="blue" label="Engineering — core platform & 10 domain modules" sub="POS → GL, WMS, MRP, projects, CRM, BI" pct={72} amount="฿43M" />
        <CostBar tone="emerald" label="Compliance & audit readiness" sub="RCM, process narratives, control-test harnesses" pct={13} amount="฿8M" />
        <CostBar tone="amber" label="Integrations & Thai localization" sub="e-Tax, 3 payment gateways, 3 delivery channels" pct={10} amount="฿6M" />
        <CostBar tone="rose" label="Security" sub="third-party reviews, pentests, remediation" pct={5} amount="฿3M" />
      </div>
      <p className="mt-4 text-center text-xs text-slate-400">
        Replacement-cost model at blended senior-team rates — illustrative, for discussion.
      </p>
    </div>
  );
}

function UseOfFundsSlide() {
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="Use of Funds" title="An 18-month plan to Series A readiness" tone="emerald" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat value="฿70M" label="Seed raise (~US$2.0M)" tone="emerald" />
        <Stat value="฿3.5M" label="Average monthly burn" tone="amber" />
        <Stat value="18–20" label="Months of runway" tone="blue" />
      </div>
      <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-6">
        <div className="mb-3 text-center text-xs font-extrabold uppercase tracking-[0.2em] text-slate-500">
          Allocation of the ฿70M raise
        </div>
        <CostBar tone="blue" label="Product & engineering — 45%" sub="AI-native ops, SEA localization, platform depth" pct={45} amount="฿31.5M" />
        <CostBar tone="emerald" label="Go-to-market & sales — 30%" sub="mid-market chain sales team, partner channel" pct={30} amount="฿21.0M" />
        <CostBar tone="violet" label="Compliance & external audit — 15%" sub="SOX-ICFR audit fees, ISO 27001 certification" pct={15} amount="฿10.5M" />
        <CostBar tone="amber" label="Cloud infra & operations — 10%" sub="multi-region hosting, monitoring, support" pct={10} amount="฿7.0M" />
      </div>
      <p className="mt-4 text-center text-xs text-slate-400">Operating model assumptions — illustrative, for discussion.</p>
    </div>
  );
}

function TheAskSlide() {
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="Seed Round — The Ask" title="฿70M to turn an audited platform into a market leader" tone="violet" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="grid grid-cols-2 gap-3">
            <Stat value="฿70M" label="Raise (~US$2.0M)" tone="violet" />
            <Stat value="฿280M" label="Pre-money (~US$8M)" tone="blue" />
            <Stat value="~20%" label="Equity, post-money" tone="emerald" />
            <Stat value="18–20" label="Months of runway" tone="amber" />
          </div>
          <p className="mt-3 text-xs text-slate-400">Priced equity or SAFE; terms illustrative, for discussion.</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <div className="mb-2 text-xs font-extrabold uppercase tracking-[0.16em] text-slate-500">
            Milestones this round unlocks — the Series A story
          </div>
          <Milestone title="30+ paying companies live" sub="mid-market F&B chains on the full stack" />
          <Milestone title="฿35M ARR run-rate (~US$1M)" sub="subscription + AI usage revenue" />
          <Milestone title="First external SOX-ICFR audit passed" sub="controls evidence produced by the platform itself" />
          <Milestone title="2 SEA markets localized" sub="tax, language, and payment rails beyond Thailand" />
        </div>
      </div>
    </div>
  );
}

function ValuationSlide() {
  const rows = [
    ["฿20M (bear)", 120, 160, 200],
    ["฿35M (base)", 210, 280, 350],
    ["฿50M (bull)", 300, 400, 500],
  ];
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="Valuation Model" title="Triangulated, not hand-waved" tone="amber" />
      <div className="grid gap-4 md:grid-cols-3">
        <Card icon={Layers} tone="blue" title="Replacement-cost floor">
          ฿60M+ to rebuild the platform — before the compliance moat: 307 controls, harnesses,
          and audit artifacts a copycat must also rebuild.
        </Card>
        <Card icon={Scale} tone="emerald" title="Comparable seed rounds">
          SEA B2B-SaaS seeds with live product and early revenue price at roughly US$6–12M
          pre-money — we sit mid-range with audit-grade differentiation.
        </Card>
        <Card icon={TrendingUp} tone="violet" title="Forward-multiple method">
          Series A target of ฿35M forward ARR at an 8× multiple implies ฿280M — the pre-money
          we are asking for today.
        </Card>
      </div>
      <div className="mt-5">
        <div className="mb-2 text-center text-xs font-extrabold uppercase tracking-[0.16em] text-slate-500">
          Implied valuation (฿M) — forward ARR at Series A × revenue multiple
        </div>
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full border-collapse text-sm tabular-nums">
            <thead>
              <tr className="bg-slate-50 text-xs font-extrabold uppercase tracking-wider text-slate-500">
                <th className="px-4 py-2 text-left">Forward ARR ↓ · Multiple →</th>
                <th className="px-4 py-2 text-center">6×</th>
                <th className="px-4 py-2 text-center">8×</th>
                <th className="px-4 py-2 text-center">10×</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, a, b, c]) => (
                <tr key={label} className="border-t border-slate-200">
                  <td className="px-4 py-2 font-bold text-slate-900">{label}</td>
                  <td className="px-4 py-2 text-center text-slate-600">{a}</td>
                  <td className={`px-4 py-2 text-center ${b === 280 ? "bg-emerald-100 font-extrabold text-emerald-700" : "text-slate-600"}`}>{b}</td>
                  <td className="px-4 py-2 text-center text-slate-600">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-4 text-center text-xs text-slate-400">
        All figures are an illustrative financing model, not an offer of securities.
      </p>
    </div>
  );
}

function ClosingSlide() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <IconBadge icon={Rocket} tone="blue" size="lg" />
      <h2 className="mt-6 text-4xl font-extrabold leading-tight text-slate-900 md:text-6xl">
        Ready for <span className="text-blue-600">scale</span>.
        <br />
        Ready for <span className="text-emerald-600">audit</span>.
      </h2>
      <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-600">
        IPO-grade controls with startup speed — one platform from the dining table to the
        audited financial statement.
      </p>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <button className="inline-flex items-center gap-2 rounded-xl bg-blue-500 px-6 py-3 text-base font-bold text-white transition hover:bg-blue-600">
          Request a demo <ArrowRight className="h-4 w-4" />
        </button>
        <button className="inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-6 py-3 text-base font-bold text-emerald-700 transition hover:bg-emerald-100">
          <FileCheck2 className="h-4 w-4" /> View the compliance pack
        </button>
      </div>
      <div className="mt-12 flex flex-wrap items-center justify-center gap-3">
        <Chip icon={ShieldCheck} tone="slate">SOX-ICFR</Chip>
        <Chip icon={Lock} tone="slate">RLS multi-tenant</Chip>
        <Chip icon={Globe} tone="slate">Omnichannel</Chip>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Deck shell                                                         */
/* ------------------------------------------------------------------ */

const SLIDES = [
  { id: "title", name: "Title", Component: TitleSlide },
  { id: "problem", name: "Problem", Component: ProblemSlide },
  { id: "solution", name: "Solution", Component: SolutionSlide },
  { id: "product", name: "Product", Component: ProductSlide },
  { id: "security", name: "Security", Component: SecuritySlide },
  { id: "integrations", name: "Integrations", Component: IntegrationsSlide },
  { id: "market", name: "Market", Component: MarketSlide },
  { id: "model", name: "Business Model", Component: BusinessModelSlide },
  { id: "traction", name: "Traction", Component: TractionSlide },
  { id: "why", name: "Why We Win", Component: WhyWeWinSlide },
  { id: "roadmap", name: "Roadmap", Component: RoadmapSlide },
  { id: "cost", name: "Project Cost", Component: ProjectCostSlide },
  { id: "funds", name: "Use of Funds", Component: UseOfFundsSlide },
  { id: "ask", name: "The Ask", Component: TheAskSlide },
  { id: "valuation", name: "Valuation", Component: ValuationSlide },
  { id: "closing", name: "Closing", Component: ClosingSlide },
];

export default function PitchDeck() {
  const [index, setIndex] = useState(0);

  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const next = useCallback(() => setIndex((i) => Math.min(SLIDES.length - 1, i + 1)), []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next]);

  const { Component } = SLIDES[index];

  return (
    <div className="flex min-h-screen flex-col bg-white text-slate-700 antialiased">
      <style>{`
        @keyframes deck-enter {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .deck-slide { animation: deck-enter 0.35s ease-out; }
      `}</style>

      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <Landmark className="h-5 w-5 text-emerald-600" />
          Invisible ERP
          <span className="hidden font-medium text-slate-400 sm:inline">· Investor Deck</span>
        </div>
        <div className="text-xs font-bold uppercase tracking-widest text-slate-400">
          {SLIDES[index].name} — {index + 1} / {SLIDES.length}
        </div>
      </header>

      {/* Progress bar */}
      <div className="h-1 w-full bg-slate-100">
        <div
          className="h-full bg-gradient-to-r from-blue-300 to-emerald-300 transition-all duration-300"
          style={{ width: `${((index + 1) / SLIDES.length) * 100}%` }}
        />
      </div>

      {/* Slide body */}
      <main className="relative flex-1 overflow-y-auto px-6 py-10 md:px-12">
        <div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            backgroundImage:
              "linear-gradient(to right, #f1f5f9 1px, transparent 1px), linear-gradient(to bottom, #f1f5f9 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
        <div key={SLIDES[index].id} className="deck-slide relative mx-auto h-full max-w-5xl">
          <Component />
        </div>
      </main>

      {/* Navigation */}
      <footer className="flex items-center justify-between border-t border-slate-200 px-6 py-4">
        <button
          onClick={prev}
          disabled={index === 0}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold text-slate-600 transition enabled:hover:border-slate-400 enabled:hover:text-slate-900 disabled:opacity-30"
        >
          <ChevronLeft className="h-4 w-4" /> Prev
        </button>

        <div className="flex items-center gap-2">
          {SLIDES.map((s, i) => (
            <button
              key={s.id}
              aria-label={`Go to slide ${i + 1}: ${s.name}`}
              onClick={() => setIndex(i)}
              className={`h-2.5 rounded-full transition-all ${
                i === index ? "w-8 bg-gradient-to-r from-blue-400 to-emerald-400" : "w-2.5 bg-slate-200 hover:bg-slate-300"
              }`}
            />
          ))}
        </div>

        <button
          onClick={next}
          disabled={index === SLIDES.length - 1}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-500 px-4 py-2 text-sm font-bold text-white transition enabled:hover:bg-blue-600 disabled:opacity-30"
        >
          Next <ChevronRight className="h-4 w-4" />
        </button>
      </footer>
    </div>
  );
}
