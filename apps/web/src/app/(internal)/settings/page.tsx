'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus, Power, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { humanizeModule } from '@/lib/modules';
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
          { key: 'modules', label: 'โมดูล (เปิด/ปิด)', content: <Modules /> },
          { key: 'keys', label: 'API Keys', content: <ApiKeys /> },
          { key: 'identity', label: 'SSO / SCIM', content: <Identity /> },
          { key: 'mfa', label: 'ความปลอดภัย (MFA)', content: <Mfa /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Modules (system-wide on/off) ─────────────────────────
function Modules() {
  const qc = useQueryClient();
  const list = useQuery<{ modules: { key: string; enabled: boolean; always_on: boolean }[] }>({
    queryKey: ['admin-modules'],
    queryFn: () => api('/api/admin/modules'),
  });
  const [msg, setMsg] = useState('');

  const toggle = useMutation({
    mutationFn: (v: { key: string; enabled: boolean }) => api('/api/admin/modules', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: (_r, v) => {
      setMsg(`✅ ${humanizeModule(v.key)} → ${v.enabled ? 'เปิด' : 'ปิด'}`);
      qc.invalidateQueries({ queryKey: ['admin-modules'] });
      qc.invalidateQueries({ queryKey: ['module-flags'] }); // refresh the sidebar nav
    },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  const mods = list.data?.modules ?? [];
  const disabledCount = mods.filter((m) => !m.enabled).length;

  return (
    <div className="space-y-4">
      <Card className="gap-2 p-5">
        <h3 className="text-base font-semibold">เปิด / ปิด การใช้งานโมดูล (ทั้งระบบ)</h3>
        <p className="text-sm text-muted-foreground">
          เมื่อปิดโมดูล จะถูกซ่อนจากเมนูของผู้ใช้ทุกคนและเข้าใช้งานไม่ได้ — โมดูล “Users” ปิดไม่ได้เพื่อให้ผู้ดูแลเข้าถึงได้เสมอ
        </p>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
        {disabledCount > 0 && <Badge variant={statusVariant('Cancelled')}>ปิดอยู่ {disabledCount} โมดูล</Badge>}
      </Card>

      <StateView q={list}>
        <DataTable
          rows={mods}
          columns={[
            { key: 'key', label: 'โมดูล', render: (r: any) => <span className="font-medium">{humanizeModule(r.key)}</span> },
            { key: 'code', label: 'รหัส', render: (r: any) => <code className="text-xs text-muted-foreground">{r.key}</code> },
            {
              key: 'enabled', label: 'สถานะ',
              render: (r: any) => <Badge variant={statusVariant(r.enabled ? 'Open' : 'Cancelled')}>{r.enabled ? 'เปิดอยู่' : 'ปิดอยู่'}</Badge>,
            },
            {
              key: 'act', label: '',
              render: (r: any) => r.always_on ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3.5" /> always-on</span>
              ) : (
                <Button variant={r.enabled ? 'destructive' : 'default'} size="sm" disabled={toggle.isPending}
                  onClick={() => toggle.mutate({ key: r.key, enabled: !r.enabled })}>
                  <Power className="size-4" /> {r.enabled ? 'ปิด' : 'เปิด'}
                </Button>
              ),
            },
          ]}
        />
      </StateView>
    </div>
  );
}

// ───────────────────────── API Keys ─────────────────────────
// Public API (v1) scopes an integrator key can be granted. The aliases read/write/* are also
// accepted by the server; here we expose the granular per-resource read scopes plus 'read'.
const API_KEY_SCOPES: { key: string; label: string }[] = [
  { key: 'read', label: 'อ่านทั้งหมด (read)' },
  { key: 'catalog:read', label: 'แค็ตตาล็อกสินค้า (catalog:read)' },
  { key: 'inventory:read', label: 'สต๊อก (inventory:read)' },
  { key: 'orders:read', label: 'ออเดอร์ (orders:read)' },
  { key: 'invoices:read', label: 'ใบแจ้งหนี้ (invoices:read)' },
];

function ApiKeys() {
  const qc = useQueryClient();
  const list = useQuery<any>({ queryKey: ['api-keys'], queryFn: () => api('/api/platform/api-keys') });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [newKey, setNewKey] = useState('');
  const [msg, setMsg] = useState('');

  const rows = Array.isArray(list.data) ? list.data : (list.data?.keys ?? list.data?.api_keys ?? []);
  const toggleScope = (k: string) => setScopes((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));

  const create = useMutation({
    mutationFn: () => api<{ key: string }>('/api/platform/api-keys', { method: 'POST', body: JSON.stringify({ name, scopes: scopes.length ? scopes : ['read'] }) }),
    onSuccess: (r) => { setNewKey(r.key); setName(''); setScopes(['read']); setMsg(''); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
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
          <p className="text-sm text-muted-foreground">
            สำหรับเชื่อมต่อระบบภายนอกกับ Public API (<code>/api/v1</code>) ของคุณ · เอกสาร:{' '}
            <a href="/api/v1/openapi.json" className="underline" target="_blank" rel="noreferrer">openapi.json</a>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-[180px] flex-1" placeholder="ชื่อ key (เช่น Zapier)" value={name} onChange={(e) => setName(e.target.value)} />
          <Button disabled={!name || create.isPending} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? 'กำลังสร้าง…' : 'สร้าง Key'}
          </Button>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">สิทธิ์ (scopes) ที่อนุญาต</p>
          <div className="flex flex-wrap gap-1.5">
            {API_KEY_SCOPES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => toggleScope(s.key)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs transition-colors',
                  scopes.includes(s.key) ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent',
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
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
            { key: 'act', label: '', render: (r: any) => !r.revoked && <Button variant="destructive" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(r.id)}>เพิกถอน</Button> },
          ]}
        />
      </StateView>
    </div>
  );
}

// ───────────────────────── Identity (SSO / SCIM) ─────────────────────────
function Identity() {
  const qc = useQueryClient();
  const cfg = useQuery<any>({ queryKey: ['identity-config'], queryFn: () => api('/api/platform/identity') });
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [redirect, setRedirect] = useState('');
  const [defaultRole, setDefaultRole] = useState('Customer');
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [scimToken, setScimToken] = useState('');
  const [msg, setMsg] = useState('');
  const [seeded, setSeeded] = useState(false);

  // Seed the form once from the server config (secrets are never returned, so they stay blank).
  useEffect(() => {
    if (!cfg.data || seeded) return;
    setIssuer(cfg.data.oidc_issuer ?? '');
    setClientId(cfg.data.oidc_client_id ?? '');
    setRedirect(cfg.data.oidc_redirect_uri ?? '');
    setDefaultRole(cfg.data.default_role ?? 'Customer');
    setSsoEnabled(!!cfg.data.sso_enabled);
    setSeeded(true);
  }, [cfg.data, seeded]);

  const save = useMutation({
    mutationFn: () => api('/api/platform/identity', { method: 'PUT', body: JSON.stringify({
      sso_enabled: ssoEnabled, oidc_issuer: issuer, oidc_client_id: clientId,
      ...(secret ? { oidc_client_secret: secret } : {}), oidc_redirect_uri: redirect, default_role: defaultRole,
    }) }),
    onSuccess: () => { setMsg('✅ บันทึกการตั้งค่า IdP แล้ว'); setSecret(''); qc.invalidateQueries({ queryKey: ['identity-config'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const rotate = useMutation({
    mutationFn: () => api<{ token: string }>('/api/platform/identity/scim-token', { method: 'POST' }),
    onSuccess: (r) => { setScimToken(r.token); qc.invalidateQueries({ queryKey: ['identity-config'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5">
        <div>
          <h3 className="text-base font-semibold">เข้าสู่ระบบด้วย SSO (OIDC)</h3>
          <p className="text-sm text-muted-foreground">เชื่อมต่อ Identity Provider ขององค์กร (Azure AD, Okta, Google) ให้พนักงานล็อกอินด้วยบัญชีองค์กร</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ssoEnabled} onChange={(e) => setSsoEnabled(e.target.checked)} />
          เปิดใช้งาน SSO
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label>Issuer URL</Label><Input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://login.example.com" /></div>
          <div className="grid gap-1.5"><Label>Client ID</Label><Input value={clientId} onChange={(e) => setClientId(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label>Client Secret {cfg.data?.has_client_secret && <span className="text-xs text-muted-foreground">(ตั้งไว้แล้ว — เว้นว่างเพื่อคงเดิม)</span>}</Label><Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="••••••" /></div>
          <div className="grid gap-1.5"><Label>Redirect URI</Label><Input value={redirect} onChange={(e) => setRedirect(e.target.value)} placeholder="https://app.example/sso/callback" /></div>
          <div className="grid gap-1.5"><Label>บทบาทเริ่มต้นของผู้ใช้ใหม่</Label><Input value={defaultRole} onChange={(e) => setDefaultRole(e.target.value)} /></div>
        </div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
        <div><Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'กำลังบันทึก…' : 'บันทึก'}</Button></div>
      </Card>

      <Card className="gap-3 p-5">
        <div>
          <h3 className="text-base font-semibold">SCIM 2.0 — จัดการผู้ใช้อัตโนมัติ</h3>
          <p className="text-sm text-muted-foreground">ให้ IdP เพิ่ม/ปิดผู้ใช้อัตโนมัติผ่าน SCIM endpoint <code>/scim/v2</code> ด้วย bearer token นี้</p>
        </div>
        {cfg.data?.has_scim_token && !scimToken && <p className="text-sm text-muted-foreground">โทเค็นปัจจุบัน: <code>{cfg.data.scim_token_prefix}…</code></p>}
        {scimToken && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-warning-foreground dark:text-warning">
              <TriangleAlert className="size-4" /> คัดลอกเก็บไว้ตอนนี้ — จะแสดงเพียงครั้งเดียว
            </div>
            <code className="mt-1.5 block break-all text-sm">{scimToken}</code>
          </div>
        )}
        <div><Button variant="outline" disabled={rotate.isPending} onClick={() => rotate.mutate()}>{rotate.isPending ? 'กำลังสร้าง…' : (cfg.data?.has_scim_token ? 'สร้างโทเค็นใหม่ (เพิกถอนของเดิม)' : 'สร้าง SCIM token')}</Button></div>
      </Card>
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
