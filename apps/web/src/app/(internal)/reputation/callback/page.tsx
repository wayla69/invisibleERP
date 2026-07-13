'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

// Google's OAuth redirect_uri target (docs/47). Forwards the redirect query string VERBATIM to the
// backend in the POST body — never reads `code`/`state` by name client-side, keeping them out of any
// URL/log and out of client-side handling by name (same CWE-598 avoidance as /sso/callback).
export default function ReputationOAuthCallbackPage() {
  const router = useRouter();
  const { t } = useLang();
  const [error, setError] = useState('');

  useEffect(() => {
    const query = window.location.search;
    api('/api/reputation/oauth/callback', { method: 'POST', body: JSON.stringify({ query }) })
      .then(() => router.replace('/reputation'))
      .catch((err) => setError(err instanceof Error ? err.message : t('rep.callback_failed')));
  }, [router, t]);

  return (
    <main className="grid min-h-[60vh] place-items-center p-5">
      <Card className="w-full max-w-sm gap-0 p-8 text-center shadow-lg">
        {!error ? (
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <p className="text-sm">{t('rep.callback_processing')}</p>
          </div>
        ) : (
          <div className="grid gap-4">
            <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
          </div>
        )}
      </Card>
    </main>
  );
}
