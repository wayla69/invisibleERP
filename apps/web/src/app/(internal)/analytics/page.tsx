// Server shell for the Analytics Home — the single entry point that unifies the previously scattered
// analytics surfaces (insights, BI, query studio, NL analytics, dashboards, scheduled reports, planning).
// It is a pure launcher hub (no server data to prefetch), so it just renders the client island, which needs
// the client-side i18n context (useLang) for its labels — the canonical shell + island pattern.
import AnalyticsHome from './analytics-client';

export const dynamic = 'force-dynamic';

export default function AnalyticsHomePage() {
  return <AnalyticsHome />;
}
