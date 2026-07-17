// Server component (see (internal)/layout.tsx): passes only serializable props; AppShell selects its nav
// tree from `variant` so the icon-bearing PORTAL_NAV never crosses the RSC boundary.
import { AppShell } from '@/components/app-shell';
import { LanguageProvider } from '@/lib/i18n';

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <LanguageProvider>
      <AppShell variant="portal" brand="pt.brand">
        {children}
      </AppShell>
    </LanguageProvider>
  );
}
