// Marketing Activation (docs/61) — shared look-and-feel helpers for the /marketing-activation islands.
// NO 'use client' directive: everything here is imported only by the already-'use client'
// /marketing-activation page tree, so it inherits that client boundary (keeps the use-client ratchet flat —
// same pattern as marketing-intel/budget-planner.tsx). The pastel "Marketing Studio" tone is built from the
// app's own chart tokens via color-mix, so every tint auto-adapts to light AND dark themes. No ฿ anywhere —
// amounts render through thb()/compactThb() ("48,000 THB") per the approved marketing style.
import type { CSSProperties, ComponentType, ReactNode } from 'react';

export const HUES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
export const tintBg = (h: string, pct = 9): CSSProperties => ({
  background: `color-mix(in oklch, ${h} ${pct}%, var(--card))`,
  borderColor: `color-mix(in oklch, ${h} 16%, var(--border))`,
});
export const softText = (h: string): CSSProperties => ({ color: `color-mix(in oklch, ${h} 66%, var(--foreground))` });
export const fill = (h: string): string => `color-mix(in oklch, ${h} 78%, var(--card))`;

// One-shot staggered entrance (tw-animate-css) — the "lively" ingredient of the marketing screens.
export const ENTER = 'animate-in fade-in-0 slide-in-from-bottom-3 duration-500 fill-mode-both';
export const stagger = (i: number): CSSProperties => ({ animationDelay: `${i * 55}ms` });

interface IconProps { className?: string; style?: CSSProperties }

// Soft pastel KPI tile (mirrors the marketing-intel KpiCard, THB-safe values passed in by the caller).
export function KpiCard({ hue, icon: Icon, label, value, sub }: {
  hue: string; icon: ComponentType<IconProps>; label: ReactNode; value: ReactNode; sub?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md" style={tintBg(hue)}>
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="flex size-7 items-center justify-center rounded-lg bg-background/70 shadow-sm">
          <Icon className="size-4" style={softText(hue)} />
        </span>
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {sub != null && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

// The guardrail footnote every tool card carries (consent / maker-checker / holdout / cap) — soft, not scary.
export function SoftNote({ hue = 'var(--chart-3)', children }: { hue?: string; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
      <span className="mt-px font-semibold" style={softText(hue)}>◆</span>
      <span>{children}</span>
    </p>
  );
}

// Little rounded pill (risk %, lift, arm, status …).
export function Chip({ hue, children }: { hue: string; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold"
      style={{ ...tintBg(hue, 14), ...softText(hue) }}
    >
      {children}
    </span>
  );
}

// Dashed friendly empty state (no data yet → invite, don't scold).
export function EmptyCard({ hue, icon: Icon, title, desc }: {
  hue: string; icon: ComponentType<IconProps>; title: ReactNode; desc?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed p-10 text-center" style={tintBg(hue, 8)}>
      <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-background/70 shadow-sm">
        <Icon className="size-6" style={softText(hue)} />
      </div>
      <p className="text-sm font-semibold">{title}</p>
      {desc != null && <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">{desc}</p>}
    </div>
  );
}

// Horizontal soft meter (allocation shares, ROI bars).
export function Meter({ hue, pctWidth }: { hue: string; pctWidth: number }) {
  return (
    <div className="h-2 flex-1 overflow-hidden rounded-full bg-background/60">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.min(100, Math.max(3, pctWidth))}%`, background: fill(hue) }}
      />
    </div>
  );
}
