'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Globe, Check, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useLang } from '@/lib/i18n';

type Pack = { country: string; label: string; label_th: string; status: string; locale: string; einvoice_provider: string; coa_preview: string[]; tax_codes: string[]; statutory_reports: string[] };
type Active = { active: { country: string; version: string } | null };

// C2 (Phase 21) — country localization packs. Applying sets tax country + locale; no GL.
export default function LocalizationPage() {
  const { t } = useLang();
  const packs = useQuery<{ packs: Pack[] }>({ queryKey: ['loc-packs'], queryFn: () => api('/api/localization/packs') });
  const active = useQuery<Active>({ queryKey: ['loc-active'], queryFn: () => api('/api/localization') });
  const [msg, setMsg] = useState('');
  const apply = useMutation({
    mutationFn: (c: string) => api<{ country: string; locale: string }>('/api/localization/apply', { method: 'POST', body: JSON.stringify({ country: c }) }),
    onSuccess: (r) => { setMsg(t('mx.lc_applied', { country: r.country, locale: r.locale })); active.refetch(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title={t('mx.lc_title')} description={t('mx.lc_desc')} />
      {active.data?.active && <p className="mb-4 text-sm text-muted-foreground">{t('mx.lc_active_pack')}: <span className="font-medium">{active.data.active.country}</span></p>}
      <StateView q={packs}>
        <div className="grid gap-4 md:grid-cols-2">
          {(packs.data?.packs ?? []).map((p) => (
            <Card key={p.country}>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Globe className="size-4 text-primary" /> {p.label} ({p.country}) <span className={`ml-2 rounded px-2 py-0.5 text-xs ${p.status === 'certified' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{p.status}</span></CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p>{t('mx.lc_language')}: {p.locale} · e-Invoice: <span className="font-mono text-xs">{p.einvoice_provider}</span></p>
                <p className="text-xs text-muted-foreground">{t('mx.lc_coa_summary', { count: p.coa_preview.length, taxes: p.tax_codes.join(', '), reports: p.statutory_reports.join(', ') })}</p>
                <Button variant="outline" size="sm" disabled={apply.isPending} onClick={() => apply.mutate(p.country)}><Check className="size-3" /> {t('mx.lc_apply_this')}</Button>
              </CardContent>
            </Card>
          ))}
        </div>
        {msg && <p className="mt-3 text-sm text-muted-foreground">{msg}</p>}
      </StateView>
    </div>
  );
}
