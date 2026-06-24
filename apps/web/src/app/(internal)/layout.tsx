'use client';

import { AppShell } from '@/components/app-shell';
import { INTERNAL_NAV } from '@/lib/nav';
import { LanguageProvider } from '@/lib/i18n';
import { ThemeApplier } from '@/components/theme-applier';

export default function InternalLayout({ children }: { children: React.ReactNode }) {
  return (
    <LanguageProvider>
      <ThemeApplier />
      <AppShell nav={INTERNAL_NAV} brand="Invisible ERP" filterPerms enableWorkspaces>
        {children}
      </AppShell>
    </LanguageProvider>
  );
}
