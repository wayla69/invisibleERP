'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, ShieldCheck, KeyRound, Delete, LogIn } from 'lucide-react';
import { api, publicApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

type Mode = 'password' | 'pin';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('password');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
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
      const res = await publicApi<{ token: string; role: string }>('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: username.trim().toLowerCase(), password }),
      });
      // The server set the httpOnly auth cookie + readable CSRF cookie on this response — no client storage.
      router.push(res.role === 'Customer' ? '/portal/dashboard' : '/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เข้าสู่ระบบไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }

  // PIN quick-login + (optionally) open the cashier's shift in one action — the front-of-house flow.
  async function onPinSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!/^\d{4,6}$/.test(pin)) return setError('PIN ต้องเป็นตัวเลข 4–6 หลัก');
    if (!pinUser.trim()) return setError('กรุณากรอกชื่อผู้ใช้');
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
      setError(err instanceof Error ? err.message : 'เข้าสู่ระบบด้วย PIN ไม่สำเร็จ');
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
      setError(err instanceof Error ? err.message : 'เริ่ม SSO ไม่สำเร็จ');
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

      <Card className="w-full max-w-sm gap-0 p-8 shadow-lg">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground shadow-sm">
            IE
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{company}</h1>
          <p className="mt-1 text-sm text-muted-foreground">เข้าสู่ระบบเพื่อจัดการธุรกิจของคุณ</p>
        </div>

        <div className="mb-5 flex gap-1 rounded-lg bg-muted p-1">
          {tab('password', 'รหัสผ่าน')}
          {tab('pin', 'PIN หน้าร้าน')}
        </div>

        {mode === 'password' ? (
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="username">ชื่อผู้ใช้</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">รหัสผ่าน</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="size-4 animate-spin" />}
              {loading ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
            </Button>
          </form>
        ) : (
          <form onSubmit={onPinSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="pinUser">ชื่อผู้ใช้ (พนักงาน)</Label>
              <Input
                id="pinUser"
                value={pinUser}
                onChange={(e) => setPinUser(e.target.value)}
                autoComplete="username"
                placeholder="เช่น cashier1"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label>PIN</Label>
              <div className="flex justify-center gap-2" aria-label="PIN ที่กรอก">
                {Array.from({ length: 6 }).map((_, i) => (
                  <span key={i} className={`size-3 rounded-full border ${i < pin.length ? 'bg-primary border-primary' : 'border-input'}`} />
                ))}
              </div>
              <div className="mt-1 grid grid-cols-3 gap-2">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
                  <Button key={k} type="button" variant="outline" className="h-12 text-lg" onClick={() => pinKey(k)}>{k}</Button>
                ))}
                <Button type="button" variant="ghost" className="h-12" onClick={() => pinKey('clr')}>ล้าง</Button>
                <Button type="button" variant="outline" className="h-12 text-lg" onClick={() => pinKey('0')}>0</Button>
                <Button type="button" variant="ghost" className="h-12" onClick={() => pinKey('del')} aria-label="ลบ"><Delete className="size-5" /></Button>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={openShift} onChange={(e) => setOpenShift(e.target.checked)} className="size-4 accent-primary" />
              เปิดกะเมื่อเข้าสู่ระบบ (เฉพาะผู้มีสิทธิ์เปิดลิ้นชัก)
            </label>
            {openShift && (
              <div className="grid gap-2">
                <Label htmlFor="float">เงินทอนเริ่มต้น (บาท)</Label>
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
              {loading ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ / เปิดกะ'}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              ตั้ง PIN ครั้งแรกที่เมนู “ตั้ง PIN หน้าร้าน” หลังเข้าสู่ระบบด้วยรหัสผ่าน
            </p>
          </form>
        )}

        {mode === 'password' && (
          <div className="mt-5">
            <div className="relative mb-4 text-center">
              <span className="relative z-10 bg-card px-2 text-xs text-muted-foreground">หรือ</span>
              <span className="absolute inset-x-0 top-1/2 -z-0 border-t" />
            </div>
            {!ssoOpen ? (
              <Button type="button" variant="outline" className="w-full gap-2" onClick={() => setSsoOpen(true)}>
                <KeyRound className="size-4" />
                เข้าสู่ระบบด้วย SSO (องค์กร)
              </Button>
            ) : (
              <form onSubmit={onSso} className="grid gap-2">
                <Label htmlFor="ssoTenant" className="text-sm">รหัสบริษัท (Company code)</Label>
                <Input id="ssoTenant" value={ssoTenant} onChange={(e) => setSsoTenant(e.target.value)} placeholder="เช่น ACME" autoFocus />
                <Button type="submit" variant="outline" className="w-full gap-2" disabled={!ssoTenant.trim() || ssoLoading}>
                  {ssoLoading && <Loader2 className="size-4 animate-spin" />}
                  {ssoLoading ? 'กำลังพาไป IdP…' : 'ดำเนินการต่อด้วย SSO'}
                </Button>
              </form>
            )}
          </div>
        )}

        <p className="mt-6 text-center text-sm text-muted-foreground">
          ยังไม่มีบัญชี?{' '}
          <Link href="/signup" className="font-medium text-primary hover:underline">
            สมัครใช้งานฟรี
          </Link>
        </p>
        <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5" />
          เชื่อมต่ออย่างปลอดภัย
        </p>
      </Card>
    </main>
  );
}
