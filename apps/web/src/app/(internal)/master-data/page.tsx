'use client';

import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet, QrCode, Upload } from 'lucide-react';
import { api, apiDownload } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

interface Entity { key: string; label_en: string; label_th: string; required: string[]; columns: string[]; allow_replace: boolean }
interface ImpErr { row: number; column?: string; code: string; message: string; messageTh: string }
interface ValidateReport { entity: string; mode: string; total: number; valid: number; invalid: number; errors: ImpErr[] }

export default function MasterDataPage() {
  const { t } = useLang();
  const list = useQuery<{ entities: Entity[] }>({ queryKey: ['md-entities'], queryFn: () => api('/api/admin/master-data/entities') });
  const [sel, setSel] = useState('');
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [csvText, setCsvText] = useState('');
  const [report, setReport] = useState<ValidateReport | null>(null);
  const [skipErrors, setSkipErrors] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const entities = list.data?.entities ?? [];
  const ent = entities.find((e) => e.key === sel) ?? entities[0];
  const key = ent?.key;

  async function dl(path: string, filename: string, label: string) {
    setMsg(''); setBusy(label);
    try { await apiDownload(path, filename); } catch (e: any) { setMsg(`❌ ${e.message}`); } finally { setBusy(''); }
  }

  async function dlPost(path: string, filename: string, body: any, label: string) {
    setMsg(''); setBusy(label);
    try { await apiDownload(path, filename, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e: any) { setMsg(`❌ ${e.message}`); } finally { setBusy(''); }
  }

  // Step 1 — read the file and dry-run validate it (no DB change), then show a preview.
  async function onFile(file: File) {
    if (!ent) return;
    setMsg(''); setReport(null); setSkipErrors(false); setBusy('validate');
    try {
      const csv = await file.text();
      setCsvText(csv);
      const r = await api<ValidateReport>(`/api/admin/master-data/${ent.key}/import/validate`, {
        method: 'POST', body: JSON.stringify({ format: 'csv', mode, csv }),
      });
      setReport(r);
      setMsg(r.invalid ? `⚠️ ${t('st.md.validated_some', { valid: r.valid, total: r.total, invalid: r.invalid })}` : `✅ ${t('st.md.validated_all', { valid: r.valid, total: r.total })}`);
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  // Step 2 — commit the validated file. Bad rows block the import unless "skip errors" is on.
  async function commit() {
    if (!ent || !csvText) return;
    setMsg(''); setBusy('commit');
    try {
      const r = await api<{ status: string; imported: number; skipped: number; errors: ImpErr[] }>(
        `/api/admin/master-data/${ent.key}/import/checked`,
        { method: 'POST', body: JSON.stringify({ format: 'csv', mode, csv: csvText, skip_errors: skipErrors }) },
      );
      if (r.status === 'invalid') {
        setMsg(`❌ ${t('st.md.commit_errors', { n: r.errors.length })}`);
      } else {
        setMsg(`✅ ${t('st.md.imported', { n: r.imported, entity: ent.label_th })}${r.skipped ? ` · ${t('st.md.skipped_suffix', { n: r.skipped })}` : ''}`);
        setReport(null); setCsvText('');
      }
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <div>
      <PageHeader title={t('st.md.title')} description={t('st.md.desc')} />
      <StateView q={list}>
        <div className="space-y-4">
          <Card className="gap-3 p-5">
            <div className="grid gap-1.5 max-w-sm">
              <Label htmlFor="md-ent">{t('st.md.data_type')}</Label>
              <select id="md-ent" className={selectCls} value={key ?? ''} onChange={(e) => setSel(e.target.value)}>
                {entities.map((e) => <option key={e.key} value={e.key}>{e.label_th} ({e.label_en})</option>)}
              </select>
            </div>
            {ent && (
              <div className="text-sm text-muted-foreground">
                {t('st.md.required_cols')}: {ent.required.map((c) => <code key={c} className="mx-0.5 rounded bg-muted px-1 py-0.5 text-xs">{c}</code>)}
              </div>
            )}
            <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
          </Card>

          <Card className="gap-3 p-5">
            <h3 className="text-base font-semibold">{t('st.md.qr_title')}</h3>
            <p className="text-sm text-muted-foreground">{t('st.md.qr_desc')}</p>
            <Button
              variant="outline" className="w-fit" disabled={busy === 'qr'}
              onClick={() => dlPost('/api/inventory/qr/labels', 'item_qr_labels.pdf', { limit: 500 }, 'qr')}
            >
              <QrCode className="size-4" /> {busy === 'qr' ? t('st.md.generating') : t('st.md.qr_download')}
            </Button>
          </Card>

          {ent && (
            <div className="grid gap-4 md:grid-cols-2">
              <Card className="gap-3 p-5">
                <h3 className="text-base font-semibold">{t('st.md.export_title')}</h3>
                <p className="text-sm text-muted-foreground">{t('st.md.export_desc')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={!!busy} onClick={() => dl(`/api/admin/master-data/${key}/export`, `${key}.xlsx`, 'xlsx')}>
                    <FileSpreadsheet className="size-4" /> Excel
                  </Button>
                  <Button variant="outline" disabled={!!busy} onClick={() => dl(`/api/admin/master-data/${key}/export?format=csv`, `${key}.csv`, 'csv')}>
                    <Download className="size-4" /> CSV
                  </Button>
                  <Button variant="outline" disabled={!!busy} onClick={() => dl(`/api/admin/master-data/${key}/template`, `${key}_template.xlsx`, 'tpl')}>
                    <Download className="size-4" /> {t('st.md.template')}
                  </Button>
                </div>
              </Card>

              <Card className="gap-3 p-5">
                <h3 className="text-base font-semibold">{t('st.md.import_title')}</h3>
                <p className="text-sm text-muted-foreground">{t('st.md.import_desc')}</p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="md-mode">{t('st.md.mode')}</Label>
                    <select id="md-mode" className={`${selectCls} max-w-[200px]`} value={mode} onChange={(e) => setMode(e.target.value as any)}>
                      <option value="append">{t('st.md.mode_append')}</option>
                      <option value="replace" disabled={!ent.allow_replace}>{t('st.md.mode_replace')}{!ent.allow_replace ? ` — ${t('st.md.not_allowed')}` : ''}</option>
                    </select>
                  </div>
                  <Button disabled={!!busy} onClick={() => fileRef.current?.click()}>
                    <Upload className="size-4" /> {busy === 'validate' ? t('st.md.validating') : t('st.md.choose_csv')}
                  </Button>
                  <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
                </div>
                {mode === 'replace' && <Badge variant="destructive">{t('st.md.replace_warn')}</Badge>}
              </Card>

              {report && (
                <Card className="gap-3 p-5 md:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-base font-semibold">{t('st.md.preview_title')}</h3>
                    <div className="flex gap-2 text-sm">
                      <Badge variant="success">{t('st.md.valid_badge')} {report.valid}</Badge>
                      {report.invalid > 0 && <Badge variant="destructive">{t('st.md.invalid_badge')} {report.invalid}</Badge>}
                      <Badge variant="muted">{t('st.md.total_badge')} {report.total}</Badge>
                    </div>
                  </div>
                  {report.errors.length > 0 && (
                    <div className="max-h-64 overflow-auto rounded border">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-muted">
                          <tr><th className="px-2 py-1 text-left">{t('st.md.col_row')}</th><th className="px-2 py-1 text-left">{t('st.md.col_column')}</th><th className="px-2 py-1 text-left">{t('st.md.col_issue')}</th></tr>
                        </thead>
                        <tbody>
                          {report.errors.slice(0, 200).map((er, i) => (
                            <tr key={i} className="border-t">
                              <td className="px-2 py-1 tabular-nums">{er.row || '—'}</td>
                              <td className="px-2 py-1">{er.column ? <code className="text-xs">{er.column}</code> : '—'}</td>
                              <td className="px-2 py-1">{er.messageTh} <span className="text-muted-foreground">({er.code})</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    {report.invalid > 0 && (
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={skipErrors} onChange={(e) => setSkipErrors(e.target.checked)} />
                        {t('st.md.skip_errors_label')}
                      </label>
                    )}
                    <Button disabled={busy === 'commit' || (report.invalid > 0 && !skipErrors)} onClick={commit}>
                      {busy === 'commit' ? t('st.md.importing') : t('st.md.confirm_import', { n: report.invalid > 0 && skipErrors ? report.valid : report.total })}
                    </Button>
                    <Button variant="outline" disabled={!!busy} onClick={() => { setReport(null); setCsvText(''); setMsg(''); }}>{t('fin.cancel')}</Button>
                  </div>
                </Card>
              )}
            </div>
          )}
        </div>
      </StateView>
    </div>
  );
}
