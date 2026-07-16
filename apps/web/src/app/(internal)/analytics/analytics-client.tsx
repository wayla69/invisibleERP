'use client';

import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  Compass, Lightbulb, BarChart3, Table2, MessageSquare, LayoutDashboard, LayoutTemplate,
  Bookmark, CalendarClock, Goal, PiggyBank, LineChart, PieChart, ArrowRight,
} from 'lucide-react';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';

// The Analytics Home unifies the analytics surfaces that used to live as scattered nav links (insights, BI,
// query studio, NL analytics, dashboards, scheduled reports, planning). Pure launcher — access control is
// enforced at each destination page, so this hub can safely show the whole map of what's available.
interface Tile { href: string; label: string; desc: string; icon: LucideIcon }
interface Section { key: string; title: string; tiles: Tile[] }

const SECTIONS: Section[] = [
  {
    key: 'explore', title: 'ah.sec_explore', tiles: [
      { href: '/insights', label: 'nav.insights', desc: 'ah.desc_insights', icon: Lightbulb },
      { href: '/bi', label: 'nav.bi', desc: 'ah.desc_bi', icon: BarChart3 },
      { href: '/query', label: 'nav.query', desc: 'ah.desc_query', icon: Table2 },
      { href: '/nl-analytics', label: 'nav.nl_analytics', desc: 'ah.desc_nl', icon: MessageSquare },
    ],
  },
  {
    key: 'monitor', title: 'ah.sec_monitor', tiles: [
      { href: '/dashboard', label: 'nav.dashboard', desc: 'ah.desc_dashboard', icon: LayoutDashboard },
      { href: '/dashboard-designer', label: 'nav.dashboard_designer', desc: 'ah.desc_designer', icon: LayoutTemplate },
      { href: '/saved-views', label: 'nav.saved_views', desc: 'ah.desc_saved', icon: Bookmark },
    ],
  },
  {
    key: 'deliver', title: 'ah.sec_deliver', tiles: [
      { href: '/scheduled-reports', label: 'nav.scheduled_reports', desc: 'ah.desc_scheduled', icon: CalendarClock },
    ],
  },
  {
    key: 'plan', title: 'ah.sec_plan', tiles: [
      { href: '/planning', label: 'nav.planning', desc: 'ah.desc_planning', icon: Goal },
      { href: '/budget', label: 'nav.budget', desc: 'ah.desc_budget', icon: PiggyBank },
      { href: '/demand', label: 'nav.demand', desc: 'ah.desc_demand', icon: LineChart },
      { href: '/profitability', label: 'nav.profitability', desc: 'ah.desc_profitability', icon: PieChart },
      { href: '/mmm', label: 'nav.mmm', desc: 'ah.desc_mmm', icon: BarChart3 },
    ],
  },
];

type TFn = (key: string, vars?: Record<string, string | number>) => string;

function TileCard({ tile, t }: { tile: Tile; t: TFn }) {
  const Icon = tile.icon;
  return (
    <Link
      href={tile.href}
      className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 font-medium text-foreground">
          {t(tile.label)}
          <ArrowRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-60" />
        </span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{t(tile.desc)}</span>
      </span>
    </Link>
  );
}

export default function AnalyticsHome() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Compass className="size-6 text-primary" />
            {t('ah.title')}
          </span>
        }
        description={t('ah.subtitle')}
      />
      <div className="flex flex-col gap-8">
        {SECTIONS.map((s) => (
          <section key={s.key}>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t(s.title)}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {s.tiles.map((tile) => (
                <TileCard key={tile.href} tile={tile} t={t} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
