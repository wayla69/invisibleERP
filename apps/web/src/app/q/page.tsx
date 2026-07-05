'use client';

// Public deep-link resolver for a scanned asset/inventory QR.
// A printed QR (when WEB_BASE_URL is configured) encodes `<base>/q?d=<payload>`, so a phone's *native*
// camera opens this page. We parse the payload, identify the item/asset, and — once authenticated — show
// live details + one-tap links into the relevant workspace. Unauthenticated visitors see what was scanned
// and a login link that returns here (the shared `api()` also auto-bounces 401s to /login?next=).
import { useEffect, useState } from 'react';
import { Boxes, Landmark, PackageSearch, ScanLine } from 'lucide-react';
import { api, hasSession } from '@/lib/api';
import { parseQrPayload, type QrPayload } from '@/lib/qr';
import { useLang } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

interface Resolved {
  kind: 'item' | 'asset' | 'unknown';
  id: string;
  description?: string | null;
  uom?: string | null;
  price?: string | null;
  category?: string | null;
  location?: string | null;
  status?: string | null;
}

export default function QrResolverPage() {
  const { t } = useLang();
  const [code, setCode] = useState('');
  const [search, setSearch] = useState('');
  const [parsed, setParsed] = useState<QrPayload>({});
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [loading, setLoading] = useState(true);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    setSearch(window.location.search);
    const sp = new URLSearchParams(window.location.search);
    const raw = sp.get('d') ?? sp.get('code') ?? sp.get('payload') ?? '';
    setCode(raw);
    setParsed(parseQrPayload(raw));
    const session = hasSession();
    setAuthed(session);
    if (!raw || !session) { setLoading(false); return; }
    api<Resolved>(`/api/scan/sessions/resolve?code=${encodeURIComponent(raw)}`)
      .then((r) => setResolved(r))
      .catch(() => setResolved(null))
      .finally(() => setLoading(false));
  }, []);

  const id = resolved?.id || parsed.ITEM_ID || parsed.ASSET_ID || code;
  const kind: 'item' | 'asset' | 'unknown' =
    resolved?.kind ?? (parsed.ASSET_ID ? 'asset' : parsed.ITEM_ID ? 'item' : 'unknown');
  const desc = resolved?.description ?? parsed.DESC ?? '';
  const loginHref = `/login?next=${encodeURIComponent('/q' + search)}`;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6">
      <Card className="w-full gap-4 p-6">
        <div className="flex items-center gap-2 text-muted-foreground">
          <ScanLine className="size-5" />
          <span className="text-sm font-medium">{t('qr.q_title')}</span>
        </div>

        {!code ? (
          <p className="text-sm text-muted-foreground">{t('qr.q_no_code')}</p>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-md bg-muted p-2">
                {kind === 'asset' ? <Landmark className="size-6" /> : <Boxes className="size-6" />}
              </div>
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {kind === 'asset' ? t('qr.q_kind_asset') : kind === 'item' ? t('qr.q_kind_item') : t('qr.q_kind_unknown')}
                </div>
                <div className="truncate text-lg font-semibold">{id}</div>
                {desc && <div className="truncate text-sm text-muted-foreground">{desc}</div>}
              </div>
            </div>

            {loading ? (
              <p className="text-sm text-muted-foreground">{t('qr.q_loading')}</p>
            ) : resolved && resolved.kind !== 'unknown' ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                {resolved.kind === 'asset' && resolved.location != null && (
                  <><dt className="text-muted-foreground">{t('qr.q_location')}</dt><dd>{resolved.location || '—'}</dd></>
                )}
                {resolved.kind === 'asset' && resolved.status != null && (
                  <><dt className="text-muted-foreground">{t('qr.q_status')}</dt><dd>{resolved.status}</dd></>
                )}
                {resolved.kind === 'item' && resolved.uom != null && (
                  <><dt className="text-muted-foreground">{t('qr.q_uom')}</dt><dd>{resolved.uom || '—'}</dd></>
                )}
                {resolved.kind === 'item' && resolved.price != null && (
                  <><dt className="text-muted-foreground">{t('qr.q_price')}</dt><dd>{resolved.price}</dd></>
                )}
              </dl>
            ) : authed && resolved?.kind === 'unknown' ? (
              <p className="text-sm text-muted-foreground">{t('qr.q_not_found')}</p>
            ) : null}

            {/* Actions — deep links into the right workspace. */}
            <div className="flex flex-wrap gap-2">
              {!authed ? (
                <Button asChild><a href={loginHref}>{t('qr.q_login')}</a></Button>
              ) : kind === 'asset' ? (
                <Button asChild><a href="/assets"><Landmark className="size-4" /> {t('qr.q_open_assets')}</a></Button>
              ) : (
                <>
                  <Button asChild><a href="/mobile-scan"><ScanLine className="size-4" /> {t('qr.q_open_scan')}</a></Button>
                  <Button asChild variant="outline"><a href="/goods-issue"><PackageSearch className="size-4" /> {t('qr.q_open_stock')}</a></Button>
                </>
              )}
            </div>

            <code className="block break-all rounded bg-muted px-2 py-1 text-center text-xs text-muted-foreground">{code}</code>
          </>
        )}
      </Card>
    </main>
  );
}
