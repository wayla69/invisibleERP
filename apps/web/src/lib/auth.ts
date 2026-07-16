'use client';

import { useQuery } from '@tanstack/react-query';
import { api, hasSession } from './api';

export interface Me {
  username: string;
  role: string;
  customer_name: string | null;
  permissions: string[];
  must_change_password?: boolean;
  is_platform_owner?: boolean; // configured platform owner ("god") — gates the cross-company switcher
  control_profile?: 'enterprise' | 'sme'; // docs/49 — 'sme' shows the SME-mode banner + hides configured nav groups
  sme_hidden_nav_groups?: string[];       // nav group title-keys hidden for this SME tenant
  sme_open_nav_groups?: string[];         // B1 (docs/50) — industry-derived group/subgroup keys open by default
}

export function useMe() {
  return useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api<Me>('/api/auth/me'),
    enabled: typeof window !== 'undefined' && !!hasSession(),
  });
}

export function hasPerm(me: Me | undefined, ...perms: string[]): boolean {
  if (!me) return false;
  if (me.role === 'Admin') return true;
  return perms.some((p) => me.permissions.includes(p));
}
