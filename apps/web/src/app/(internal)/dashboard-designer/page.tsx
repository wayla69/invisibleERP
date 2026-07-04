'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LayoutDashboard, Save, ArrowUp, ArrowDown, X } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useLang } from '@/lib/i18n';

interface Widget { key: string; label: string; label_en: string; unit: string; perms: string[] }
interface Catalog { widgets: Widget[]; roles: string[] }

export default function DashboardDesignerPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const cat = useQuery<Catalog>({ queryKey: ['dash-catalog'], queryFn: () => api('/api/dashboard/widgets/catalog') });
  const [role, setRole] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const roles = cat.data?.roles ?? [];
  const widgets = cat.data?.widgets ?? [];
  const byKey = (k: string) => widgets.find((w) => w.key === k);

  useEffect(() => { if (!role && roles.length) setRole(roles[0]); }, [roles, role]);

  const layout = useQuery<{ role: string; widgets: string[]; configured: boolean }>({
    queryKey: ['dash-layout', role], queryFn: () => api(`/api/dashboard/layouts/${role}`), enabled: !!role,
  });
  useEffect(() => { if (layout.data) setSelected(layout.data.widgets ?? []); }, [layout.data]);

  const save = useMutation({
    mutationFn: () => api(`/api/dashboard/layouts/${role}`, { method: 'PUT', body: JSON.stringify({ widgets: selected }) }),
    onSuccess: () => { setMsg(`✅ ${t('mx.dd_saved', { role })}`); qc.invalidateQueries({ queryKey: ['dash-layout', role] }); qc.invalidateQueries({ queryKey: ['dashboard-mine'] }); },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });

  const add = (k: string) => setSelected((s) => (s.includes(k) ? s : [...s, k]));
  const remove = (k: string) => setSelected((s) => s.filter((x) => x !== k));
  const move = (i: number, dir: -1 | 1) => setSelected((s) => {
    const j = i + dir; if (j < 0 || j >= s.length) return s;
    const c = [...s]; [c[i], c[j]] = [c[j], c[i]]; return c;
  });

  return (
    <div>
      <PageHeader title={t('mx.dd_title')} description={t('mx.dd_desc')} />
      <div className="mb-4 max-w-xs">
        <Label>{t('mx.dd_role')}</Label>
        <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={role} onChange={(e) => setRole(e.target.value)}>
          {roles.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <StateView q={cat}>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-sm">{t('mx.dd_available_widgets')}</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {widgets.map((w) => (
                <div key={w.key} className="flex items-center justify-between rounded-md border px-3 py-2">
                  <div>
                    <div className="text-sm font-medium">{w.label} <span className="text-xs text-muted-foreground">/ {w.label_en}</span></div>
                    <div className="text-xs text-muted-foreground">{w.perms.join(', ')}</div>
                  </div>
                  <Button size="sm" variant="outline" disabled={selected.includes(w.key)} onClick={() => add(w.key)}>{t('mx.dd_add')}</Button>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm flex items-center gap-2"><LayoutDashboard className="h-4 w-4" />{t('mx.dd_role_dashboard', { role })} {layout.data?.configured === false && <Badge variant="muted">{t('mx.dd_default')}</Badge>}</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {selected.length === 0 && <div className="text-sm text-muted-foreground">{t('mx.dd_no_widgets')}</div>}
              {selected.map((k, i) => {
                const w = byKey(k);
                return (
                  <div key={k} className="flex items-center justify-between rounded-md border px-3 py-2">
                    <div className="text-sm font-medium">{i + 1}. {w?.label ?? k}</div>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="h-4 w-4" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === selected.length - 1}><ArrowDown className="h-4 w-4" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(k)}><X className="h-4 w-4" /></Button>
                    </div>
                  </div>
                );
              })}
              <div className="flex items-center gap-3 pt-2">
                <Button disabled={!role || save.isPending} onClick={() => save.mutate()}><Save className="mr-1 h-4 w-4" />{t('fin.save')}</Button>
                <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
              </div>
            </CardContent>
          </Card>
        </div>
      </StateView>
    </div>
  );
}
