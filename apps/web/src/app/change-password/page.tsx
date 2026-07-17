'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { api, hasSession, logout } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function ChangePasswordPage() {
  const { t } = useLang();
  const router = useRouter();
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && !hasSession()) router.replace('/login');
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (next.length < 8) return setError(t('auth.cp_min'));
    if (next !== confirm) return setError(t('auth.cp_mismatch'));
    setLoading(true);
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      await qc.invalidateQueries({ queryKey: ['me'] });
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.cp_failed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative grid min-h-svh place-items-center overflow-hidden bg-muted/30 p-5">
      <div className="pointer-events-none absolute -top-24 -right-24 size-96 rounded-full bg-primary/5 blur-3xl" />
      <Card className="w-full max-w-sm gap-0 p-8 shadow-lg">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <KeyRound className="size-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{t('auth.cp_title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('auth.cp_subtitle')}</p>
        </div>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="current">{t('auth.cp_current')}</Label>
            <PasswordInput id="current" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="next">{t('auth.cp_new')}</Label>
            <PasswordInput id="next" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirm">{t('auth.cp_confirm')}</Label>
            <PasswordInput id="confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} required />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            {loading ? t('auth.cp_saving') : t('auth.cp_save')}
          </Button>
        </form>
        <button
          type="button"
          onClick={() => { void logout().finally(() => router.replace('/login')); }}
          className="mt-4 text-center text-xs text-muted-foreground hover:text-foreground"
        >
          {t('auth.cp_logout')}
        </button>
      </Card>
    </main>
  );
}
