// Typed party relationships section (master-data audit Phase 8). Lists a master record's relationships (both
// directions) and adds/deletes them. Generic over customer/vendor via the buildBody + URL props. No
// 'use client': imported only by already-'use client' pages (360°/party panels), inherits their boundary.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Users2, Trash2, Plus, ArrowRight, ArrowLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifyError, notifySuccess } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Relationship {
  id: number; rel_type: string; direction: 'outgoing' | 'incoming';
  party: { customer_no?: string; vendor_id?: number; name: string }; note?: string | null;
}

export function PartyRelationshipsSection({ listUrl, addUrl, deleteBase, queryKey, relTypes, targetPlaceholder, buildBody }: {
  listUrl: string; addUrl: string; deleteBase: string; queryKey: unknown[];
  relTypes: readonly string[]; targetPlaceholder: string; buildBody: (target: string, relType: string) => unknown;
}) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ relationships: Relationship[] }>({ queryKey, queryFn: () => api(listUrl) });
  const [target, setTarget] = useState('');
  const [relType, setRelType] = useState<string>(relTypes[0] ?? 'related_party');
  const refresh = () => qc.invalidateQueries({ queryKey });
  const add = useMutation({
    mutationFn: () => api<any>(addUrl, { method: 'POST', body: JSON.stringify(buildBody(target, relType)) }),
    onSuccess: () => { notifySuccess(t('mx.rel_added')); setTarget(''); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const del = useMutation({
    mutationFn: (id: number) => api<any>(`${deleteBase}/${id}`, { method: 'DELETE' }),
    onSuccess: () => { notifySuccess(t('mx.rel_deleted')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const rels = q.data?.relationships ?? [];
  return (
    <div className="grid gap-2">
      <h4 className="flex items-center gap-1.5 text-sm font-medium"><Users2 className="size-4" /> {t('mx.rel_title')}</h4>
      {rels.length === 0 && <p className="text-xs text-muted-foreground">{t('mx.rel_none')}</p>}
      {rels.map((r) => (
        <div key={`${r.direction}-${r.id}`} className="flex items-center gap-2 rounded-md border border-border/60 p-2 text-sm">
          {r.direction === 'outgoing' ? <ArrowRight className="size-4 text-muted-foreground" /> : <ArrowLeft className="size-4 text-muted-foreground" />}
          <Badge variant="secondary" className="text-xs">{t(`mx.rel_type_${r.rel_type}` as any)}</Badge>
          <span className="font-medium">{r.party.name}</span>
          {r.note && <span className="text-muted-foreground">· {r.note}</span>}
          {r.direction === 'outgoing' && (
            <Button variant="ghost" size="icon" className="ml-auto size-7" aria-label={t('mx.cm_delete')} onClick={() => del.mutate(r.id)}><Trash2 className="size-4" /></Button>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Select value={relType} onValueChange={setRelType}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>{relTypes.map((rt) => <SelectItem key={rt} value={rt}>{t(`mx.rel_type_${rt}` as any)}</SelectItem>)}</SelectContent>
        </Select>
        <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={targetPlaceholder} className="flex-1" />
        <Button size="sm" variant="outline" disabled={!target || add.isPending} onClick={() => add.mutate()}><Plus className="size-4" /> {t('mx.rel_add')}</Button>
      </div>
    </div>
  );
}
