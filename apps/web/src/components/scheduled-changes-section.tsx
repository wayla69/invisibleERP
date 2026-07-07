// Date-effective (future-dated) master changes section (master-data audit Phase 12). Schedules a change to a
// master field that the daily job applies once its effective date arrives, and lists/cancels this record's
// pending schedule. Generic over the entity via props. No 'use client': imported only by already-'use client'
// setup pages, so it inherits their boundary (keeps the check-use-client ratchet flat).
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Trash2, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifyError, notifySuccess } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface ScheduledChange {
  id: number; entity: string; entity_key: string; field: string; new_value: string;
  effective_date: string; status: string; sensitive: boolean;
}

export function ScheduledChangesSection({ entity, entityKey, fields }: {
  entity: string; entityKey: string; fields: readonly string[];
}) {
  const { t } = useLang();
  const qc = useQueryClient();
  const queryKey = ['scheduled-changes', entity, entityKey];
  const q = useQuery<{ changes: ScheduledChange[] }>({ queryKey, queryFn: () => api('/api/scheduled-changes') });
  const [field, setField] = useState<string>(fields[0] ?? '');
  const [value, setValue] = useState('');
  const [date, setDate] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey });
  const add = useMutation({
    mutationFn: () => api<any>('/api/scheduled-changes', { method: 'POST', body: JSON.stringify({ entity, entity_key: entityKey, field, new_value: value, effective_date: date }) }),
    onSuccess: () => { notifySuccess(t('mx.sched_added')); setValue(''); setDate(''); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const cancel = useMutation({
    mutationFn: (id: number) => api<any>(`/api/scheduled-changes/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('mx.sched_cancelled')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const mine = (q.data?.changes ?? []).filter((c) => c.entity === entity && c.entity_key === entityKey && (c.status === 'scheduled' || c.status === 'pending_approval'));
  return (
    <div className="grid gap-2">
      <h4 className="flex items-center gap-1.5 text-sm font-medium"><CalendarClock className="size-4" /> {t('mx.sched_title')}</h4>
      {mine.length === 0 && <p className="text-xs text-muted-foreground">{t('mx.sched_none')}</p>}
      {mine.map((c) => (
        <div key={c.id} className="flex items-center gap-2 rounded-md border border-border/60 p-2 text-sm">
          <span className="font-medium">{c.field}</span>
          <span className="text-muted-foreground">→ {c.new_value}</span>
          <Badge variant="outline" className="text-xs">{c.effective_date}</Badge>
          <Badge variant={c.status === 'pending_approval' ? 'secondary' : 'success'} className="text-xs">{t(`mx.sched_status_${c.status}` as any)}</Badge>
          <Button variant="ghost" size="icon" className="ml-auto size-7" aria-label={t('mx.sched_cancel')} onClick={() => cancel.mutate(c.id)}><Trash2 className="size-4" /></Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={field} onValueChange={setField}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>{fields.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}</SelectContent>
        </Select>
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('mx.sched_new_value')} className="w-32" />
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
        <Button size="sm" variant="outline" disabled={!value || !date || add.isPending} onClick={() => add.mutate()}><Plus className="size-4" /> {t('mx.sched_add')}</Button>
      </div>
    </div>
  );
}
