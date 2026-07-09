'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

type Flag = { key: string; label: string; description: string; tier: 'CORE' | 'LABS'; enabled: boolean; source: string };

export default function LabsSettingsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ flags: Flag[] }>({ queryKey: ['feature-flags'], queryFn: () => api('/api/feature-flags') });

  const toggle = useMutation({
    mutationFn: (v: { key: string; enabled: boolean }) => api(`/api/feature-flags/${encodeURIComponent(v.key)}`, { method: 'PUT', body: JSON.stringify({ enabled: v.enabled }) }),
    onSuccess: () => { notifySuccess(t('st.labs.saved')); qc.invalidateQueries({ queryKey: ['feature-flags'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const labs = (q.data?.flags ?? []).filter((f) => f.tier === 'LABS');
  const master = (q.data?.flags ?? []).find((f) => f.key === 'labs_visible');
  // PDPA disclosure + per-tenant opt-out for external AI processing (flag registry: feature-flags.service).
  const aiConsent = (q.data?.flags ?? []).find((f) => f.key === 'ai_external_processing');

  return (
    <div>
      <PageHeader
        title={t('st.labs.title')}
        description={t('st.labs.desc')}
      />
      <StateView q={q}>
        {q.data && (
          <div className="space-y-6">
            {aiConsent && (
              <div className="rounded-xl border bg-card">
                <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold"><ShieldCheck className="size-4 text-primary" /> {t('st.labs.ai_privacy')}</div>
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <div>
                    <div className="font-medium">{aiConsent.label}</div>
                    <div className="text-sm text-muted-foreground">{aiConsent.description}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{t('st.labs.ai_privacy_note')}</div>
                  </div>
                  <Button variant={aiConsent.enabled ? 'default' : 'outline'} disabled={toggle.isPending} onClick={() => toggle.mutate({ key: aiConsent.key, enabled: !aiConsent.enabled })}>
                    {aiConsent.enabled ? t('st.labs.on') : t('st.labs.off')}
                  </Button>
                </div>
              </div>
            )}
            {master && (
              <div className="flex items-center justify-between rounded-xl border bg-card p-4">
                <div>
                  <div className="font-medium">{master.label}</div>
                  <div className="text-sm text-muted-foreground">{master.description}</div>
                </div>
                <Button variant={master.enabled ? 'default' : 'outline'} disabled={toggle.isPending} onClick={() => toggle.mutate({ key: master.key, enabled: !master.enabled })}>
                  {master.enabled ? t('st.labs.on') : t('st.labs.off')}
                </Button>
              </div>
            )}
            <div className="rounded-xl border bg-card">
              <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold"><FlaskConical className="size-4 text-primary" /> {t('st.labs.section')}</div>
              <ul className="divide-y">
                {labs.map((f) => (
                  <li key={f.key} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <div className="flex items-center gap-2 font-medium">{f.label} <Badge variant="muted" className="text-[10px]">Labs</Badge></div>
                      <div className="text-sm text-muted-foreground">{f.description}</div>
                    </div>
                    <Button size="sm" variant={f.enabled ? 'default' : 'outline'} disabled={toggle.isPending} onClick={() => toggle.mutate({ key: f.key, enabled: !f.enabled })}>
                      {f.enabled ? t('st.labs.enable') : t('st.labs.disable')}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </StateView>
    </div>
  );
}
