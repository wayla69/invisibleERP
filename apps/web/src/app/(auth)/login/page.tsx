'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, ShieldCheck, KeyRound, Delete, LogIn, Smartphone } from 'lucide-react';
import { api, publicApi } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { LanguageToggle } from '@/components/language-toggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

type Mode = 'password' | 'pin';

export default function LoginPage() {
  const { t } = useLang();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('password');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  // Second factor (ITGC-AC-06). The field stays hidden until the server tells us the account has MFA on
  // (MFA_REQUIRED) — so the vast majority of users who don't use MFA never see it. Revealed, the same
  // "เข้าสู่ระบบ" button re-submits with the code.
  const [totp, setTotp] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [company, setCompany] = useState('Invisible ERP V2');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ssoOpen, setSsoOpen] = useState(false);
  const [ssoTenant, setSsoTenant] = useState('');
  const [ssoLoading, setSsoLoading] = useState(false);
  // PIN (front-of-house) mode
  const [pinUser, setPinUser] = useState('');
  const [pin, setPin] = useState('');
  const [openShift, setOpenShift] = useState(true);
  const [openingFloat, setOpeningFloat] = useState('0');

  useEffect(() => {
    api<{ company_name: string }>('/api/config')
      .then((c) => setCompany(c.company_name))
      .catch(() => {});
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // Use publicApi (not api): login is a pre-auth request, so a 401 means "wrong username/password"
      // and must surface the server's real message — NOT be swallowed by api()'s handleUnauthorized,
      // which turns every 401 into a misleading "session expired".
      // Usernames are stored canonicalized (trimmed + lowercased) server-side; mirror that here so the
      // submitted value matches regardless of casing or stray surrounding whitespace.
      const code = totp.trim();
      const res = await publicApi<{ token: string; role: string }>('/api/login', {
        method: 'POST',
        // Only send `totp` once there's a code to send — an empty field must reproduce the plain
        // password submit so MFA accounts still get the MFA_REQUIRED prompt on the first attempt.
        body: JSON.stringify({ username: username.trim().toLowerCase(), password, ...(code ? { totp: code } : {}) }),
      });
      // The server set the httpOnly auth cookie + readable CSRF cookie on this response — no client storage.
      router.push(res.role === 'Customer' ? '/portal/dashboard' : '/dashboard');
    } catch (err) {
      // MFA_REQUIRED (account has 2FA, no code yet) / MFA_INVALID (wrong or expired code): reveal the OTP
      // field and let the user enter/retry the 6-digit code without re-typing username + password.
      const errCode = (err as { code?: string })?.code;
      if (errCode === 'MFA_REQUIRED' || errCode === 'MFA_INVALID') setMfaRequired(true);
      setError(err instanceof Error ? err.message : t('auth.login_failed'));
    } finally {
      setLoading(false);
    }
  }

  // PIN quick-login + (optionally) open the cashier's shift in one action — the front-of-house flow.
  async function onPinSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!/^\d{4,6}$/.test(pin)) return setError(t('auth.pin_format'));
    if (!pinUser.trim()) return setError(t('auth.username_required'));
    setLoading(true);
    try {
      const res = await publicApi<{ token: string; role: string; permissions: string[] }>('/api/login/pin', {
        method: 'POST',
        body: JSON.stringify({ username: pinUser.trim().toLowerCase(), pin }),
      });
      // One-action "เปิดกะ": only for till-capable staff (PosSupervisor/manager), and only if no shift is
      // already open for this shop — so logging in twice never spawns a duplicate till. A plain cashier
      // (pos_sell only) simply lands on the register.
      if (openShift && res.permissions.includes('pos_till')) {
        try {
          const cur = await api<{ open: { id: number } | null }>('/api/payments/till/current');
          if (!cur.open) {
            await api('/api/payments/till/open', { method: 'POST', body: JSON.stringify({ opening_float: Number(openingFloat) || 0 }) });
          }
        } catch { /* opening a shift is best-effort — never block sign-in on it */ }
      }
      router.push('/pos/register');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.pin_failed'));
      setPin('');
    } finally {
      setLoading(false);
    }
  }

  async function onSso(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSsoLoading(true);
    try {
      // Ask the backend for this tenant's IdP authorization URL, then hand the browser to the IdP.
      const res = await publicApi<{ authorization_url: string }>(
        `/api/auth/sso/authorize?tenant=${encodeURIComponent(ssoTenant.trim())}`,
      );
      window.location.href = res.authorization_url;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.sso_start_failed'));
      setSsoLoading(false);
    }
  }

  const tab = (m: Mode, label: string) => (
    <button
      type="button"
      onClick={() => { setMode(m); setError(''); }}
      className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
      aria-pressed={mode === m}
    >
      {label}
    </button>
  );

  const pinKey = (k: string) => {
    if (k === 'del') return setPin((p) => p.slice(0, -1));
    if (k === 'clr') return setPin('');
    setPin((p) => (p.length >= 6 ? p : p + k));
  };

  return (
    <main className="relative grid min-h-svh place-items-center overflow-hidden bg-muted/30 p-5">
      <div className="pointer-events-none absolute -top-24 -right-24 size-96 rounded-full bg-primary/5 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-24 size-96 rounded-full bg-primary/5 blur-3xl" />
      <div className="absolute top-4 right-4"><LanguageToggle /></div>

      <Card className="w-full max-w-sm gap-0 p-8 shadow-lg">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground shadow-sm">
            IE
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{company}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('auth.subtitle')}</p>
        </div>

        <div className="mb-5 flex gap-1 rounded-lg bg-muted p-1">
          {tab('password', t('auth.tab_password'))}
          {tab('pin', t('auth.tab_pin'))}
        </div>

        {mode === 'password' ? (
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="username">{t('auth.username')}</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <PasswordInput
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            {mfaRequired && (
              <div className="grid gap-2">
                <Label htmlFor="totp" className="flex items-center gap-1.5">
                  <Smartphone className="size-3.5" />
                  {t('auth.otp_label')}
                </Label>
                <Input
                  id="totp"
                  value={totp}
                  onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder={t('auth.otp_ph')}
                  className="text-center text-lg tracking-[0.4em]"
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  {t('auth.otp_hint')}
                </p>
              </div>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full" disabled={loading || (mfaRequired && totp.length < 6)}>
              {loading && <Loader2 className="size-4 animate-spin" />}
              {loading ? t('auth.signing_in') : mfaRequired ? t('auth.verify_otp') : t('auth.sign_in')}
            </Button>
          </form>
        ) : (
          <form onSubmit={onPinSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="pinUser">{t('auth.pin_user')}</Label>
              <Input
                id="pinUser"
                value={pinUser}
                onChange={(e) => setPinUser(e.target.value)}
                autoComplete="username"
                placeholder={t('auth.pin_user_ph')}
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label>PIN</Label>
              <div className="flex justify-center gap-2" aria-label={t('auth.pin_entered')}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <span key={i} className={`size-3 rounded-full border ${i < pin.length ? 'bg-primary border-primary' : 'border-input'}`} />
                ))}
              </div>
              <div className="mt-1 grid grid-cols-3 gap-2">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
                  <Button key={k} type="button" variant="outline" className="h-12 text-lg" onClick={() => pinKey(k)}>{k}</Button>
                ))}
                <Button type="button" variant="ghost" className="h-12" onClick={() => pinKey('clr')}>{t('auth.clear')}</Button>
                <Button type="button" variant="outline" className="h-12 text-lg" onClick={() => pinKey('0')}>0</Button>
                <Button type="button" variant="ghost" className="h-12" onClick={() => pinKey('del')} aria-label={t('auth.delete')}><Delete className="size-5" /></Button>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={openShift} onChange={(e) => setOpenShift(e.target.checked)} className="size-4 accent-primary" />
              {t('auth.open_shift')}
            </label>
            {openShift && (
              <div className="grid gap-2">
                <Label htmlFor="float">{t('auth.opening_float')}</Label>
                <Input id="float" type="number" inputMode="decimal" min={0} value={openingFloat} onChange={(e) => setOpeningFloat(e.target.value)} />
              </div>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full gap-2" disabled={loading || pin.length < 4}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
              {loading ? t('auth.signing_in') : t('auth.sign_in_open_shift')}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              {t('auth.pin_setup_hint')}
            </p>
          </form>
        )}

        {mode === 'password' && (
          <div className="mt-5">
            <div className="relative mb-4 text-center">
              <span className="relative z-10 bg-card px-2 text-xs text-muted-foreground">{t('auth.or')}</span>
              <span className="absolute inset-x-0 top-1/2 -z-0 border-t" />
            </div>
            {!ssoOpen ? (
              <Button type="button" variant="outline" className="w-full gap-2" onClick={() => setSsoOpen(true)}>
                <KeyRound className="size-4" />
                {t('auth.sso_button')}
              </Button>
            ) : (
              <form onSubmit={onSso} className="grid gap-2">
                <Label htmlFor="ssoTenant" className="text-sm">{t('auth.sso_company')}</Label>
                <Input id="ssoTenant" value={ssoTenant} onChange={(e) => setSsoTenant(e.target.value)} placeholder={t('auth.sso_company_ph')} autoFocus />
                <Button type="submit" variant="outline" className="w-full gap-2" disabled={!ssoTenant.trim() || ssoLoading}>
                  {ssoLoading && <Loader2 className="size-4 animate-spin" />}
                  {ssoLoading ? t('auth.sso_redirecting') : t('auth.sso_continue')}
                </Button>
              </form>
            )}
          </div>
        )}

        <p className="mt-6 text-center text-sm text-muted-foreground">
          {t('auth.no_account')}{' '}
          <Link href="/signup" className="font-medium text-primary hover:underline">
            {t('auth.signup_free')}
          </Link>
        </p>
        <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5" />
          {t('auth.secure')}
        </p>
      </Card>
    </main>
  );
}
