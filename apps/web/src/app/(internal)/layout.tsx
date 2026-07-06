// Server component: renders the client LanguageProvider/ThemeApplier/AppShell as children (standard RSC
// composition — cf. RootLayout rendering ThemeProvider). Passes only serializable props; AppShell selects
// its nav tree internally from `variant` so the icon-bearing nav never crosses the RSC boundary.
import { AppShell } from '@/components/app-shell';
import { LanguageProvider } from '@/lib/i18n';
import { ThemeApplier } from '@/components/theme-applier';

export default function InternalLayout({ children }: { children: React.ReactNode }) {
  return (
    <LanguageProvider>
      <ThemeApplier />
      <AppShell variant="internal" brand="Invisible ERP" filterPerms enableWorkspaces>
        {children}
      </AppShell>
    </LanguageProvider>
  );
}
