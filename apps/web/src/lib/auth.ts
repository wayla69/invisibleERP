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
