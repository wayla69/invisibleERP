'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { publicApi, setToken } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

// IdP redirect_uri target. Forwards the assertion (state + code/id_token) to the backend SSO callback,
// stores the minted session, and lands the user on their dashboard.
export default function SsoCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState('');

  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const state = qs.get('state') ?? '';
    const code = qs.get('code') ?? '';
    const idToken = qs.get('id_token') ?? '';
    const params = new URLSearchParams();
    if (state) params.set('state', state);
    if (code) params.set('code', code);
    if (idToken) params.set('id_token', idToken);
    publicApi<{ token: string; role: string }>(`/api/auth/sso/callback?${params.toString()}`)
      .then((res) => {
        setToken(res.token);
        router.replace(res.role === 'Customer' ? '/portal/dashboard' : '/dashboard');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'เข้าสู่ระบบด้วย SSO ไม่สำเร็จ'));
  }, [router]);

  return (
    <main className="grid min-h-svh place-items-center bg-muted/30 p-5">
      <Card className="w-full max-w-sm gap-0 p-8 text-center shadow-lg">
        {!error ? (
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <p className="text-sm">กำลังตรวจสอบ SSO…</p>
          </div>
        ) : (
          <div className="grid gap-4">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
            <Link href="/login" className="text-sm font-medium text-primary hover:underline">
              กลับไปหน้าเข้าสู่ระบบ
            </Link>
          </div>
        )}
      </Card>
    </main>
  );
}
