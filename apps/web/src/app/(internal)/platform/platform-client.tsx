'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Eye, Pause, Play, Plus, Ticket, UserPlus } from 'lucide-react';

import { api, setActingTenant } from '@/lib/api';
import { thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable, type Column } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

interface Company {
  id: number;
  code: string;
  name: string;
  suspended: boolean;
  status: string | null;
  plan_code: string | null;
  trial_ends_at: string | null;
  users: number;
  created_at: string | null;
}

interface SignupRequest {
  id: number;
  company_name: string;
  tenant_code: string;
  admin_username: string;
  email: string | null;
  status: string;
  requested_at: string | null;
}

const INDUSTRIES = ['restaurant', 'retail', 'distribution', 'services', 'manufacturing'];

function statusBadge(s: string | null) {
  const variant =
    s === 'Active' ? 'default'
    : s === 'Trialing' ? 'secondary'
    : s === 'Suspended' ? 'destructive'
    : s === 'PastDue' ? 'destructive'
    : 'outline';
  const th =
    s === 'Active' ? 'ใช้งาน'
    : s === 'Trialing' ? 'ทดลอง'
    : s === 'Suspended' ? 'ระงับ'
    : s === 'PastDue' ? 'ค้างชำระ'
    : s === 'Canceled' ? 'ยกเลิก'
    : (s ?? '—');
  return <Badge variant={variant as 'default' | 'secondary' | 'destructive' | 'outline'}>{th}</Badge>;
}

export default function PlatformConsole({
  initialCompanies,
  initialRequests,
}: {
  initialCompanies?: Company[];
  initialRequests?: SignupRequest[];
}) {
  const qc = useQueryClient();
  const companies = useQuery<Company[]>({
    queryKey: ['admin-tenants'],
    queryFn: () => api<Company[]>('/api/admin/tenants'),
    initialData: initialCompanies,
  });
  const requests = useQuery<SignupRequest[]>({
    queryKey: ['signup-requests', 'pending'],
    queryFn: () => api<{ requests: SignupRequest[] }>('/api/admin/signup-requests?status=pending').then((r) => r.requests),
    initialData: initialRequests,
  });
  const invites = useQuery<any[]>({
    queryKey: ['signup-invites'],
    queryFn: () => api<{ invites: any[] }>('/api/admin/signup-invites').then((r) => r.invites),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-tenants'] });
    qc.invalidateQueries({ queryKey: ['signup-requests', 'pending'] });
    qc.invalidateQueries({ queryKey: ['signup-invites'] });
  };

  // Jump into a company: set the god act-as scope, then reload so every screen refetches under it.
  const view = (c: Company) => {
    setActingTenant({ id: c.id, name: c.name, code: c.code });
    window.location.assign('/dashboard');
  };

  const suspend = useMutation({
    mutationFn: (c: Company) =>
      api(`/api/admin/tenants/${c.id}/${c.suspended ? 'reactivate' : 'suspend'}`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (_d, c) => { notifySuccess(c.suspended ? `คืนสถานะ ${c.name} แล้ว` : `ระงับ ${c.name} แล้ว`); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const [prov, setProv] = useState({ company_name: '', tenant_code: '', admin_username: '', admin_password: '', email: '', industry: 'restaurant' });
  const [provOpen, setProvOpen] = useState(false);
  const provision = useMutation({
    mutationFn: () => api('/api/admin/tenants', { method: 'POST', body: JSON.stringify(prov) }),
    onSuccess: () => {
      notifySuccess(`เปิดบริษัท ${prov.company_name} แล้ว`);
      setProv({ company_name: '', tenant_code: '', admin_username: '', admin_password: '', email: '', industry: 'restaurant' });
      setProvOpen(false);
      refresh();
    },
    onError: (e: any) => notifyError(e.message),
  });

  const approve = useMutation({
    mutationFn: (r: SignupRequest) => api(`/api/admin/signup-requests/${r.id}/approve`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (_d, r) => { notifySuccess(`อนุมัติ ${r.company_name} แล้ว`); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (r: SignupRequest) => {
      const reason = prompt(`เหตุผลที่ปฏิเสธ ${r.company_name} (ไม่บังคับ)`);
      if (reason === null) return Promise.resolve(null);
      return api(`/api/admin/signup-requests/${r.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: reason || undefined }) });
    },
    onSuccess: (d, r) => { if (d) { notifySuccess(`ปฏิเสธ ${r.company_name} แล้ว`); refresh(); } },
    onError: (e: any) => notifyError(e.message),
  });

  const [inv, setInv] = useState({ company_name: '', email: '', ttl_hours: '72' });
  const [invOpen, setInvOpen] = useState(false);
  const [lastInvite, setLastInvite] = useState<{ invite_token: string; expires_at?: string } | null>(null);
  const issueInvite = useMutation({
    mutationFn: () => api<{ invite_token: string; expires_at?: string }>('/api/admin/signup-invites', {
      method: 'POST',
      body: JSON.stringify({ company_name: inv.company_name || undefined, email: inv.email || undefined, ttl_hours: Number(inv.ttl_hours) || undefined }),
    }),
    onSuccess: (d) => { setLastInvite(d); setInv({ company_name: '', email: '', ttl_hours: '72' }); notifySuccess('ออกลิงก์เชิญแล้ว — คัดลอกโทเคนด้านล่าง (แสดงครั้งเดียว)'); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const companyCols: Column<Company>[] = [
    { key: 'name', label: 'บริษัท', sortable: true, render: (c) => (
      <div className="grid leading-tight">
        <span className="font-medium">{c.name}</span>
        <span className="text-xs text-muted-foreground">{c.code}</span>
      </div>
    ) },
    { key: 'status', label: 'สถานะ', render: (c) => statusBadge(c.status) },
    { key: 'plan_code', label: 'แพ็กเกจ', render: (c) => c.plan_code ?? '—' },
    { key: 'users', label: 'ผู้ใช้', align: 'right', sortable: true, render: (c) => c.users },
    { key: 'trial_ends_at', label: 'ทดลองถึง', render: (c) => (c.trial_ends_at ? thaiDate(c.trial_ends_at) : '—') },
    { key: 'created_at', label: 'เปิดเมื่อ', sortable: true, render: (c) => (c.created_at ? thaiDate(c.created_at) : '—') },
    { key: 'actions', label: '', align: 'right', render: (c) => (
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="outline" onClick={() => view(c)}><Eye className="size-3.5" /> เข้าดู</Button>
        <Button size="sm" variant={c.suspended ? 'outline' : 'ghost'} onClick={() => suspend.mutate(c)} disabled={suspend.isPending}>
          {c.suspended ? <><Play className="size-3.5" /> คืนสถานะ</> : <><Pause className="size-3.5" /> ระงับ</>}
        </Button>
      </div>
    ) },
  ];

  const requestCols: Column<SignupRequest>[] = [
    { key: 'company_name', label: 'บริษัท', render: (r) => (
      <div className="grid leading-tight">
        <span className="font-medium">{r.company_name}</span>
        <span className="text-xs text-muted-foreground">{r.tenant_code} · {r.admin_username}{r.email ? ` · ${r.email}` : ''}</span>
      </div>
    ) },
    { key: 'requested_at', label: 'ขอเมื่อ', render: (r) => (r.requested_at ? thaiDate(r.requested_at) : '—') },
    { key: 'actions', label: '', align: 'right', render: (r) => (
      <div className="flex justify-end gap-1">
        <Button size="sm" onClick={() => approve.mutate(r)} disabled={approve.isPending}>อนุมัติ</Button>
        <Button size="sm" variant="ghost" onClick={() => reject.mutate(r)} disabled={reject.isPending}>ปฏิเสธ</Button>
      </div>
    ) },
  ];

  const provisionDialog = (
    <Dialog open={provOpen} onOpenChange={setProvOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="size-4" /> เปิดบริษัทใหม่</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>เปิดบริษัทใหม่</DialogTitle>
          <DialogDescription>สร้าง tenant + ผู้ดูแล (Admin) + ผังบัญชีตามอุตสาหกรรม ให้บริษัทใหม่ทันที</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1"><Label>ชื่อกิจการ</Label><Input value={prov.company_name} onChange={(e) => setProv({ ...prov, company_name: e.target.value })} placeholder="ร้านโอชิเนอิ" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1"><Label>รหัส tenant</Label><Input value={prov.tenant_code} onChange={(e) => setProv({ ...prov, tenant_code: e.target.value })} placeholder="OSHINEI" /></div>
            <div className="grid gap-1"><Label>อุตสาหกรรม</Label>
              <select className="h-9 rounded-md border border-input bg-transparent px-3 text-sm" value={prov.industry} onChange={(e) => setProv({ ...prov, industry: e.target.value })}>
                {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1"><Label>ชื่อผู้ใช้ Admin</Label><Input value={prov.admin_username} onChange={(e) => setProv({ ...prov, admin_username: e.target.value })} /></div>
            <div className="grid gap-1"><Label>รหัสผ่าน Admin</Label><Input type="password" value={prov.admin_password} onChange={(e) => setProv({ ...prov, admin_password: e.target.value })} /></div>
          </div>
          <div className="grid gap-1"><Label>อีเมล</Label><Input type="email" value={prov.email} onChange={(e) => setProv({ ...prov, email: e.target.value })} /></div>
        </div>
        <DialogFooter>
          <Button onClick={() => provision.mutate()} disabled={provision.isPending || !prov.company_name || !prov.tenant_code || !prov.admin_username || !prov.admin_password}>
            {provision.isPending ? 'กำลังสร้าง…' : 'สร้างบริษัท'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const inviteDialog = (
    <Dialog open={invOpen} onOpenChange={(o) => { setInvOpen(o); if (!o) setLastInvite(null); }}>
      <DialogTrigger asChild>
        <Button variant="outline"><Ticket className="size-4" /> ออกลิงก์เชิญ</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>ออกลิงก์เชิญเปิดบริษัท</DialogTitle>
          <DialogDescription>ลิงก์ใช้ครั้งเดียว มีวันหมดอายุ — ผู้รับสมัครเองได้แม้ปิด public signup</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1"><Label>ชื่อบริษัท (ไม่บังคับ)</Label><Input value={inv.company_name} onChange={(e) => setInv({ ...inv, company_name: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1"><Label>อีเมล (ไม่บังคับ)</Label><Input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></div>
            <div className="grid gap-1"><Label>อายุ (ชม.)</Label><Input value={inv.ttl_hours} onChange={(e) => setInv({ ...inv, ttl_hours: e.target.value })} /></div>
          </div>
          {lastInvite && (
            <div className="rounded-md border border-primary/40 bg-primary/5 p-2 text-xs">
              <div className="font-medium">โทเคนเชิญ (คัดลอกเลย — จะไม่แสดงอีก):</div>
              <code className="mt-1 block break-all rounded bg-background p-1.5">{lastInvite.invite_token}</code>
              {lastInvite.expires_at && <div className="mt-1 text-muted-foreground">หมดอายุ {thaiDate(lastInvite.expires_at)}</div>}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => issueInvite.mutate()} disabled={issueInvite.isPending}>{issueInvite.isPending ? 'กำลังออก…' : 'ออกลิงก์'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const companiesTab = (
    <StateView q={companies}>
      <DataTable
        rows={companies.data ?? []}
        columns={companyCols}
        rowKey={(c) => c.id}
        emptyState={{ icon: Building2, title: 'ยังไม่มีบริษัท', description: 'เปิดบริษัทแรกด้วยปุ่ม “เปิดบริษัทใหม่”' }}
      />
    </StateView>
  );

  const onboardingTab = (
    <div className="space-y-6">
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-medium"><UserPlus className="size-4 text-primary" /> คำขอเปิดบริษัท (รออนุมัติ)</h3>
        <StateView q={requests}>
          <DataTable
            rows={requests.data ?? []}
            columns={requestCols}
            rowKey={(r) => r.id}
            emptyState={{ icon: UserPlus, title: 'ไม่มีคำขอค้าง', description: 'คำขอผ่านฟอร์ม “ขอเปิดบริษัท” จะมาโผล่ที่นี่' }}
          />
        </StateView>
      </div>
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-medium"><Ticket className="size-4 text-primary" /> ลิงก์เชิญ</h3>
        <StateView q={invites}>
          <DataTable
            rows={invites.data ?? []}
            columns={[
              { key: 'company_name', label: 'บริษัท', render: (i: any) => i.company_name ?? '—' },
              { key: 'email', label: 'อีเมล', render: (i: any) => i.email ?? '—' },
              { key: 'status', label: 'สถานะ', render: (i: any) => (i.status === 'used' ? 'ใช้แล้ว' : i.status === 'expired' ? 'หมดอายุ' : 'รอใช้') },
              { key: 'expires_at', label: 'หมดอายุ', render: (i: any) => (i.expires_at ? thaiDate(i.expires_at) : '—') },
            ]}
            rowKey={(i: any, idx) => i.id ?? idx}
            emptyText="ยังไม่มีลิงก์เชิญ"
          />
        </StateView>
      </div>
    </div>
  );

  const pending = requests.data?.length ?? 0;

  return (
    <div>
      <PageHeader
        title="ศูนย์ควบคุมแพลตฟอร์ม"
        description="ดูแลทุกบริษัทในระบบ — เปิด/ระงับบริษัท, อนุมัติคำขอ, ออกลิงก์เชิญ และเข้าดูข้อมูลรายบริษัท"
        actions={<div className="flex gap-2">{inviteDialog}{provisionDialog}</div>}
      />
      <Tabs
        urlParam="tab"
        tabs={[
          { key: 'companies', label: `บริษัท (${companies.data?.length ?? 0})`, content: companiesTab },
          { key: 'onboarding', label: pending ? `Onboarding (${pending})` : 'Onboarding', content: onboardingTab },
        ]}
      />
    </div>
  );
}
