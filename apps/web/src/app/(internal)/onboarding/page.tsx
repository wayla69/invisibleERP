'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Rocket, Check, Package } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type Step = { key: string; label: string; label_en: string; done: boolean };
type Status = { steps: Step[]; percent: number; installed_packs: string[] };
type Pack = { key: string; label: string; label_en: string; objects: number };

// E1 (Phase 26) — guided onboarding checklist + one-click industry packs (seed custom objects). No GL.
export default function OnboardingPage() {
  const { t, lang } = useLang();
  const status = useQuery<Status>({ queryKey: ['onboarding'], queryFn: () => api('/api/onboarding') });
  const packs = useQuery<{ packs: Pack[] }>({ queryKey: ['onboarding-packs'], queryFn: () => api('/api/onboarding/packs') });
  const [msg, setMsg] = useState('');
  const en = (thLabel: string, enLabel?: string) => (lang === 'th' ? thLabel : enLabel || thLabel);
  const toggle = useMutation({
    mutationFn: (s: Step) => api(`/api/onboarding/steps/${s.key}/${s.done ? 'reset' : 'complete'}`, { method: 'POST' }),
    onSuccess: () => status.refetch(),
  });
  const apply = useMutation({
    mutationFn: (key: string) => api<{ objects_created: number }>('/api/onboarding/apply-pack', { method: 'POST', body: JSON.stringify({ pack: key }) }),
    onSuccess: (r) => { setMsg(t('onb.applied', { n: r.objects_created })); status.refetch(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title={t('onb.title')} description={t('onb.subtitle')} />
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Rocket className="size-4 text-primary" /> {t('onb.steps_title')} {status.data && <span className="ml-2 text-xs text-muted-foreground">{status.data.percent}%</span>}</CardTitle></CardHeader>
          <CardContent>
            <StateView q={status}>
              {status.data && <div className="mb-3 h-1.5 rounded bg-primary/20"><div className="h-1.5 rounded bg-primary" style={{ width: `${status.data.percent}%` }} /></div>}
              <ul className="space-y-2">
                {(status.data?.steps ?? []).map((s) => (
                  <li key={s.key} className="flex items-center gap-2">
                    <button onClick={() => toggle.mutate(s)} className={`flex size-5 items-center justify-center rounded border ${s.done ? 'bg-primary text-white' : ''}`} aria-label={en(s.label, s.label_en)}>{s.done && <Check className="size-3" />}</button>
                    <span className={s.done ? 'text-muted-foreground line-through' : ''}>{en(s.label, s.label_en)}</span>
                  </li>
                ))}
              </ul>
            </StateView>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Package className="size-4 text-primary" /> {t('onb.packs_title')}</CardTitle></CardHeader>
          <CardContent>
            <StateView q={packs}>
              <ul className="space-y-2">
                {(packs.data?.packs ?? []).map((p) => {
                  const installed = (status.data?.installed_packs ?? []).includes(p.key);
                  return (
                    <li key={p.key} className="flex items-center justify-between rounded border p-2">
                      <span>{en(p.label, p.label_en)} <span className="text-xs text-muted-foreground">({t('onb.objects_n', { n: p.objects })})</span></span>
                      <Button variant="outline" size="sm" disabled={apply.isPending || installed} onClick={() => apply.mutate(p.key)}>{installed ? t('onb.installed') : t('onb.install')}</Button>
                    </li>
                  );
                })}
              </ul>
              {msg && <p className="mt-2 text-sm text-muted-foreground">{msg}</p>}
            </StateView>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
