'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';

import { api, hasSession } from '@/lib/api';
import { thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface InboxItem {
  id: number;
  message: string | null;
  message_en: string | null;
  target_role: string | null;
  created_at: string | null;
  is_read: boolean;
}
interface Inbox { items: InboxItem[]; total: number; unread_count: number }

// Header bell: polls the unread count, and on open shows the most recent notifications with
// a one-click "mark read". Everything is scoped server-side to the caller's tenant + role.
export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const enabled = typeof window !== 'undefined' && !!hasSession();

  // Lightweight badge poll (every 30s). The full list is only fetched while the menu is open.
  const count = useQuery<{ unread_count: number }>({
    queryKey: ['notif-unread'],
    queryFn: () => api('/api/notifications/unread-count'),
    enabled,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const inbox = useQuery<Inbox>({
    queryKey: ['notif-inbox', 'preview'],
    queryFn: () => api('/api/notifications/inbox?limit=8'),
    enabled: enabled && open,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['notif-unread'] });
    qc.invalidateQueries({ queryKey: ['notif-inbox'] });
  };
  const markRead = useMutation({
    mutationFn: (id: number) => api(`/api/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const markAll = useMutation({
    mutationFn: () => api('/api/notifications/mark-all-read', { method: 'POST' }),
    onSuccess: refresh,
  });

  const unread = count.data?.unread_count ?? 0;
  const items = inbox.data?.items ?? [];

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`การแจ้งเตือน${unread ? ` (${unread} ยังไม่อ่าน)` : ''}`}>
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">การแจ้งเตือน</span>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-muted-foreground"
              onClick={() => markAll.mutate()}
              disabled={markAll.isPending}
            >
              <CheckCheck className="size-3.5" />
              อ่านทั้งหมด
            </Button>
          )}
        </div>

        <div className="max-h-80 overflow-y-auto">
          {inbox.isLoading ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">กำลังโหลด…</p>
          ) : items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">ไม่มีการแจ้งเตือน</p>
          ) : (
            items.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => !it.is_read && markRead.mutate(it.id)}
                className={cn(
                  'flex w-full items-start gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent',
                  !it.is_read && 'bg-primary/5',
                )}
              >
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', it.is_read ? 'bg-transparent' : 'bg-primary')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground">{it.message ?? it.message_en ?? '—'}</span>
                  <span className="block text-xs text-muted-foreground">{thaiDate(it.created_at)}</span>
                </span>
              </button>
            ))
          )}
        </div>

        <Link
          href="/notifications"
          onClick={() => setOpen(false)}
          className="block border-t px-3 py-2 text-center text-sm font-medium text-primary hover:bg-accent"
        >
          ดูทั้งหมด
        </Link>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
