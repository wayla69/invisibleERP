import React, { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  Boxes,
  Building2,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Database,
  FileCheck2,
  Fingerprint,
  Gauge,
  GitBranch,
  Globe,
  KeyRound,
  Landmark,
  Layers,
  Lock,
  MessageSquare,
  Monitor,
  Network,
  QrCode,
  Rocket,
  Scale,
  Server,
  ShieldCheck,
  ShieldOff,
  Split,
  Truck,
  Unplug,
  UtensilsCrossed,
  Users,
  Webhook,
  Zap,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Small building blocks                                              */
/* ------------------------------------------------------------------ */

const TONES = {
  blue: { text: "text-blue-400", bg: "bg-blue-500/10", ring: "ring-blue-500/30" },
  emerald: { text: "text-emerald-400", bg: "bg-emerald-500/10", ring: "ring-emerald-500/30" },
  slate: { text: "text-slate-300", bg: "bg-slate-500/10", ring: "ring-slate-500/30" },
  amber: { text: "text-amber-400", bg: "bg-amber-500/10", ring: "ring-amber-500/30" },
  rose: { text: "text-rose-400", bg: "bg-rose-500/10", ring: "ring-rose-500/30" },
};

function Chip({ icon: Icon, tone = "blue", children }) {
  const t = TONES[tone];
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium ring-1 ${t.bg} ${t.ring} ${t.text}`}
    >
      <Icon className="h-4 w-4" />
      {children}
    </span>
  );
}

function IconBadge({ icon: Icon, tone = "blue", size = "md" }) {
  const t = TONES[tone];
  const s = size === "lg" ? "h-14 w-14" : size === "sm" ? "h-9 w-9" : "h-11 w-11";
  const i = size === "lg" ? "h-7 w-7" : size === "sm" ? "h-4 w-4" : "h-5 w-5";
  return (
    <span className={`inline-flex ${s} items-center justify-center rounded-xl ring-1 ${t.bg} ${t.ring}`}>
      <Icon className={`${i} ${t.text}`} />
    </span>
  );
}

function Stat({ value, label, tone = "blue" }) {
  const t = TONES[tone];
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 px-5 py-4 text-center">
      <div className={`text-3xl font-bold tabular-nums md:text-4xl ${t.text}`}>{value}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-wider text-slate-400">{label}</div>
    </div>
  );
}

function Card({ icon, tone, title, children }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 text-left">
      <IconBadge icon={icon} tone={tone} />
      <div className="text-base font-semibold text-slate-100">{title}</div>
      <div className="text-sm leading-relaxed text-slate-400">{children}</div>
    </div>
  );
}

function FlowNode({ icon: Icon, label, sub, tone = "blue" }) {
  const t = TONES[tone];
  return (
    <div className="flex min-w-[7.5rem] flex-col items-center gap-2 rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-3">
      <Icon className={`h-6 w-6 ${t.text}`} />
      <div className="text-sm font-semibold text-slate-100">{label}</div>
      {sub && <div className="text-[11px] leading-tight text-slate-500">{sub}</div>}
    </div>
  );
}

function FlowArrow() {
  return <ArrowRight className="h-5 w-5 shrink-0 text-slate-600" />;
}

function SlideHeading({ kicker, title, tone = "blue" }) {
  return (
    <div className="mb-8">
      <div className={`mb-2 text-xs font-bold uppercase tracking-[0.2em] ${TONES[tone].text}`}>{kicker}</div>
      <h2 className="text-3xl font-bold text-slate-50 md:text-4xl">{title}</h2>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Slides                                                             */
/* ------------------------------------------------------------------ */

function TitleSlide() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <Chip icon={Landmark} tone="emerald">
        NASDAQ IPO track · SOX-ICFR ready
      </Chip>
      <h1 className="mt-6 bg-gradient-to-r from-blue-400 via-sky-300 to-emerald-400 bg-clip-text text-5xl font-extrabold leading-tight text-transparent md:text-7xl">
        Next-Gen Enterprise ERP
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-relaxed text-slate-400 md:text-xl">
        A multi-tenant, Thai-localized ERP for food &amp; beverage enterprises — bridging
        financial controls with supply-chain operations, from the diner&apos;s QR scan to the
        general ledger.
      </p>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <Chip icon={Zap} tone="blue">Lean &amp; fast — TypeScript end-to-end</Chip>
        <Chip icon={Building2} tone="emerald">True multi-tenancy — Postgres RLS</Chip>
        <Chip icon={Globe} tone="slate">Omnichannel ready</Chip>
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
      <p className="mt-8 text-center text-lg text-slate-300">
        F&amp;B enterprises are forced to choose between{" "}
        <span className="font-semibold text-blue-400">operational agility</span> and{" "}
        <span className="font-semibold text-emerald-400">financial control</span>.
        <span className="text-slate-500"> They shouldn&apos;t have to.</span>
      </p>
    </div>
  );
}

function SolutionSlide() {
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="The Solution" title="A lean, high-performance architecture" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat value="~260k" label="Lines of code — total" tone="blue" />
        <Stat value="100%" label="TypeScript end-to-end" tone="emerald" />
        <Stat value="1" label="Source of truth — the ledger" tone="slate" />
      </div>
      <div className="mt-8 rounded-2xl border border-slate-800 bg-slate-950/60 p-6">
        <div className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-slate-500">
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
        <Chip icon={Layers} tone="slate">Modular bounded contexts</Chip>
        <Chip icon={Gauge} tone="blue">No batch lag — postings in the request</Chip>
        <Chip icon={Network} tone="emerald">Registry-driven extension seams</Chip>
      </div>
    </div>
  );
}

function SecuritySlide() {
  return (
    <div className="flex h-full flex-col justify-center">
      <SlideHeading kicker="Security & Compliance" title="Uncompromised financial integrity" tone="emerald" />
      <div className="mb-8 flex items-center justify-center gap-4">
        <IconBadge icon={ShieldCheck} tone="emerald" size="lg" />
        <div className="text-left">
          <div className="text-lg font-semibold text-slate-100">Fail-closed by design</div>
          <div className="text-sm text-slate-400">
            If a control can&apos;t verify, the system refuses — it never silently allows.
          </div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat value="24" label="User roles" tone="blue" />
        <Stat value="82" label="Granular permissions" tone="blue" />
        <Stat value="26" label="SoD rules on GL posting" tone="emerald" />
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
        <Card icon={FileCheck2} tone="emerald" title="SOX-ICFR readiness">
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
        {/* Untrusted boundary */}
        <div className="rounded-2xl border-2 border-dashed border-rose-500/40 bg-rose-500/5 p-5">
          <div className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-rose-400">
            <Webhook className="h-4 w-4" /> Untrusted boundary — inbound webhooks
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FlowNode icon={CreditCard} label="Payments" sub="3 gateways" tone="rose" />
            <FlowNode icon={Truck} label="Delivery" sub="3 marketplaces" tone="rose" />
            <FlowNode icon={MessageSquare} label="Chat" sub="order capture" tone="rose" />
            <FlowNode icon={QrCode} label="Diner QR" sub="public ordering" tone="rose" />
          </div>
        </div>
        {/* Verification barrier */}
        <div className="flex flex-row items-center justify-center gap-2 lg:flex-col">
          <div className="hidden h-full w-px bg-gradient-to-b from-transparent via-emerald-500/60 to-transparent lg:block" />
          <div className="flex flex-col items-center gap-1 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2">
            <Fingerprint className="h-5 w-5 text-emerald-400" />
            <div className="text-center text-[11px] font-semibold leading-tight text-emerald-300">
              HMAC-signed
              <br />
              fail-closed
            </div>
          </div>
          <div className="hidden h-full w-px bg-gradient-to-b from-transparent via-emerald-500/60 to-transparent lg:block" />
        </div>
        {/* Trusted tier */}
        <div className="rounded-2xl border-2 border-emerald-500/40 bg-emerald-500/5 p-5">
          <div className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-emerald-400">
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
      <p className="mt-6 text-center text-sm text-slate-400">
        Every external event is verified at the boundary before it can touch inventory or the
        ledger — <span className="text-emerald-400">integrations that fail loudly, never silently</span>.
      </p>
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
        <Stat value="24/7" label="CI gates on every change" tone="slate" />
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
        <Card icon={KeyRound} tone="slate" title="Enterprise SSO / SCIM">
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

function ClosingSlide() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <IconBadge icon={Rocket} tone="blue" size="lg" />
      <h2 className="mt-6 text-4xl font-extrabold leading-tight text-slate-50 md:text-6xl">
        Ready for <span className="text-blue-400">scale</span>.
        <br />
        Ready for <span className="text-emerald-400">audit</span>.
      </h2>
      <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-400">
        IPO-grade controls with startup speed — one platform from the dining table to the
        audited financial statement.
      </p>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <button className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-base font-semibold text-white transition hover:bg-blue-500">
          Request a demo <ArrowRight className="h-4 w-4" />
        </button>
        <button className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/50 px-6 py-3 text-base font-semibold text-emerald-400 transition hover:bg-emerald-500/10">
          <FileCheck2 className="h-4 w-4" /> View the compliance pack
        </button>
      </div>
      <div className="mt-12 flex flex-wrap items-center justify-center gap-3 text-slate-500">
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
  { id: "security", name: "Security", Component: SecuritySlide },
  { id: "integrations", name: "Integrations", Component: IntegrationsSlide },
  { id: "traction", name: "Traction", Component: TractionSlide },
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
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-200 antialiased">
      <style>{`
        @keyframes deck-enter {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .deck-slide { animation: deck-enter 0.35s ease-out; }
      `}</style>

      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-slate-800/80 px-6 py-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-300">
          <Landmark className="h-5 w-5 text-emerald-400" />
          Invisible ERP
          <span className="hidden text-slate-600 sm:inline">· Investor Deck</span>
        </div>
        <div className="text-xs font-medium uppercase tracking-widest text-slate-500">
          {SLIDES[index].name} — {index + 1} / {SLIDES.length}
        </div>
      </header>

      {/* Progress bar */}
      <div className="h-0.5 w-full bg-slate-800">
        <div
          className="h-full bg-gradient-to-r from-blue-500 to-emerald-500 transition-all duration-300"
          style={{ width: `${((index + 1) / SLIDES.length) * 100}%` }}
        />
      </div>

      {/* Slide body */}
      <main className="relative flex-1 overflow-y-auto px-6 py-10 md:px-12">
        {/* faint decorative grid */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #64748b 1px, transparent 1px), linear-gradient(to bottom, #64748b 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
        <div key={SLIDES[index].id} className="deck-slide relative mx-auto h-full max-w-5xl">
          <Component />
        </div>
      </main>

      {/* Navigation */}
      <footer className="flex items-center justify-between border-t border-slate-800/80 px-6 py-4">
        <button
          onClick={prev}
          disabled={index === 0}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 transition enabled:hover:border-slate-500 enabled:hover:text-white disabled:opacity-30"
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
                i === index ? "w-8 bg-gradient-to-r from-blue-500 to-emerald-500" : "w-2.5 bg-slate-700 hover:bg-slate-500"
              }`}
            />
          ))}
        </div>

        <button
          onClick={next}
          disabled={index === SLIDES.length - 1}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition enabled:hover:bg-blue-500 disabled:opacity-30"
        >
          Next <ChevronRight className="h-4 w-4" />
        </button>
      </footer>
    </div>
  );
}
