'use client';

import { useState } from 'react';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useLang } from '@/lib/i18n';

// Self-service: set/rotate your own POS quick-login PIN. Step-up with the current password (server-enforced).
export default function PosPinPage() {
  const { t } = useLang();
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!/^\d{4,6}$/.test(pin)) return setError(t('px.pin_err_format'));
    if (pin !== confirm) return setError(t('px.pin_err_mismatch'));
    if (!current) return setError(t('px.pin_err_current_required'));
    setLoading(true);
    try {
      await api('/api/auth/me/pin', { method: 'POST', body: JSON.stringify({ current_password: current, pin }) });
      notifySuccess(t('px.pin_success'));
      setCurrent(''); setPin(''); setConfirm('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('px.pin_err_failed');
      setError(msg);
      notifyError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t('px.pin_page_title')} description={t('px.pin_page_desc')} />
      <Card className="max-w-sm gap-0 p-6">
        <div className="mb-5 flex items-center gap-2 text-base font-semibold">
          <KeyRound className="size-4" /> {t('px.pin_my_pin')}
        </div>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="current">{t('px.pin_current_password')}</Label>
            <Input id="current" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pin">{t('px.pin_new_pin')}</Label>
            <Input id="pin" type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirm">{t('px.pin_confirm_pin')}</Label>
            <Input id="confirm" type="password" inputMode="numeric" maxLength={6} value={confirm} onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))} required />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" className="w-full" disabled={loading || pin.length < 4}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            {loading ? t('px.pin_saving') : t('px.pin_save_pin')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
