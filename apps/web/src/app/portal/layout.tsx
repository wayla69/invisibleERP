'use client';

import { AppShell } from '@/components/app-shell';
import { PORTAL_NAV } from '@/lib/nav';

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell nav={PORTAL_NAV} brand="ร้านค้าของฉัน">
      {children}
    </AppShell>
  );
}
