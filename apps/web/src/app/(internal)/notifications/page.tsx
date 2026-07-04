'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, Check } from 'lucide-react';

import { api } from '@/lib/api';
import { thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { InboxItem } from '@/components/notification-bell';

interface Inbox { items: InboxItem[]; total: number; unread_count: number }

export default function NotificationsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);

  const q = useQuery<Inbox>({
    queryKey: ['notif-inbox', 'page', unreadOnly],
    queryFn: () => api(`/api/notifications/inbox?limit=100${unreadOnly ? '&unread_only=1' : ''}`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['notif-inbox'] });
    qc.invalidateQueries({ queryKey: ['notif-unread'] });
  };
  const markRead = useMutation({ mutationFn: (id: number) => api(`/api/notifications/${id}/read`, { method: 'POST' }), onSuccess: refresh });
  const markAll = useMutation({ mutationFn: () => api('/api/notifications/mark-all-read', { method: 'POST' }), onSuccess: refresh });

  const items = q.data?.items ?? [];
  const unread = q.data?.unread_count ?? 0;

  return (
    <div>
      <PageHeader
        title={t('pb.notif_title')}
        description={t('pb.notif_subtitle')}
        actions={
          <div className="flex items-center gap-2">
            <Button variant={unreadOnly ? 'default' : 'outline'} size="sm" onClick={() => setUnreadOnly((v) => !v)}>
              {t('pb.notif_unread_only')}{unread ? ` (${unread})` : ''}
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => markAll.mutate()} disabled={!unread || markAll.isPending}>
              <CheckCheck className="size-4" />
              {t('pb.notif_mark_all')}
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="p-0">
          <StateView q={q}>
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-muted-foreground">
                <Bell className="size-8" />
                <p className="text-sm">{unreadOnly ? t('pb.notif_no_unread') : t('pb.notif_none')}</p>
              </div>
            ) : (
              <ul className="divide-y">
                {items.map((it) => (
                  <li key={it.id} className={cn('flex items-start gap-3 px-4 py-3', !it.is_read && 'bg-primary/5')}>
                    <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', it.is_read ? 'bg-muted-foreground/30' : 'bg-primary')} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-foreground">{it.message ?? it.message_en ?? '—'}</p>
                        {!it.target_role && <Badge variant="secondary" className="text-[10px]">{t('pb.notif_broadcast')}</Badge>}
                      </div>
                      {it.message_en && it.message_en !== it.message && (
                        <p className="text-sm text-muted-foreground">{it.message_en}</p>
                      )}
                      <p className="mt-0.5 text-xs text-muted-foreground">{thaiDate(it.created_at)}</p>
                    </div>
                    {!it.is_read && (
                      <Button variant="ghost" size="sm" className="gap-1 text-xs text-muted-foreground" disabled={markRead.isPending} onClick={() => markRead.mutate(it.id)}>
                        <Check className="size-3.5" />
                        {t('pb.notif_mark_read')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </StateView>
        </CardContent>
      </Card>
    </div>
  );
}
