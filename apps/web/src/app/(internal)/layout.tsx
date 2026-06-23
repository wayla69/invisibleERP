'use client';

import { AppShell } from '@/components/app-shell';
import { INTERNAL_NAV } from '@/lib/nav';
import { LanguageProvider } from '@/lib/i18n';

export default function InternalLayout({ children }: { children: React.ReactNode }) {
  return (
    <LanguageProvider>
      <AppShell nav={INTERNAL_NAV} brand="Invisible ERP" filterPerms enableWorkspaces>
        {children}
      </AppShell>
    </LanguageProvider>
  );
}
