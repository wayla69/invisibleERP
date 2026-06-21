'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, setToken } from '@/lib/api';

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
      // สมัครเสร็จ → ล็อกอินอัตโนมัติเข้าหลังบ้านเลย
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
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 20 }}>
      <div className="card" style={{ width: 400 }}>
        <h2 style={{ marginTop: 0, color: 'var(--navy)' }}>เริ่มใช้งานฟรี</h2>
        <p className="label" style={{ marginTop: -8 }}>สร้างพื้นที่ ERP ของกิจการคุณใน 30 วินาที</p>
        <form onSubmit={onSubmit} style={{ display: 'grid', gap: 10 }}>
          <label className="label">ชื่อกิจการ
            <input className="input" value={f.company_name} onChange={set('company_name')} placeholder="ร้านโอชิเนอิ" required />
          </label>
          <label className="label">รหัสองค์กร (ภาษาอังกฤษ)
            <input className="input" value={f.tenant_code} onChange={set('tenant_code')} placeholder="oshinei" autoCapitalize="none" required />
          </label>
          <label className="label">อีเมล
            <input className="input" type="email" value={f.email} onChange={set('email')} placeholder="you@email.com" required />
          </label>
          <label className="label">ชื่อผู้ใช้ผู้ดูแล
            <input className="input" value={f.admin_username} onChange={set('admin_username')} autoComplete="username" required />
          </label>
          <label className="label">รหัสผ่าน (อย่างน้อย 8 ตัว)
            <input className="input" type="password" value={f.admin_password} onChange={set('admin_password')} autoComplete="new-password" minLength={8} required />
          </label>
          {error && <p style={{ color: 'var(--ruby)', fontSize: 13, margin: 0 }}>{error}</p>}
          <button className="btn" style={{ width: '100%', marginTop: 4 }} disabled={loading}>
            {loading ? 'กำลังสร้าง…' : '🚀 สร้างบัญชีและเริ่มใช้งาน'}
          </button>
        </form>
        <p className="label" style={{ textAlign: 'center', marginTop: 14 }}>
          มีบัญชีอยู่แล้ว? <Link href="/login" style={{ color: 'var(--navy)', fontWeight: 600 }}>เข้าสู่ระบบ</Link>
        </p>
      </div>
    </main>
  );
}
