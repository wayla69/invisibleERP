'use client';

import { useQuery } from '@tanstack/react-query';
import { api, getToken } from './api';

export interface Me {
  username: string;
  role: string;
  customer_name: string | null;
  permissions: string[];
  must_change_password?: boolean;
}

export function useMe() {
  return useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api<Me>('/api/auth/me'),
    enabled: typeof window !== 'undefined' && !!getToken(),
  });
}

export function hasPerm(me: Me | undefined, ...perms: string[]): boolean {
  if (!me) return false;
  if (me.role === 'Admin') return true;
  return perms.some((p) => me.permissions.includes(p));
}
