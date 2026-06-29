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

// Self-service: set/rotate your own POS quick-login PIN. Step-up with the current password (server-enforced).
export default function PosPinPage() {
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!/^\d{4,6}$/.test(pin)) return setError('PIN ต้องเป็นตัวเลข 4–6 หลัก');
    if (pin !== confirm) return setError('PIN และการยืนยันไม่ตรงกัน');
    if (!current) return setError('กรุณากรอกรหัสผ่านปัจจุบัน');
    setLoading(true);
    try {
      await api('/api/auth/me/pin', { method: 'POST', body: JSON.stringify({ current_password: current, pin }) });
      notifySuccess('ตั้ง PIN หน้าร้านเรียบร้อย — ใช้เข้าสู่ระบบด่วนได้แล้ว');
      setCurrent(''); setPin(''); setConfirm('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'ตั้ง PIN ไม่สำเร็จ';
      setError(msg);
      notifyError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="ตั้ง PIN หน้าร้าน" description="ตั้งรหัส PIN 4–6 หลักไว้เข้าสู่ระบบด่วนที่หน้าร้าน (เฉพาะพนักงานหน้าร้าน — บัญชีสิทธิ์สูงต้องใช้รหัสผ่าน)" />
      <Card className="max-w-sm gap-0 p-6">
        <div className="mb-5 flex items-center gap-2 text-base font-semibold">
          <KeyRound className="size-4" /> PIN ของฉัน
        </div>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="current">รหัสผ่านปัจจุบัน</Label>
            <Input id="current" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pin">PIN ใหม่ (4–6 หลัก)</Label>
            <Input id="pin" type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirm">ยืนยัน PIN</Label>
            <Input id="confirm" type="password" inputMode="numeric" maxLength={6} value={confirm} onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))} required />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" className="w-full" disabled={loading || pin.length < 4}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            {loading ? 'กำลังบันทึก…' : 'บันทึก PIN'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
