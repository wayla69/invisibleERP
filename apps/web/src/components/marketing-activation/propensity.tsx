// ③ Propensity & Cross-Sell tab (MKT-23) — "who should we sell what to next?", fact-ranked. Per customer:
// the ranked next-best-offer list (driver item + confidence + lift + margin, consent fact surfaced). Per
// product: the best audiences to push it to. Advisory reads only — contact stays the consent-gated draft.
// NO 'use client' (inherits the /marketing-activation page boundary — see viz.tsx).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, ShoppingCart, PackageSearch, Sparkles, HeartHandshake } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thb } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StateView } from '@/components/state-view';
import { HUES, tintBg, softText, fill, Chip, SoftNote, EmptyCard, ENTER, stagger } from './viz';

export function Propensity() {
  const { t } = useLang();
  const [custInput, setCustInput] = useState('');
  const [cust, setCust] = useState('');
  const [itemInput, setItemInput] = useState('');
  const [item, setItem] = useState('');

  const offersQ = useQuery<any>({
    queryKey: ['ma', 'propensity', 'customer', cust],
    queryFn: () => api(`/api/marketing-activation/propensity/customer/${encodeURIComponent(cust)}`),
    enabled: !!cust,
    retry: false,
  });
  const audQ = useQuery<any>({
    queryKey: ['ma', 'propensity', 'item', item],
    queryFn: () => api(`/api/marketing-activation/propensity/item/${encodeURIComponent(item)}`),
    enabled: !!item,
    retry: false,
  });

  const offers: any[] = Array.isArray(offersQ.data?.offers) ? offersQ.data.offers : [];
  const audiences: any[] = Array.isArray(audQ.data?.audiences) ? audQ.data.audiences : [];

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* ── Per customer: next product to offer ── */}
      <section className={`space-y-4 rounded-2xl border p-5 ${ENTER}`} style={{ ...tintBg('var(--chart-1)', 7), ...stagger(0) }}>
        <div className="flex items-center gap-2 font-semibold">
          <ShoppingCart className="size-4" style={softText('var(--chart-1)')} /> {t('ma.prop_cust_heading')}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); setCust(custInput.trim()); }}
        >
          <Input value={custInput} onChange={(e) => setCustInput(e.target.value)} placeholder={t('ma.prop_cust_ph')} className="bg-background/70" />
          <Button type="submit" variant="secondary" className="shrink-0"><Search className="mr-1 size-4" />{t('ma.lookup')}</Button>
        </form>

        {!cust ? (
          <EmptyCard hue="var(--chart-1)" icon={ShoppingCart} title={t('ma.prop_cust_empty')} desc={t('ma.prop_cust_empty_desc')} />
        ) : (
          <StateView q={offersQ}>
            {offersQ.data && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold">{String(offersQ.data.customer_no)}</span>
                  {offersQ.data.clv != null && <Chip hue="var(--chart-3)">CLV {thb(offersQ.data.clv)}</Chip>}
                  <Chip hue={offersQ.data.marketing_opt_in ? 'var(--chart-3)' : 'var(--chart-1)'}>
                    {offersQ.data.marketing_opt_in ? t('ma.consent_ok') : t('ma.consent_off')}
                  </Chip>
                </div>
                {offers.length === 0 ? (
                  <EmptyCard hue="var(--chart-1)" icon={Sparkles} title={t('ma.prop_no_offers')} />
                ) : (
                  <ol className="space-y-2">
                    {offers.map((o, i) => (
                      <li key={String(o.item_id)} className={`flex items-center gap-3 rounded-xl border bg-background/60 p-3 ${ENTER}`} style={stagger(i)}>
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-background" style={{ background: fill(HUES[i % HUES.length]) }}>
                          {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold">{String(o.name ?? o.item_id)}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {t('ma.prop_because', { item: String(o.driver_name ?? o.driver_item_id) })} · {t('ma.confidence')} {num(o.confidence_pct)}%
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <Chip hue="var(--chart-3)">lift {num(o.lift, 1)}</Chip>
                          {o.margin_pct != null && <div className="mt-1 text-[11px] text-muted-foreground">margin {num(o.margin_pct)}%</div>}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </StateView>
        )}
        <SoftNote hue="var(--chart-1)">{t('ma.prop_note')}</SoftNote>
      </section>

      {/* ── Per product: best audiences ── */}
      <section className={`space-y-4 rounded-2xl border p-5 ${ENTER}`} style={{ ...tintBg('var(--chart-5)', 7), ...stagger(1) }}>
        <div className="flex items-center gap-2 font-semibold">
          <PackageSearch className="size-4" style={softText('var(--chart-5)')} /> {t('ma.prop_item_heading')}
        </div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setItem(itemInput.trim()); }}>
          <Input value={itemInput} onChange={(e) => setItemInput(e.target.value)} placeholder={t('ma.prop_item_ph')} className="bg-background/70" />
          <Button type="submit" variant="secondary" className="shrink-0"><Search className="mr-1 size-4" />{t('ma.lookup')}</Button>
        </form>

        {!item ? (
          <EmptyCard hue="var(--chart-5)" icon={PackageSearch} title={t('ma.prop_item_empty')} desc={t('ma.prop_item_empty_desc')} />
        ) : (
          <StateView q={audQ}>
            {audQ.data && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold">{String(audQ.data.item_name ?? audQ.data.item_id)}</span>
                  {audQ.data.unit_margin != null && <Chip hue="var(--chart-4)">{t('ma.margin')} {thb(audQ.data.unit_margin)}</Chip>}
                  <span className="text-xs text-muted-foreground">{t('ma.prop_candidates', { n: num(audQ.data.candidate_members ?? 0) })}</span>
                </div>
                {audiences.length === 0 ? (
                  <EmptyCard hue="var(--chart-5)" icon={HeartHandshake} title={t('ma.prop_no_audiences')} />
                ) : (
                  <ul className="space-y-2">
                    {audiences.map((a, i) => (
                      <li key={String(a.segment)} className={`flex items-center gap-3 rounded-xl border bg-background/60 p-3 ${ENTER}`} style={stagger(i)}>
                        <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: fill(HUES[i % HUES.length]) }} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold">{String(a.segment)}</div>
                          <div className="text-xs text-muted-foreground">{t('ma.prop_reach', { n: num(a.count) })}{a.avg_clv != null ? ` · CLV ${thb(a.avg_clv)}` : ''}</div>
                        </div>
                        <Chip hue="var(--chart-5)">{t('ma.score')} {num(a.score)}</Chip>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </StateView>
        )}
        <SoftNote hue="var(--chart-5)">{t('ma.prop_item_note')}</SoftNote>
      </section>
    </div>
  );
}
