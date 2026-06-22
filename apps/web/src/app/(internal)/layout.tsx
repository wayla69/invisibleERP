'use client';

import { AppShell } from '@/components/app-shell';
import { INTERNAL_NAV } from '@/lib/nav';

export default function InternalLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell nav={INTERNAL_NAV} brand="Invisible ERP" filterPerms>
      {children}
    </AppShell>
  );
}
