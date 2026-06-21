'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, setToken } from '@/lib/api';

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
      const res = await api<{ token: string; role: string }>('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setToken(res.token);
      // ลูกค้า → portal ; พนักงาน → หลังบ้าน
      router.push(res.role === 'Customer' ? '/portal/dashboard' : '/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เข้าสู่ระบบไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 20 }}>
      <div className="card" style={{ width: 360 }}>
        <h2 style={{ marginTop: 0, color: 'var(--navy)' }}>{company}</h2>
        <p className="label" style={{ marginTop: -8 }}>เข้าสู่ระบบ / Sign in</p>
        <form onSubmit={onSubmit}>
          <label className="label">
            Username
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </label>
          <div style={{ height: 12 }} />
          <label className="label">
            Password
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          {error && <p style={{ color: 'var(--ruby)', fontSize: 13 }}>{error}</p>}
          <div style={{ height: 16 }} />
          <button className="btn" style={{ width: '100%' }} disabled={loading}>
            {loading ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
          </button>
        </form>
        <p className="label" style={{ textAlign: 'center', marginTop: 14 }}>
          ยังไม่มีบัญชี? <Link href="/signup" style={{ color: 'var(--navy)', fontWeight: 600 }}>สมัครใช้งานฟรี</Link>
        </p>
      </div>
    </main>
  );
}
