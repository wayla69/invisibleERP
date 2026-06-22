'use client';

import { useQuery } from '@tanstack/react-query';
import { api, getToken } from './api';

export interface ModuleFlag { key: string; enabled: boolean; always_on: boolean }
export interface ModuleFlags { modules: ModuleFlag[]; disabled: string[] }

// Effective module flags for the CURRENT user (any role) — used to hide disabled
// modules from the nav. Read-only endpoint; the admin write endpoint is gated.
export function useModuleFlags() {
  return useQuery<ModuleFlags>({
    queryKey: ['module-flags'],
    queryFn: () => api<ModuleFlags>('/api/modules/effective'),
    enabled: typeof window !== 'undefined' && !!getToken(),
    staleTime: 30_000,
  });
}

export function humanizeModule(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
