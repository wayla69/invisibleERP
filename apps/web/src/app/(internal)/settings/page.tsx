'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

export default function SettingsPage() {
  return (
    <div>
      <PageHeader title="ตั้งค่า" description="API Keys และความปลอดภัย" />
      <Tabs
        tabs={[
          { key: 'keys', label: 'API Keys', content: <ApiKeys /> },
          { key: 'mfa', label: 'ความปลอดภัย (MFA)', content: <Mfa /> },
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
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <div>
          <h3 className="text-base font-semibold">สร้าง API Key ใหม่</h3>
          <p className="text-sm text-muted-foreground">สำหรับเชื่อมต่อระบบภายนอกกับ ERP ของคุณ</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-[180px] flex-1" placeholder="ชื่อ key (เช่น Zapier)" value={name} onChange={(e) => setName(e.target.value)} />
          <Button disabled={!name || create.isPending} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? 'กำลังสร้าง…' : 'สร้าง Key'}
          </Button>
        </div>
        <Msg>{msg}</Msg>
        {newKey && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-warning-foreground dark:text-warning">
              <TriangleAlert className="size-4" /> คัดลอกเก็บไว้ตอนนี้ — จะแสดงเพียงครั้งเดียว
            </div>
            <code className="mt-1.5 block break-all text-sm">{newKey}</code>
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
            { key: 'revoked', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.revoked ? 'Cancelled' : 'Open')}>{r.revoked ? 'Cancelled' : 'Open'}</Badge> },
            { key: 'act', label: '', render: (r: any) => !r.revoked && <Button variant="destructive" size="sm" onClick={() => revoke.mutate(r.id)}>เพิกถอน</Button> },
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
    <Card className="max-w-[480px] gap-4 p-5">
      <div>
        <h3 className="text-base font-semibold">ยืนยันตัวตนสองชั้น (Two-Factor / TOTP)</h3>
        <p className="text-sm text-muted-foreground">เพิ่มความปลอดภัยด้วยแอป Google Authenticator / Authy</p>
      </div>
      {!setup ? (
        <Button disabled={begin.isPending} onClick={() => begin.mutate()}>
          <ShieldCheck className="size-4" /> {begin.isPending ? 'กำลังเริ่ม…' : 'เริ่มตั้งค่า MFA'}
        </Button>
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <span className="text-sm text-muted-foreground">1) เพิ่มลงในแอป Authenticator ด้วยรหัสลับนี้:</span>
            <code className="block break-all rounded-md bg-muted p-2 text-sm">{setup.secret}</code>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mfa-token">2) ใส่รหัส 6 หลักจากแอปเพื่อยืนยัน</Label>
            <Input id="mfa-token" inputMode="numeric" maxLength={6} placeholder="000000" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <Button disabled={token.length < 6 || verify.isPending} onClick={() => verify.mutate()}>
            {verify.isPending ? 'กำลังยืนยัน…' : 'ยืนยันเปิดใช้งาน'}
          </Button>
        </div>
      )}
      <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
    </Card>
  );
}
