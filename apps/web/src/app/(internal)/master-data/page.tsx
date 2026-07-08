'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { QrCode, Image } from 'lucide-react';
import { api, apiDownload } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { MasterIo } from '@/components/master-io';
import { Select } from '@/components/form-controls';


interface Entity { key: string; label_en: string; label_th: string; required: string[]; columns: string[]; allow_replace: boolean }
interface PopulateResult { processed: number; succeeded: number; failed: number; items: Array<{ item_id: string; status: string; message: string }> }

export default function MasterDataPage() {
  const { t } = useLang();
  const list = useQuery<{ entities: Entity[] }>({ queryKey: ['md-io-entities', 'admin'], queryFn: () => api('/api/admin/master-data/entities') });
  const [sel, setSel] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [populateResult, setPopulateResult] = useState<PopulateResult | null>(null);

  const entities = list.data?.entities ?? [];
  const ent = entities.find((e) => e.key === sel) ?? entities[0];
  const key = ent?.key;

  async function dlPost(path: string, filename: string, body: any, label: string) {
    setMsg(''); setBusy(label);
    try { await apiDownload(path, filename, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e: any) { setMsg(`❌ ${e.message}`); } finally { setBusy(''); }
  }

  async function populateProductImages() {
    setPopulateResult(null);
    setMsg('');
    setBusy('images');
    try {
      const result: PopulateResult = await api('/api/procurement/catalog/populate-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      setPopulateResult(result);
      notifySuccess(`✓ Fetched images for ${result.succeeded} items (${result.failed} failed)`);
    } catch (e: any) {
      const errMsg = e.message || 'Failed to populate images';
      setMsg(`❌ ${errMsg}`);
      notifyError(errMsg);
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
              <Select id="md-ent"  value={key ?? ''} onChange={(e) => setSel(e.target.value)}>
                {entities.map((e) => <option key={e.key} value={e.key}>{e.label_th} ({e.label_en})</option>)}
              </Select>
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

          <Card className="gap-3 p-5">
            <h3 className="text-base font-semibold flex items-center gap-2">
              <Image className="size-4" /> Product Images
            </h3>
            <p className="text-sm text-muted-foreground">
              Fetch and populate product images for shop catalog items from the internet based on item descriptions. Images are stored automatically for display in the shop.
            </p>
            <Button
              variant="outline" className="w-fit" disabled={busy === 'images'}
              onClick={populateProductImages}
            >
              <Image className="size-4" /> {busy === 'images' ? 'Fetching images...' : 'Populate Product Images'}
            </Button>
            {populateResult && (
              <div className="mt-4 space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Processed: {populateResult.processed}</span>
                  <Badge variant="default">{populateResult.succeeded}✓</Badge>
                </div>
                {populateResult.failed > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Failed: {populateResult.failed}</span>
                    <Badge variant="destructive">{populateResult.failed}</Badge>
                  </div>
                )}
                {populateResult.items.length > 0 && populateResult.items.length <= 5 && (
                  <div className="mt-3 space-y-1 border-t border-border pt-2">
                    {populateResult.items.map((item) => (
                      <div key={item.item_id} className="text-xs text-muted-foreground">
                        <span className={item.status === 'success' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
                          {item.status === 'success' ? '✓' : '✗'}
                        </span>
                        {' '}{item.item_id}: {item.message}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <Msg ok={false}>{msg}</Msg>
          </Card>

          {key && <MasterIo key={key} entityKey={key} base="admin" />}
        </div>
      </StateView>
    </div>
  );
}
