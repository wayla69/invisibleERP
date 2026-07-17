// Server component: renders the client ThemeApplier/AppShell as children (standard RSC composition — cf.
// RootLayout rendering ThemeProvider). Passes only serializable props; AppShell selects its nav tree
// internally from `variant` so the icon-bearing nav never crosses the RSC boundary. Locale context comes
// from the root layout's app-wide LanguageProvider.
import { AppShell } from '@/components/app-shell';
import { ThemeApplier } from '@/components/theme-applier';

export default function InternalLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ThemeApplier />
      <AppShell variant="internal" brand="Invisible ERP" filterPerms enableWorkspaces>
        {children}
      </AppShell>
    </>
  );
}
