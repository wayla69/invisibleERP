'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, DataTable, Badge, StateView } from '@/components/ui';
import { Tabs, Msg } from '@/components/tabs';

export default function SettingsPage() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>⚙️ ตั้งค่า (Settings)</h1>
      <Tabs
        tabs={[
          { key: 'keys', label: '🔑 API Keys', content: <ApiKeys /> },
          { key: 'mfa', label: '🔐 ความปลอดภัย (MFA)', content: <Mfa /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── API Keys ─────────────────────────
function ApiKeys() {
  const qc = useQueryClient();
  const list = useQuery<any>({ queryKey: ['api-keys'], queryFn: () => api('/api/platform/api-keys') });
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [msg, setMsg] = useState('');

  const rows = Array.isArray(list.data) ? list.data : (list.data?.keys ?? list.data?.api_keys ?? []);

  const create = useMutation({
    mutationFn: () => api<{ key: string }>('/api/platform/api-keys', { method: 'POST', body: JSON.stringify({ name, scopes: ['read'] }) }),
    onSuccess: (r) => { setNewKey(r.key); setName(''); setMsg(''); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api(`/api/platform/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card>
        <h3 style={{ marginTop: 0 }}>สร้าง API Key ใหม่</h3>
        <p className="label" style={{ marginTop: -6 }}>สำหรับเชื่อมต่อระบบภายนอกกับ ERP ของคุณ</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="input" placeholder="ชื่อ key (เช่น Zapier)" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
          <button className="btn" disabled={!name || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'กำลังสร้าง…' : '+ สร้าง Key'}
          </button>
        </div>
        <Msg>{msg}</Msg>
        {newKey && (
          <div style={{ marginTop: 12, padding: 12, background: '#fef9c3', borderRadius: 8, border: '1px solid #fde047' }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>⚠️ คัดลอกเก็บไว้ตอนนี้ — จะแสดงเพียงครั้งเดียว</div>
            <code style={{ display: 'block', wordBreak: 'break-all', marginTop: 6, fontSize: 14 }}>{newKey}</code>
          </div>
        )}
      </Card>

      <StateView q={list}>
        <DataTable
          rows={rows}
          columns={[
            { key: 'name', label: 'ชื่อ' },
            { key: 'prefix', label: 'Prefix', render: (r: any) => <code>{r.prefix}…</code> },
            { key: 'scopes', label: 'สิทธิ์', render: (r: any) => (Array.isArray(r.scopes) ? r.scopes.join(', ') : String(r.scopes ?? '')) },
            { key: 'revoked', label: 'สถานะ', render: (r: any) => <Badge value={r.revoked ? 'Cancelled' : 'Open'} /> },
            { key: 'act', label: '', render: (r: any) => !r.revoked && <button className="btn" style={{ padding: '4px 10px', background: 'var(--ruby)' }} onClick={() => revoke.mutate(r.id)}>เพิกถอน</button> },
          ]}
        />
      </StateView>
    </div>
  );
}

// ───────────────────────── MFA (TOTP) ─────────────────────────
function Mfa() {
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState('');

  const begin = useMutation({
    mutationFn: () => api<{ secret: string; otpauth_url: string }>('/api/platform/mfa/setup', { method: 'POST' }),
    onSuccess: (r) => { setSetup(r); setMsg(''); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const verify = useMutation({
    mutationFn: () => api('/api/platform/mfa/verify', { method: 'POST', body: JSON.stringify({ token }) }),
    onSuccess: () => setMsg('✅ เปิดใช้งาน MFA สำเร็จ — ครั้งต่อไปต้องใส่รหัส 6 หลัก'),
    onError: (e: any) => setMsg(`❌ รหัสไม่ถูกต้อง (${e.message})`),
  });

  return (
    <Card style={{ maxWidth: 480 }}>
      <h3 style={{ marginTop: 0 }}>ยืนยันตัวตนสองชั้น (Two-Factor / TOTP)</h3>
      <p className="label" style={{ marginTop: -6 }}>เพิ่มความปลอดภัยด้วยแอป Google Authenticator / Authy</p>
      {!setup ? (
        <button className="btn" disabled={begin.isPending} onClick={() => begin.mutate()}>
          {begin.isPending ? 'กำลังเริ่ม…' : '🔐 เริ่มตั้งค่า MFA'}
        </button>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          <div>
            <div className="label">1) เพิ่มลงในแอป Authenticator ด้วยรหัสลับนี้:</div>
            <code style={{ display: 'block', wordBreak: 'break-all', padding: 8, background: 'var(--bg-soft, #f3f4f6)', borderRadius: 6, marginTop: 4 }}>{setup.secret}</code>
          </div>
          <label className="label">2) ใส่รหัส 6 หลักจากแอปเพื่อยืนยัน
            <input className="input" inputMode="numeric" maxLength={6} placeholder="000000" value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <button className="btn" disabled={token.length < 6 || verify.isPending} onClick={() => verify.mutate()}>
            {verify.isPending ? 'กำลังยืนยัน…' : 'ยืนยันเปิดใช้งาน'}
          </button>
        </div>
      )}
      <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
    </Card>
  );
}
