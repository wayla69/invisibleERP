'use client';

import { AppShell } from '@/components/app-shell';
import { PORTAL_NAV } from '@/lib/nav';
import { LanguageProvider } from '@/lib/i18n';

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <LanguageProvider>
      <AppShell nav={PORTAL_NAV} brand="ร้านค้าของฉัน">
        {children}
      </AppShell>
    </LanguageProvider>
  );
}
