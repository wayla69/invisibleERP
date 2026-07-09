'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Loader2, Save, Star, Trash2, RefreshCw, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Msg } from '@/components/tabs';
import { useLang } from '@/lib/i18n';
import { selectCls } from '@/components/form-controls';
import { cn } from '@/lib/utils';

type DocType = { key: string; label_th: string; label_en: string; status: string };
type Tmpl = { id: number; doc_type: string; name: string; is_default: boolean; active: boolean; config: any };
type ReceiptCfg = {
  header: { show_logo: boolean; header_note: string };
  body: { show_branch: boolean; show_address: boolean; show_tax_id: boolean; accent_color: string; font_scale: number };
  footer: { thanks_text: string; extra_lines: string[] };
  paper: { width_mm: number };
};

const DEFAULT_CFG: ReceiptCfg = {
  header: { show_logo: true, header_note: '' },
  body: { show_branch: true, show_address: true, show_tax_id: true, accent_color: '', font_scale: 1 },
  footer: { thanks_text: '', extra_lines: [] },
  paper: { width_mm: 80 },
};

// Merge a stored config over the defaults so the editor always has a complete shape.
function hydrate(c: any): ReceiptCfg {
  const x = c && typeof c === 'object' ? c : {};
  return {
    header: { ...DEFAULT_CFG.header, ...(x.header ?? {}) },
    body: { ...DEFAULT_CFG.body, ...(x.body ?? {}) },
    footer: { ...DEFAULT_CFG.footer, ...(x.footer ?? {}), extra_lines: Array.isArray(x.footer?.extra_lines) ? x.footer.extra_lines : [] },
    paper: { ...DEFAULT_CFG.paper, ...(x.paper ?? {}) },
  };
}

// ── A4 documents (quotation / purchase_order / payslip / tax invoices) share the a4-template config ──
type A4Cfg = {
  header: { show_logo: boolean; header_note: string; accent_color: string };
  body: { show_seller_address: boolean; show_seller_tax_id: boolean };
  totals: { show_amount_in_words: boolean };
  footer: { terms_text: string; extra_lines: string[]; prepared_by_label: string; approved_by_label: string };
};
const DEFAULT_A4: A4Cfg = {
  header: { show_logo: true, header_note: '', accent_color: '' },
  body: { show_seller_address: true, show_seller_tax_id: true },
  totals: { show_amount_in_words: true },
  footer: { terms_text: '', extra_lines: [], prepared_by_label: '', approved_by_label: '' },
};
function hydrateA4(c: any): A4Cfg {
  const x = c && typeof c === 'object' ? c : {};
  return {
    header: { ...DEFAULT_A4.header, ...(x.header ?? {}) },
    body: { ...DEFAULT_A4.body, ...(x.body ?? {}) },
    totals: { ...DEFAULT_A4.totals, ...(x.totals ?? {}) },
    footer: { ...DEFAULT_A4.footer, ...(x.footer ?? {}), extra_lines: Array.isArray(x.footer?.extra_lines) ? x.footer.extra_lines : [] },
  };
}
// Fiscal documents force the seller address/tax-id on server-side (ม.86/4) regardless of these knobs.
const FISCAL_TYPES = ['tax_invoice_abbreviated', 'tax_invoice_full'];

const YesNo = ({ id, value, onChange }: { id: string; value: boolean; onChange: (v: boolean) => void }) => {
  const { t } = useLang();
  return (
    <select id={id} className={selectCls} value={value ? '1' : '0'} onChange={(e) => onChange(e.target.value === '1')}>
      <option value="1">{t('st.dt.show')}</option>
      <option value="0">{t('st.dt.hide')}</option>
    </select>
  );
};

export default function DocumentTemplatesPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [docType, setDocType] = useState('receipt');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [cfg, setCfg] = useState<any>(DEFAULT_CFG);
  const [previewHtml, setPreviewHtml] = useState('');
  const [msg, setMsg] = useState('');

  const types = useQuery<{ doc_types: DocType[] }>({ queryKey: ['doc-types'], queryFn: () => api('/api/document-templates/doc-types') });
  const list = useQuery<{ templates: Tmpl[] }>({ queryKey: ['doc-templates', docType], queryFn: () => api(`/api/document-templates?doc_type=${docType}`) });

  const activeType = types.data?.doc_types.find((d) => d.key === docType);
  const isLive = activeType?.status === 'live';
  const isA4 = docType !== 'receipt';
  const isFiscal = FISCAL_TYPES.includes(docType);
  const isSlip = docType === 'tax_invoice_abbreviated'; // 80mm thermal slip — only header/footer notes apply
  const defaultFor = (dt: string): any => (dt === 'receipt' ? DEFAULT_CFG : DEFAULT_A4);

  const resetEditor = (dt: string = docType) => { setSelectedId(null); setName(''); setCfg(defaultFor(dt)); setMsg(''); };
  const loadTemplate = (tpl: Tmpl) => { setSelectedId(tpl.id); setName(tpl.name); setCfg(tpl.doc_type === 'receipt' ? hydrate(tpl.config) : hydrateA4(tpl.config)); setMsg(''); };

  // live preview (debounced via explicit refresh + on key changes)
  const runPreview = async (config = cfg, dt = docType) => {
    try { const r = await api<{ html: string }>('/api/document-templates/preview', { method: 'POST', body: JSON.stringify({ doc_type: dt, config }) }); setPreviewHtml(r.html ?? ''); }
    catch (e: any) { setMsg(`❌ ${e.message}`); }
  };
  useEffect(() => { runPreview(cfg, docType); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [docType, selectedId]);

  const save = useMutation({
    mutationFn: () => selectedId
      ? api(`/api/document-templates/${selectedId}`, { method: 'PUT', body: JSON.stringify({ name, config: cfg }) })
      : api('/api/document-templates', { method: 'POST', body: JSON.stringify({ doc_type: docType, name, config: cfg }) }),
    onSuccess: (r: any) => { setMsg(`✅ ${t('st.dt.saved')}`); if (!selectedId && r?.id) setSelectedId(Number(r.id)); qc.invalidateQueries({ queryKey: ['doc-templates', docType] }); runPreview(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const setDefault = useMutation({
    mutationFn: (id: number) => api(`/api/document-templates/${id}/default`, { method: 'POST' }),
    onSuccess: () => { setMsg(`✅ ${t('st.dt.set_default_done')}`); qc.invalidateQueries({ queryKey: ['doc-templates', docType] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/document-templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setMsg(`🗑️ ${t('st.dt.deleted')}`); resetEditor(); qc.invalidateQueries({ queryKey: ['doc-templates', docType] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title={t('st.dt.title')} description={t('st.dt.desc')} />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Label htmlFor="docType" className="text-sm">{t('st.dt.doc_type')}</Label>
        <select id="docType" className={cn(selectCls, 'w-auto')} value={docType} onChange={(e) => { const nt = e.target.value; setDocType(nt); resetEditor(nt); }}>
          {(types.data?.doc_types ?? [{ key: 'receipt', label_th: 'ใบเสร็จรับเงิน', label_en: 'Receipt', status: 'live' }]).map((d) => (
            <option key={d.key} value={d.key}>{d.label_th} ({d.label_en}){d.status !== 'live' ? t('st.dt.coming_soon_suffix') : ''}</option>
          ))}
        </select>
        {activeType && <Badge variant={isLive ? 'success' : 'warning'}>{isLive ? t('st.dt.ready') : t('st.dt.upcoming')}</Badge>}
        <Button size="sm" variant="outline" onClick={() => resetEditor()}><Plus className="size-4" /> {t('st.dt.new_template')}</Button>
      </div>

      {!isLive && (
        <Card className="mb-4 border-amber-300/60 bg-amber-50/40">
          <CardContent className="py-3 text-sm text-amber-900">
            {t('st.dt.not_live_note')}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_minmax(300px,360px)]">
        {/* ── editor ── */}
        <div className="grid gap-6">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileText className="size-4 text-primary" /> {t('st.dt.saved_templates')}</CardTitle></CardHeader>
            <CardContent>
              <StateView q={list}>
                {(list.data?.templates ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('st.dt.empty_hint')}</p>
                ) : (
                  <div className="grid gap-2">
                    {(list.data?.templates ?? []).map((tpl) => (
                      <div key={tpl.id} className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${selectedId === tpl.id ? 'border-primary bg-primary/5' : ''}`}>
                        <button className="flex-1 text-left" onClick={() => loadTemplate(tpl)}>
                          {tpl.name} {tpl.is_default && <Badge variant="success" className="ml-2"><Star className="size-3" /> {t('st.dt.default_badge')}</Badge>}
                        </button>
                        <div className="flex items-center gap-2">
                          {!tpl.is_default && <Button size="sm" variant="ghost" disabled={setDefault.isPending} onClick={() => setDefault.mutate(tpl.id)}><Star className="size-4" /> {t('st.dt.set_default')}</Button>}
                          <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(tpl.id)}><Trash2 className="size-4 text-destructive" /></Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </StateView>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">{selectedId ? t('st.dt.edit_template') : t('st.dt.new_template')}</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="tname">{t('st.dt.template_name')}</Label>
                <Input id="tname" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('st.dt.template_name_ph')} />
              </div>

              {!isA4 && (<>
              <div className="grid gap-2"><Label htmlFor="show_logo">{t('st.dt.logo')}</Label><YesNo id="show_logo" value={cfg.header.show_logo} onChange={(v) => setCfg((c: any) => ({ ...c, header: { ...c.header, show_logo: v } }))} /></div>
              <div className="grid gap-2"><Label htmlFor="hdr">{t('st.dt.header_note')}</Label><Input id="hdr" value={cfg.header.header_note} onChange={(e) => setCfg((c: any) => ({ ...c, header: { ...c.header, header_note: e.target.value } }))} placeholder={t('st.dt.header_note_ph')} /></div>

              <div className="grid gap-2"><Label htmlFor="b_branch">{t('st.dt.branch')}</Label><YesNo id="b_branch" value={cfg.body.show_branch} onChange={(v) => setCfg((c: any) => ({ ...c, body: { ...c.body, show_branch: v } }))} /></div>
              <div className="grid gap-2"><Label htmlFor="b_addr">{t('st.dt.address')}</Label><YesNo id="b_addr" value={cfg.body.show_address} onChange={(v) => setCfg((c: any) => ({ ...c, body: { ...c.body, show_address: v } }))} /></div>
              <div className="grid gap-2"><Label htmlFor="b_tax">{t('st.dt.tax_id')}</Label><YesNo id="b_tax" value={cfg.body.show_tax_id} onChange={(v) => setCfg((c: any) => ({ ...c, body: { ...c.body, show_tax_id: v } }))} /></div>
              <div className="grid gap-2">
                <Label htmlFor="accent">{t('st.dt.accent')}</Label>
                <input id="accent" type="color" className="h-9 w-full rounded-md border bg-transparent px-1" value={cfg.body.accent_color || '#000000'} onChange={(e) => setCfg((c: any) => ({ ...c, body: { ...c.body, accent_color: e.target.value } }))} />
              </div>
              <div className="grid gap-2"><Label htmlFor="fscale">{t('st.dt.font_scale')}</Label><Input id="fscale" type="number" step="0.05" min="0.8" max="1.4" value={cfg.body.font_scale} onChange={(e) => setCfg((c: any) => ({ ...c, body: { ...c.body, font_scale: Number(e.target.value) || 1 } }))} /></div>
              <div className="grid gap-2"><Label htmlFor="paper">{t('st.dt.paper_width')}</Label><Input id="paper" type="number" step="1" min="58" max="112" value={cfg.paper.width_mm} onChange={(e) => setCfg((c: any) => ({ ...c, paper: { width_mm: Number(e.target.value) || 80 } }))} /></div>

              <div className="grid gap-2 sm:col-span-2"><Label htmlFor="thanks">{t('st.dt.thanks')}</Label><Input id="thanks" value={cfg.footer.thanks_text} onChange={(e) => setCfg((c: any) => ({ ...c, footer: { ...c.footer, thanks_text: e.target.value } }))} placeholder={t('st.dt.thanks_ph')} /></div>
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="extra">{t('st.dt.extra_lines')}</Label>
                <textarea id="extra" rows={3} className="rounded-md border bg-transparent px-3 py-2 text-sm" value={cfg.footer.extra_lines.join('\n')} onChange={(e) => setCfg((c: any) => ({ ...c, footer: { ...c.footer, extra_lines: e.target.value.split('\n').slice(0, 5) } }))} placeholder={t('st.dt.extra_lines_ph')} />
              </div>
              </>)}

              {isSlip && (<>
              <div className="grid gap-2 sm:col-span-2"><Label htmlFor="s_hdr">{t('st.dt.header_note')}</Label><Input id="s_hdr" value={cfg.header.header_note} onChange={(e) => setCfg((c: any) => ({ ...c, header: { ...c.header, header_note: e.target.value } }))} placeholder={t('st.dt.header_note_ph')} /></div>
              <div className="grid gap-2 sm:col-span-2"><Label htmlFor="s_terms">{t('st.dt.footer_note')}</Label><Input id="s_terms" value={cfg.footer.terms_text} onChange={(e) => setCfg((c: any) => ({ ...c, footer: { ...c.footer, terms_text: e.target.value } }))} placeholder={t('st.dt.footer_note_ph')} /></div>
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="s_extra">{t('st.dt.extra_lines')}</Label>
                <textarea id="s_extra" rows={2} className="rounded-md border bg-transparent px-3 py-2 text-sm" value={cfg.footer.extra_lines.join('\n')} onChange={(e) => setCfg((c: any) => ({ ...c, footer: { ...c.footer, extra_lines: e.target.value.split('\n').slice(0, 5) } }))} placeholder={t('st.dt.extra_lines_ph')} />
              </div>
              <p className="sm:col-span-2 text-xs text-muted-foreground">🔒 {t('st.dt.slip_note')}</p>
              </>)}

              {isA4 && !isSlip && (<>
              <div className="grid gap-2"><Label htmlFor="a_logo">{t('st.dt.logo')}</Label><YesNo id="a_logo" value={cfg.header.show_logo} onChange={(v) => setCfg((c: any) => ({ ...c, header: { ...c.header, show_logo: v } }))} /></div>
              <div className="grid gap-2">
                <Label htmlFor="a_accent">{t('st.dt.accent')}</Label>
                <input id="a_accent" type="color" className="h-9 w-full rounded-md border bg-transparent px-1" value={cfg.header.accent_color || '#1E3C72'} onChange={(e) => setCfg((c: any) => ({ ...c, header: { ...c.header, accent_color: e.target.value } }))} />
              </div>
              <div className="grid gap-2 sm:col-span-2"><Label htmlFor="a_hdr">{t('st.dt.header_note')}</Label><Input id="a_hdr" value={cfg.header.header_note} onChange={(e) => setCfg((c: any) => ({ ...c, header: { ...c.header, header_note: e.target.value } }))} placeholder={t('st.dt.header_note_ph')} /></div>

              <div className="grid gap-2"><Label htmlFor="a_addr">{t('st.dt.address')}{isFiscal ? ' 🔒' : ''}</Label><YesNo id="a_addr" value={isFiscal ? true : cfg.body.show_seller_address} onChange={(v) => setCfg((c: any) => ({ ...c, body: { ...c.body, show_seller_address: v } }))} /></div>
              <div className="grid gap-2"><Label htmlFor="a_tax">{t('st.dt.tax_id')}{isFiscal ? ' 🔒' : ''}</Label><YesNo id="a_tax" value={isFiscal ? true : cfg.body.show_seller_tax_id} onChange={(v) => setCfg((c: any) => ({ ...c, body: { ...c.body, show_seller_tax_id: v } }))} /></div>
              <div className="grid gap-2"><Label htmlFor="a_words">{t('st.dt.amount_in_words')}</Label><YesNo id="a_words" value={cfg.totals.show_amount_in_words} onChange={(v) => setCfg((c: any) => ({ ...c, totals: { ...c.totals, show_amount_in_words: v } }))} /></div>

              <div className="grid gap-2"><Label htmlFor="a_prep">{t('st.dt.prepared_by_label')}</Label><Input id="a_prep" value={cfg.footer.prepared_by_label} onChange={(e) => setCfg((c: any) => ({ ...c, footer: { ...c.footer, prepared_by_label: e.target.value } }))} placeholder={t('st.dt.signature_ph')} /></div>
              <div className="grid gap-2"><Label htmlFor="a_appr">{t('st.dt.approved_by_label')}</Label><Input id="a_appr" value={cfg.footer.approved_by_label} onChange={(e) => setCfg((c: any) => ({ ...c, footer: { ...c.footer, approved_by_label: e.target.value } }))} placeholder={t('st.dt.signature_ph')} /></div>

              <div className="grid gap-2 sm:col-span-2"><Label htmlFor="a_terms">{t('st.dt.terms')}</Label><textarea id="a_terms" rows={2} className="rounded-md border bg-transparent px-3 py-2 text-sm" value={cfg.footer.terms_text} onChange={(e) => setCfg((c: any) => ({ ...c, footer: { ...c.footer, terms_text: e.target.value } }))} placeholder={t('st.dt.terms_ph')} /></div>
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="a_extra">{t('st.dt.extra_lines')}</Label>
                <textarea id="a_extra" rows={2} className="rounded-md border bg-transparent px-3 py-2 text-sm" value={cfg.footer.extra_lines.join('\n')} onChange={(e) => setCfg((c: any) => ({ ...c, footer: { ...c.footer, extra_lines: e.target.value.split('\n').slice(0, 5) } }))} placeholder={t('st.dt.extra_lines_ph')} />
              </div>
              {isFiscal && <p className="sm:col-span-2 text-xs text-muted-foreground">🔒 {t('st.dt.fiscal_note')}</p>}
              </>)}
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => { setMsg(''); save.mutate(); }} disabled={save.isPending || !name.trim()}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} {t('fin.save')}
            </Button>
            <Button variant="outline" onClick={() => runPreview()}><RefreshCw className="size-4" /> {t('st.dt.refresh_preview')}</Button>
            {msg && <Msg ok={msg.startsWith('✅') || msg.startsWith('🗑️')}>{msg}</Msg>}
          </div>
        </div>

        {/* ── live preview ── */}
        <Card className="lg:sticky lg:top-4 h-fit">
          <CardHeader><CardTitle className="text-base">{t('st.dt.live_preview')}</CardTitle></CardHeader>
          <CardContent>
            <iframe title="preview" srcDoc={previewHtml} className="h-[560px] w-full rounded border bg-white" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
