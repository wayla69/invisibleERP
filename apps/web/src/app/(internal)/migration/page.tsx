'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Upload, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useLang } from '@/lib/i18n';
import { selectCls } from '@/components/form-controls';

type Sources = { sources: { key: string; label: string }[]; entities: { key: string; required: string[] }[] };
type Result = { total: number; valid: number; errors: { row: number; missing: string[] }[] };

// E2 (Phase 27) — data-migration toolkit. Dry-run validation only (preview before the Phase-7 commit); no GL.
export default function MigrationPage() {
  const { t } = useLang();
  const meta = useQuery<Sources>({ queryKey: ['migration-sources'], queryFn: () => api('/api/migration/sources') });
  const [source, setSource] = useState('loyverse');
  const [entity, setEntity] = useState('products');
  const [text, setText] = useState('[\n  {"sku":"A1","item_name":"Coffee"},\n  {"sku":"A2"}\n]');
  const [res, setRes] = useState<Result | null>(null);
  const [msg, setMsg] = useState('');
  const run = useMutation({
    mutationFn: () => { let rows: any[]; try { rows = JSON.parse(text); } catch { throw new Error(t('mx.mig_invalid_json')); } return api<Result>('/api/migration/dry-run', { method: 'POST', body: JSON.stringify({ source, entity, rows }) }); },
    onSuccess: (r) => { setRes(r); setMsg(''); },
    onError: (e: any) => { setRes(null); setMsg(`❌ ${e.message}`); },
  });

  return (
    <div>
      <PageHeader title={t('mx.mig_title')} description={t('mx.mig_desc')} />
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Upload className="size-4 text-primary" /> {t('mx.mig_import_from')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-3">
              <div className="grid gap-1"><Label>{t('mx.mig_source')}</Label><select className={selectCls} value={source} onChange={(e) => setSource(e.target.value)}>{(meta.data?.sources ?? []).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></div>
              <div className="grid gap-1"><Label>{t('mx.mig_type')}</Label><select className={selectCls} value={entity} onChange={(e) => setEntity(e.target.value)}>{(meta.data?.entities ?? []).map((en) => <option key={en.key} value={en.key}>{en.key}</option>)}</select></div>
            </div>
            <div className="grid gap-1"><Label>{t('mx.mig_data_json')}</Label><textarea className="min-h-40 rounded-md border bg-transparent p-3 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} /></div>
            <Button disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} {t('mx.mig_validate')}</Button>
            {msg && <p className="text-sm text-destructive">{msg}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t('mx.mig_result')}</CardTitle></CardHeader>
          <CardContent>
            {!res ? <p className="text-sm text-muted-foreground">{t('mx.mig_no_result')}</p> : (
              <div className="text-sm">
                <p>{t('mx.mig_total')} {res.total} · {t('mx.mig_valid')} <span className="text-primary">{res.valid}</span> · {t('mx.mig_errors')} <span className="text-destructive">{res.errors.length}</span></p>
                {res.errors.length > 0 && <ul className="mt-2 space-y-1 text-xs">{res.errors.slice(0, 20).map((e, i) => <li key={i} className="text-destructive">{t('mx.mig_row_missing', { row: e.row, fields: e.missing.join(', ') })}</li>)}</ul>}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
