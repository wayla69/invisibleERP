'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, ShieldCheck, KeyRound } from 'lucide-react';
import { api, publicApi, setToken } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [company, setCompany] = useState('Invisible ERP V2');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ssoOpen, setSsoOpen] = useState(false);
  const [ssoTenant, setSsoTenant] = useState('');
  const [ssoLoading, setSsoLoading] = useState(false);

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
      setToken(res.token);
      router.push(res.role === 'Customer' ? '/portal/dashboard' : '/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เข้าสู่ระบบไม่สำเร็จ');
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
