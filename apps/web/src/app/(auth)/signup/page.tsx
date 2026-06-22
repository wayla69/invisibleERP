'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, Rocket } from 'lucide-react';
import { api, setToken } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function SignupPage() {
  const router = useRouter();
  const [f, setF] = useState({ company_name: '', tenant_code: '', admin_username: '', admin_password: '', email: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api('/api/auth/signup', { method: 'POST', body: JSON.stringify(f) });
      const res = await api<{ token: string }>('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: f.admin_username, password: f.admin_password }),
      });
      setToken(res.token);
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'สมัครไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative grid min-h-svh place-items-center overflow-hidden bg-muted/30 p-5">
      <div className="pointer-events-none absolute -top-24 -right-24 size-96 rounded-full bg-primary/5 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-24 size-96 rounded-full bg-primary/5 blur-3xl" />

      <Card className="w-full max-w-md gap-0 p-8 shadow-lg">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground shadow-sm">
            IE
          </div>
          <h1 className="text-xl font-semibold tracking-tight">เริ่มใช้งานฟรี</h1>
          <p className="mt-1 text-sm text-muted-foreground">สร้างพื้นที่ ERP ของกิจการคุณใน 30 วินาที</p>
        </div>

        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="company_name">ชื่อกิจการ</Label>
            <Input id="company_name" value={f.company_name} onChange={set('company_name')} placeholder="ร้านโอชิเนอิ" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tenant_code">รหัสองค์กร (ภาษาอังกฤษ)</Label>
            <Input id="tenant_code" value={f.tenant_code} onChange={set('tenant_code')} placeholder="oshinei" autoCapitalize="none" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="email">อีเมล</Label>
            <Input id="email" type="email" value={f.email} onChange={set('email')} placeholder="you@email.com" required />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="admin_username">ชื่อผู้ใช้ผู้ดูแล</Label>
              <Input id="admin_username" value={f.admin_username} onChange={set('admin_username')} autoComplete="username" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="admin_password">รหัสผ่าน</Label>
              <Input id="admin_password" type="password" value={f.admin_password} onChange={set('admin_password')} autoComplete="new-password" minLength={8} required />
            </div>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />}
            {loading ? 'กำลังสร้าง…' : 'สร้างบัญชีและเริ่มใช้งาน'}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          มีบัญชีอยู่แล้ว?{' '}
          <Link href="/login" className="font-medium text-primary hover:underline">
            เข้าสู่ระบบ
          </Link>
        </p>
      </Card>
    </main>
  );
}
