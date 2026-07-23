// ① AI Campaign Studio tab (MKT-21) — a fact-grounded bilingual campaign draft from the segment fact sheet.
// The facts are IN the prompt (retrieval-grounded, never hallucinated); output is DRAFT-only (the send stays
// the consent-gated, maker-checker campaign flow) and every generation logs its model card.
// NO 'use client' (inherits the /marketing-activation page boundary — see viz.tsx).
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Sparkles, Send, ScrollText, ChevronDown } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { notifySuccess, notifyError } from '@/lib/notify';
import { StateView } from '@/components/state-view';
import { tintBg, softText, Chip, SoftNote, EmptyCard, ENTER, stagger } from './viz';

export function Studio() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [segment, setSegment] = useState('');
  const [copyLang, setCopyLang] = useState<'th' | 'en'>('th');
  const [showPrompt, setShowPrompt] = useState(false);

  const miQ = useQuery<any>({ queryKey: ['marketing-intel', 'summary'], queryFn: () => api('/api/marketing-intel/summary') });
  const segments = useMemo(() => {
    const rows: any[] = Array.isArray(miQ.data?.rfm?.payload?.segments) ? miQ.data.rfm.payload.segments : [];
    return rows.map((s) => String(s.segment ?? '')).filter(Boolean);
  }, [miQ.data]);

  const genQ = useQuery<any>({
    queryKey: ['ma', 'studio-generate', segment],
    queryFn: () => api(`/api/marketing-activation/studio/generate/${encodeURIComponent(segment)}`),
    enabled: !!segment,
    retry: false,
  });
  const gensQ = useQuery<{ generations: any[] }>({ queryKey: ['ma', 'generations'], queryFn: () => api('/api/marketing-activation/studio/generations') });

  const stage = useMutation({
    mutationFn: () => api('/api/marketing-activation/studio/stage', { method: 'POST', body: JSON.stringify({ segment }) }),
    onSuccess: (r: any) => { notifySuccess(t('ma.studio_staged', { g: String(r?.gen_no ?? '') })); qc.invalidateQueries({ queryKey: ['ma', 'generations'] }); },
    onError: (e: any) => notifyError(e?.message ?? 'error'),
  });

  const draft = genQ.data?.draft ?? null;
  const gens: any[] = Array.isArray(gensQ.data?.generations) ? gensQ.data.generations : [];
  // Studio v2 — which path wrote the copy: the live LLM (real model id) or the deterministic template.
  const isAiModel = (m: unknown) => String(m ?? '') !== '' && String(m) !== 'studio-template-v1';

  return (
    <div className="space-y-5">
      <section className={`space-y-4 rounded-2xl border p-5 ${ENTER}`} style={{ ...tintBg('var(--chart-4)', 7), ...stagger(0) }}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 font-semibold">
            <Bot className="size-4" style={softText('var(--chart-4)')} /> {t('ma.studio_heading')}
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
            <Select value={segment || undefined} onValueChange={setSegment}>
              <SelectTrigger className="w-full bg-background/70 sm:w-56"><SelectValue placeholder={t('ma.pick_segment')} /></SelectTrigger>
              <SelectContent>
                {segments.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="secondary" disabled={!segment || !draft || stage.isPending} onClick={() => stage.mutate()}>
              <Send className="mr-1 size-4" /> {t('ma.studio_stage')}
            </Button>
          </div>
        </div>

        {!segment ? (
          <EmptyCard hue="var(--chart-4)" icon={Bot} title={t('ma.studio_empty')} desc={t('ma.studio_empty_desc')} />
        ) : (
          <StateView q={genQ}>
            {genQ.data && draft && (
              <div className="space-y-3">
                {/* The generated draft — a friendly message bubble, th/en toggle. */}
                <div className="rounded-xl border bg-background/70 p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <div className="flex gap-1">
                      {(['th', 'en'] as const).map((l) => (
                        <button
                          key={l} type="button" onClick={() => setCopyLang(l)}
                          className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${copyLang === l ? 'text-background' : 'border text-muted-foreground'}`}
                          style={copyLang === l ? { background: `color-mix(in oklch, var(--chart-4) 70%, var(--foreground))` } : undefined}
                        >
                          {l === 'th' ? 'ไทย' : 'EN'}
                        </button>
                      ))}
                    </div>
                    <Chip hue={isAiModel(genQ.data.model) ? 'var(--chart-1)' : 'var(--chart-4)'}>
                      {isAiModel(genQ.data.model) ? t('ma.studio_ai_badge') : t('ma.studio_template_badge')} · {String(genQ.data.model)}
                    </Chip>
                    <Chip hue="var(--chart-2)">{String(draft.channel)} · {num(draft.send_hour)}:00</Chip>
                    <Chip hue="var(--chart-3)">{t('ma.studio_reach', { n: num(draft.predicted_reach) })}</Chip>
                    <Chip hue="var(--chart-5)">holdout {num(draft.suggested_holdout_pct)}%</Chip>
                  </div>
                  <div className="text-sm font-semibold">{String(copyLang === 'th' ? draft.subject_th : draft.subject_en)}</div>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{String(copyLang === 'th' ? draft.body_th : draft.body_en)}</p>
                </div>

                {/* Model card — the retrieval-grounded prompt, collapsible (the ICFR evidence). */}
                <button
                  type="button"
                  onClick={() => setShowPrompt((v) => !v)}
                  className="flex w-full items-center gap-2 rounded-xl border bg-background/60 px-4 py-2.5 text-xs font-medium text-muted-foreground"
                >
                  <ScrollText className="size-3.5" /> {t('ma.studio_prompt')}
                  <ChevronDown className={`ml-auto size-3.5 transition-transform ${showPrompt ? 'rotate-180' : ''}`} />
                </button>
                {showPrompt && (
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border bg-background/60 p-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {String(genQ.data.prompt ?? '')}
                  </pre>
                )}
              </div>
            )}
          </StateView>
        )}
        <SoftNote hue="var(--chart-4)">{t('ma.studio_note')}</SoftNote>
      </section>

      {/* Logged generations (model cards). */}
      <section className={`space-y-3 rounded-2xl border p-5 ${ENTER}`} style={{ ...tintBg('var(--chart-5)', 7), ...stagger(1) }}>
        <div className="flex items-center gap-2 font-semibold">
          <Sparkles className="size-4" style={softText('var(--chart-5)')} /> {t('ma.studio_gens_heading')}
        </div>
        <StateView q={gensQ}>
          {gensQ.data && (gens.length === 0 ? (
            <EmptyCard hue="var(--chart-5)" icon={Sparkles} title={t('ma.studio_no_gens')} />
          ) : (
            <div className="space-y-2">
              {gens.map((g, i) => (
                <div key={String(g.gen_no)} className={`flex flex-wrap items-center gap-2 rounded-xl border bg-background/60 p-3 text-sm ${ENTER}`} style={stagger(i)}>
                  <span className="font-semibold">{String(g.gen_no)}</span>
                  {g.segment && <span className="text-muted-foreground">· {String(g.segment)}</span>}
                  <Chip hue={isAiModel(g.model) ? 'var(--chart-1)' : 'var(--chart-4)'}>
                    {isAiModel(g.model) ? t('ma.studio_ai_badge') : t('ma.studio_template_badge')} · {String(g.model)}
                  </Chip>
                  {g.channel && <Chip hue="var(--chart-2)">{String(g.channel)}</Chip>}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {g.campaign_id != null ? t('ma.studio_draft_created', { id: String(g.campaign_id) }) : '—'}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </StateView>
        <SoftNote hue="var(--chart-5)">{t('ma.studio_gens_note')}</SoftNote>
      </section>
    </div>
  );
}
