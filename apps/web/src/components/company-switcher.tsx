'use client';

import * as React from 'react';
import { Building2, Check, ChevronsUpDown, Globe } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { api, getActingTenant, setActingTenant, type ActingTenant } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface Company {
  id: number;
  code: string;
  name: string;
  suspended: boolean;
}

/**
 * Cross-company switcher for the platform owner ("god"). A god otherwise sees every company's data combined
 * with no way to tell which company a row belongs to. Picking a company here stores it (api.setActingTenant)
 * so every request carries `X-Act-As-Tenant` and the server narrows the god's RLS scope to that one company;
 * "ทุกบริษัท" clears it and restores the global view. The trigger doubles as the current-company badge.
 * Rendered ONLY for a god (`me.is_platform_owner`) — ordinary users never see it.
 */
export function CompanySwitcher() {
  const { data: companies } = useQuery<Company[]>({
    queryKey: ['admin-tenants'],
    queryFn: () => api<Company[]>('/api/admin/tenants'),
    staleTime: 5 * 60_000,
  });
  const [acting, setActing] = React.useState<ActingTenant | null>(null);
  React.useEffect(() => setActing(getActingTenant()), []);

  const pick = (t: ActingTenant | null) => {
    setActingTenant(t);
    // Reload so every cached query refetches under the new scope (see setActingTenant).
    window.location.reload();
  };

  const currentName = acting?.name ?? 'ทุกบริษัท';
  const isGlobal = acting == null;

  return (
    <div className="px-1 pb-1 group-data-[collapsible=icon]:hidden">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted',
              isGlobal ? 'border-dashed text-muted-foreground' : 'border-primary/40 bg-primary/5 text-foreground',
            )}
            aria-label="เลือกบริษัทที่ต้องการดูข้อมูล"
          >
            {isGlobal ? <Globe className="size-3.5 shrink-0" /> : <Building2 className="size-3.5 shrink-0 text-primary" />}
            <span className="grid flex-1 leading-tight">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">กำลังดูข้อมูลของ</span>
              <span className="truncate font-medium">{currentName}</span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[60vh] w-64 overflow-y-auto">
          <DropdownMenuLabel className="text-xs">มุมมองผู้ดูแลแพลตฟอร์ม (god)</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => pick(null)} className="gap-2">
            <Globe className="size-4" />
            <span className="flex-1">ทุกบริษัท (รวม)</span>
            {isGlobal && <Check className="size-4 text-primary" />}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {(companies ?? []).map((c) => (
            <DropdownMenuItem key={c.id} onClick={() => pick({ id: c.id, name: c.name, code: c.code })} className="gap-2">
              <Building2 className="size-4" />
              <span className="grid flex-1 leading-tight">
                <span className={cn('truncate', c.suspended && 'text-muted-foreground line-through')}>{c.name}</span>
                <span className="truncate text-[10px] text-muted-foreground">
                  {c.code}
                  {c.suspended ? ' · ระงับ' : ''}
                </span>
              </span>
              {acting?.id === c.id && <Check className="size-4 text-primary" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
