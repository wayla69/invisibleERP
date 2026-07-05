'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { QrCode } from 'lucide-react';
import { api, apiDownload } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { MasterIo } from '@/components/master-io';

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

interface Entity { key: string; label_en: string; label_th: string; required: string[]; columns: string[]; allow_replace: boolean }

export default function MasterDataPage() {
  const { t } = useLang();
  const list = useQuery<{ entities: Entity[] }>({ queryKey: ['md-io-entities', 'admin'], queryFn: () => api('/api/admin/master-data/entities') });
  const [sel, setSel] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const entities = list.data?.entities ?? [];
  const ent = entities.find((e) => e.key === sel) ?? entities[0];
  const key = ent?.key;

  async function dlPost(path: string, filename: string, body: any, label: string) {
    setMsg(''); setBusy(label);
    try { await apiDownload(path, filename, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e: any) { setMsg(`❌ ${e.message}`); } finally { setBusy(''); }
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
            <Msg ok={false}>{msg}</Msg>
          </Card>

          {key && <MasterIo key={key} entityKey={key} base="admin" />}
        </div>
      </StateView>
    </div>
  );
}
