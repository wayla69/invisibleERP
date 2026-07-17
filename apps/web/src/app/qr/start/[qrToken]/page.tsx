'use client';

// Landing page for the PRINTED table QR sticker (…/qr/start/:qrToken). It opens or joins the table
// session for that stable token, then redirects the diner to their live ordering page (/qr/:publicToken).
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Loader2, Utensils } from 'lucide-react';
import { publicApi } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { Card } from '@/components/ui/card';

export default function QrStartPage() {
  const { t } = useLang();
  const qrToken = String(useParams().qrToken ?? '');
  const router = useRouter();
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await publicApi<{ public_token: string }>(`/api/qr/start/${qrToken}`, { method: 'POST' });
        if (!cancelled) router.replace(`/qr/${r.public_token}`);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : t('pub.start.failed'));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrToken, router]);

  return (
    <main className="mx-auto grid min-h-svh max-w-md place-items-center bg-muted/30 p-4">
      <Card className="w-full items-center gap-3 p-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Utensils className="size-6" />
        </div>
        {err ? (
          <>
            <h2 className="text-lg font-semibold text-destructive">{t('pub.start.failed')}</h2>
            <p className="text-sm text-muted-foreground">{err}</p>
            <p className="text-xs text-muted-foreground">{t('pub.start.call_staff')}</p>
          </>
        ) : (
          <>
            <Loader2 className="size-6 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{t('pub.start.opening')}</p>
          </>
        )}
      </Card>
    </main>
  );
}
