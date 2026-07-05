'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Loader2, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function SignupPage() {
  const [f, setF] = useState({ company_name: '', tenant_code: '', admin_username: '', admin_password: '', email: '', industry: 'restaurant' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // Company creation is reserved to the platform owner (ITGC-AC-18). The public path submits a
      // request that the platform owner reviews and approves — no company is created here.
      await api('/api/auth/signup-requests', { method: 'POST', body: JSON.stringify(f) });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ส่งคำขอไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <main className="relative grid min-h-svh place-items-center overflow-hidden bg-muted/30 p-5">
        <div className="pointer-events-none absolute -top-24 -right-24 size-96 rounded-full bg-primary/5 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-24 size-96 rounded-full bg-primary/5 blur-3xl" />
        <Card className="w-full max-w-md gap-0 p-8 text-center shadow-lg">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400">
            <CheckCircle2 className="size-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">ส่งคำขอเรียบร้อยแล้ว</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            คำขอเปิดบริษัท <span className="font-medium">{f.company_name}</span> ถูกส่งให้ผู้ดูแลแพลตฟอร์มพิจารณาแล้ว
            เมื่อได้รับอนุมัติ เราจะเปิดใช้งานบัญชีผู้ดูแล <span className="font-medium">{f.admin_username}</span> และแจ้งให้ทราบทางอีเมล
          </p>
          <Link href="/login" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">
            กลับไปหน้าเข้าสู่ระบบ
          </Link>
        </Card>
      </main>
    );
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
          <h1 className="text-xl font-semibold tracking-tight">ขอเปิดใช้งานบริษัท</h1>
          <p className="mt-1 text-sm text-muted-foreground">กรอกรายละเอียดเพื่อส่งคำขอ — ผู้ดูแลแพลตฟอร์มจะอนุมัติและเปิดบัญชีให้</p>
        </div>

        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="company_name">ชื่อกิจการ</Label>
            <Input id="company_name" value={f.company_name} onChange={set('company_name')} placeholder="ร้านโอชิเนอิ" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="industry">ประเภทธุรกิจ</Label>
            <select
              id="industry"
              value={f.industry}
              onChange={set('industry')}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            >
              <option value="restaurant">ร้านอาหาร</option>
              <option value="retail">ค้าปลีก</option>
              <option value="distribution">ค้าส่ง / กระจายสินค้า</option>
              <option value="services">ธุรกิจบริการ</option>
              <option value="general">ทั่วไป (ผังบัญชีเต็ม)</option>
            </select>
            <p className="text-xs text-muted-foreground">เราจะตั้งผังบัญชีให้เหมาะกับธุรกิจของคุณโดยอัตโนมัติ (เปลี่ยนภายหลังได้)</p>
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
              <PasswordInput id="admin_password" value={f.admin_password} onChange={set('admin_password')} autoComplete="new-password" minLength={8} required />
            </div>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {loading ? 'กำลังส่งคำขอ…' : 'ส่งคำขอเปิดบริษัท'}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            การส่งคำขอถือว่ายอมรับ{' '}
            <Link href="/legal/privacy" className="underline hover:text-primary" target="_blank">
              นโยบายความเป็นส่วนตัว
            </Link>{' '}
            และข้อกำหนดการใช้บริการ
          </p>
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
