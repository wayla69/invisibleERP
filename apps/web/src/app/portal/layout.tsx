// Server component (see (internal)/layout.tsx): passes only serializable props; AppShell selects its nav
// tree from `variant` so the icon-bearing PORTAL_NAV never crosses the RSC boundary.
import { AppShell } from '@/components/app-shell';

// Locale context comes from the root layout's app-wide LanguageProvider.
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell variant="portal" brand="pt.brand">
      {children}
    </AppShell>
  );
}
