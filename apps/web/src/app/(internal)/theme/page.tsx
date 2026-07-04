'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Palette, Save, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLang } from '@/lib/i18n';

type Theme = { primary_hue: number; radius: string; brand_name: string; logo_url: string; tagline: string; primary_css: string; radius_css: string };
const RADIUS: Record<string, string> = { sm: '0.375rem', md: '0.625rem', lg: '0.875rem' };

// E4 (Phase 29) — white-label theming editor. Presentation-only; applies live + persists per tenant.
export default function ThemePage() {
  const { t: tr } = useLang();
  const q = useQuery<{ theme: Theme }>({ queryKey: ['tenant-theme'], queryFn: () => api('/api/tenant/theme') });
  const [t, setT] = useState<Theme | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { if (q.data?.theme && !t) setT(q.data.theme); }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () => api<{ theme: Theme }>('/api/tenant/theme', { method: 'PUT', body: JSON.stringify({ primary_hue: t!.primary_hue, radius: t!.radius, brand_name: t!.brand_name, logo_url: t!.logo_url, tagline: t!.tagline }) }),
    onSuccess: (r) => { setT(r.theme); setMsg(tr('mx.thm_saved')); const el = document.documentElement; el.style.setProperty('--primary', r.theme.primary_css); el.style.setProperty('--radius', r.theme.radius_css); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const upd = (k: keyof Theme, v: any) => setT((p) => (p ? { ...p, [k]: v } : p));
  const previewCss = t ? `oklch(0.48 0.17 ${t.primary_hue})` : '';

  return (
    <div>
      <PageHeader title={tr('mx.thm_title')} description={tr('mx.thm_desc')} />
      <StateView q={q}>
        {t && (
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Palette className="size-4 text-primary" /> {tr('mx.thm_brand_tokens')}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-1">
                  <Label>{tr('mx.thm_brand_color', { hue: t.primary_hue })}</Label>
                  <input type="range" min={0} max={360} value={t.primary_hue} onChange={(e) => upd('primary_hue', Number(e.target.value))} />
                </div>
                <div className="grid gap-1"><Label>{tr('mx.thm_radius')}</Label>
                  <select className="h-9 rounded-md border bg-transparent px-3 text-sm" value={t.radius} onChange={(e) => upd('radius', e.target.value)}>
                    <option value="sm">{tr('mx.thm_radius_sm')}</option><option value="md">{tr('mx.thm_radius_md')}</option><option value="lg">{tr('mx.thm_radius_lg')}</option>
                  </select>
                </div>
                <div className="grid gap-1"><Label>{tr('mx.thm_brand_name')}</Label><Input value={t.brand_name} onChange={(e) => upd('brand_name', e.target.value)} placeholder={tr('mx.thm_brand_name_ph')} /></div>
                <div className="grid gap-1"><Label>{tr('mx.thm_logo')}</Label><Input value={t.logo_url} onChange={(e) => upd('logo_url', e.target.value)} placeholder="https://…" /></div>
                <div className="grid gap-1"><Label>{tr('mx.thm_tagline')}</Label><Input value={t.tagline} onChange={(e) => upd('tagline', e.target.value)} /></div>
                <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} {tr('fin.save')}</Button>
                {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">{tr('mx.thm_preview')}</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-3">
                  {t.logo_url ? <img src={t.logo_url} alt="" className="h-10 w-10 rounded object-contain" /> : <div className="h-10 w-10 rounded" style={{ background: previewCss }} />}
                  <div><div className="font-semibold">{t.brand_name || tr('mx.thm_your_brand')}</div><div className="text-xs text-muted-foreground">{t.tagline}</div></div>
                </div>
                <button className="px-4 py-2 text-sm font-medium text-white" style={{ background: previewCss, borderRadius: RADIUS[t.radius] }}>{tr('mx.thm_sample_button')}</button>
                <div className="rounded border p-3 text-sm" style={{ borderColor: previewCss }}>{tr('mx.thm_sample_box')}</div>
              </CardContent>
            </Card>
          </div>
        )}
      </StateView>
    </div>
  );
}
