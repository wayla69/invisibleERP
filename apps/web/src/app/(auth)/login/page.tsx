'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, ShieldCheck } from 'lucide-react';
import { api, setToken } from '@/lib/api';
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
      // Usernames are stored canonicalized (trimmed + lowercased) server-side; mirror that here so the
      // submitted value matches regardless of casing or stray surrounding whitespace.
      const res = await api<{ token: string; role: string }>('/api/login', {
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
