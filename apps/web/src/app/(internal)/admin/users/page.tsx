'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, ShieldCheck, UserPlus } from 'lucide-react';
import { api, apiDownload } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const ROLES = [
  'Admin', 'Sales', 'Customer', 'Warehouse', 'Procurement', 'Planner',
  // SoD-clean single-duty roles
  'Cashier', 'PosSupervisor', 'ArClerk', 'ApClerk', 'Buyer', 'WarehouseOperator',
  'InventoryController', 'StockCounter', 'GlAccountant', 'FinancialController',
  'MasterDataAdmin', 'PricingManager', 'CreditManager', 'ReturnsClerk', 'AccessAdmin', 'ExecutiveViewer',
];
const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function AdminUsersPage() {
  const qc = useQueryClient();
  const list = useQuery<any>({ queryKey: ['admin-users'], queryFn: () => api('/api/admin/users') });
  const [f, setF] = useState({ username: '', password: '', role: 'Sales', customer_name: '' });
  const [msg, setMsg] = useState('');

  const create = useMutation({
    mutationFn: () => api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: f.username, password: f.password, role: f.role, customer_name: f.customer_name || undefined }) }),
    onSuccess: () => { setMsg(`✅ สร้างผู้ใช้ ${f.username}`); setF({ username: '', password: '', role: 'Sales', customer_name: '' }); qc.invalidateQueries({ queryKey: ['admin-users'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const setRole = useMutation({
    mutationFn: (v: { u: string; role: string }) => api(`/api/admin/users/${v.u}`, { method: 'PATCH', body: JSON.stringify({ role: v.role }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
  const reset = useMutation({
    mutationFn: (u: string) => { const pw = prompt(`รหัสผ่านใหม่สำหรับ ${u} (≥6 ตัว)`); return pw ? api(`/api/admin/users/${u}/reset-password`, { method: 'POST', body: JSON.stringify({ password: pw }) }) : Promise.resolve(null); },
    onSuccess: (r) => { if (r) setMsg('✅ รีเซ็ตรหัสผ่านแล้ว'); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const del = useMutation({
    mutationFn: (u: string) => api(`/api/admin/users/${u}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  // ── ITGC-AC-08: User Access Review ──
  const certs = useQuery<any>({ queryKey: ['uar-certs'], queryFn: () => api('/api/admin/users/access-review/certifications') });
  const lastCert = certs.data?.reviews?.[0];
  const certify = useMutation({
    mutationFn: () => { const period = prompt('ช่วงที่ทบทวน (เช่น 2026-Q2)'); if (!period) return Promise.resolve(null); const notes = prompt('หมายเหตุ (optional)') ?? undefined; return api('/api/admin/users/access-review/certify', { method: 'POST', body: JSON.stringify({ period, notes }) }); },
    onSuccess: (r: any) => { if (r) { setMsg(`✅ รับรองการทบทวนสิทธิ์ ${r.period} (${r.user_count} ผู้ใช้)`); qc.invalidateQueries({ queryKey: ['uar-certs'] }); } },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div className="space-y-4">
      <PageHeader title="จัดการผู้ใช้ (User Management)" description="สร้าง / แก้ไขสิทธิ์ / รีเซ็ตรหัสผ่าน / ลบบัญชีผู้ใช้" />
      <Card className="gap-3 p-5">
        <h3 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck className="size-4" /> การทบทวนสิทธิ์ผู้ใช้ (Access Review · ITGC-AC-08)</h3>
        <p className="text-sm text-muted-foreground">ส่งออกสิทธิ์จริงของผู้ใช้ทุกคน (พร้อมความขัดแย้ง SoD) เพื่อทบทวน แล้วบันทึกการรับรองรายไตรมาส.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => apiDownload('/api/admin/users/access-review/export', 'access-review.csv').catch((e) => setMsg(`❌ ${e.message}`))}><Download className="size-4" /> ส่งออก CSV</Button>
          <Button size="sm" disabled={certify.isPending} onClick={() => certify.mutate()}><ShieldCheck className="size-4" /> รับรองการทบทวน</Button>
          {lastCert && <span className="text-sm text-muted-foreground">ล่าสุด: {lastCert.period} · โดย {lastCert.reviewed_by} · {lastCert.user_count} ผู้ใช้ ({lastCert.conflict_user_count} ขัดแย้ง)</span>}
        </div>
      </Card>
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">สร้างบัญชีใหม่</h3>
        <div className="grid gap-2 sm:grid-cols-4">
          <div className="grid gap-1.5"><Label>Username</Label><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>Password</Label><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>Role</Label><select className={selectCls} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>
          <div className="grid gap-1.5"><Label>บริษัท (เลือก)</Label><Input value={f.customer_name} onChange={(e) => setF({ ...f, customer_name: e.target.value })} placeholder="tenant code" /></div>
        </div>
        <Button className="w-fit" disabled={!f.username || f.password.length < 6 || create.isPending} onClick={() => create.mutate()}><UserPlus className="size-4" /> สร้างผู้ใช้</Button>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={list}>
        {list.data && (
          <DataTable
            rows={list.data.users}
            columns={[
              { key: 'username', label: 'Username' },
              { key: 'role', label: 'Role', render: (r: any) => <select className={selectCls} value={r.role} onChange={(e) => setRole.mutate({ u: r.username, role: e.target.value })}>{ROLES.map((x) => <option key={x} value={x}>{x}</option>)}</select> },
              { key: 'customer_name', label: 'บริษัท', render: (r: any) => r.customer_name ?? '—' },
              { key: 'must_change_password', label: 'ต้องเปลี่ยนรหัส', render: (r: any) => r.must_change_password ? <Badge variant="warning">ใช่</Badge> : '—' },
              { key: 'reset', label: '', render: (r: any) => <Button size="sm" variant="outline" onClick={() => reset.mutate(r.username)}>รีเซ็ตรหัส</Button> },
              { key: 'del', label: '', render: (r: any) => <Button size="sm" variant="destructive" onClick={() => del.mutate(r.username)}>ลบ</Button> },
            ]}
            emptyText="ไม่มีผู้ใช้"
          />
        )}
      </StateView>
    </div>
  );
}
