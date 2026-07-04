'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, Building2, CircleDollarSign, Clock, Download, Eye, PauseCircle, Pause, Play, Plus, ShieldCheck, Ticket, TrendingUp, UserPlus, Users } from 'lucide-react';

import { api, apiDownload, setActingTenant } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError, notifyInfo } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable, type Column } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui/card';
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

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

// Slide-over with the full picture of one company (drill-down without fully switching into it) + the
// platform subscription controls (change plan / extend trial). Lives in this already-'use client' island.
function CompanyDrawer({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }) {
  const detail = useQuery<any>({
    queryKey: ['tenant-detail', id],
    queryFn: () => api(`/api/admin/tenants/${id}`),
    enabled: id != null,
  });
  const plans = useQuery<{ plans: { code: string; name: string }[] }>({
    queryKey: ['plans'],
    queryFn: () => api('/api/billing/plans'),
    enabled: id != null,
  });
  const [plan, setPlan] = useState('');
  const [days, setDays] = useState('14');

  const changePlan = useMutation({
    mutationFn: () => api(`/api/admin/tenants/${id}/plan`, { method: 'POST', body: JSON.stringify({ plan_code: plan }) }),
    onSuccess: () => { notifySuccess('เปลี่ยนแพ็กเกจแล้ว'); detail.refetch(); onChanged(); },
    onError: (e: any) => notifyError(e.message),
  });
  const extendTrial = useMutation({
    mutationFn: () => api(`/api/admin/tenants/${id}/extend-trial`, { method: 'POST', body: JSON.stringify({ days: Number(days) || 14 }) }),
    onSuccess: () => { notifySuccess('ต่อระยะทดลองแล้ว'); detail.refetch(); onChanged(); },
    onError: (e: any) => notifyError(e.message),
  });

  const d = detail.data;
  return (
    <Sheet open={id != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{d?.name ?? 'รายละเอียดบริษัท'}</SheetTitle>
          <SheetDescription>{d ? `${d.code}${d.legal_name ? ` · ${d.legal_name}` : ''}` : 'กำลังโหลด…'}</SheetDescription>
        </SheetHeader>
        <StateView q={detail}>
          {d && (
            <div className="space-y-5 px-4 pb-6 text-sm">
              {/* Snapshot */}
              <div className="grid grid-cols-2 gap-3">
                <div><div className="text-xs text-muted-foreground">สถานะ</div>{statusBadge(d.suspended ? 'Suspended' : d.subscription?.status ?? null)}</div>
                <div><div className="text-xs text-muted-foreground">แพ็กเกจ</div>{d.subscription?.plan_code ?? '—'}</div>
                <div><div className="text-xs text-muted-foreground">ผู้ใช้ · สาขา</div>{d.counts.users} · {d.counts.branches}</div>
                <div><div className="text-xs text-muted-foreground">ทดลองถึง</div>{d.subscription?.trial_ends_at ? thaiDate(d.subscription.trial_ends_at) : '—'}</div>
                <div><div className="text-xs text-muted-foreground">เลขภาษี</div>{d.tax_id ?? '—'}</div>
                <div><div className="text-xs text-muted-foreground">เปิดเมื่อ</div>{d.created_at ? thaiDate(d.created_at) : '—'}</div>
              </div>
              {d.suspended && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
                  ถูกระงับ{d.suspended_by ? ` โดย ${d.suspended_by}` : ''}{d.suspend_reason ? ` — ${d.suspend_reason}` : ''}
                </div>
              )}

              {/* AI usage */}
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">การใช้ AI (สะสม)</div>
                <div className="text-sm">in {num(d.ai_usage.input_tokens)} · out {num(d.ai_usage.output_tokens)} · overage {num(d.ai_usage.overage_tokens)} โทเคน</div>
              </div>

              {/* Subscription controls (platform-level, no impersonation) */}
              <div className="space-y-2 rounded-md border p-3">
                <div className="text-xs font-medium">จัดการ subscription</div>
                <div className="flex items-end gap-2">
                  <div className="grid flex-1 gap-1">
                    <Label className="text-xs">เปลี่ยนแพ็กเกจ</Label>
                    <select className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" value={plan} onChange={(e) => setPlan(e.target.value)}>
                      <option value="">— เลือก —</option>
                      {(plans.data?.plans ?? []).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                    </select>
                  </div>
                  <Button size="sm" onClick={() => changePlan.mutate()} disabled={!plan || changePlan.isPending}>เปลี่ยน</Button>
                </div>
                <div className="flex items-end gap-2">
                  <div className="grid w-24 gap-1">
                    <Label className="text-xs">ต่อ trial (วัน)</Label>
                    <Input value={days} onChange={(e) => setDays(e.target.value)} />
                  </div>
                  <Button size="sm" variant="outline" onClick={() => extendTrial.mutate()} disabled={extendTrial.isPending}>ต่อระยะทดลอง</Button>
                </div>
              </div>

              {/* Quick actions — jump into the company (act-as) for the full workspace or its user admin. */}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => { setActingTenant({ id: d.id, name: d.name, code: d.code }); window.location.assign('/dashboard'); }}>
                  <Eye className="size-3.5" /> เข้าดูบริษัทนี้
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setActingTenant({ id: d.id, name: d.name, code: d.code }); window.location.assign('/admin/users'); }}>
                  <Users className="size-3.5" /> จัดการผู้ใช้ (รีเซ็ตรหัส/เตะ session)
                </Button>
              </div>

              {/* Recent activity */}
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">กิจกรรมล่าสุด</div>
                <div className="space-y-1">
                  {(d.recent_activity ?? []).length === 0 && <div className="text-xs text-muted-foreground">ยังไม่มีกิจกรรม</div>}
                  {(d.recent_activity ?? []).map((a: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className={a.status === 'fail' ? 'text-destructive' : 'text-muted-foreground'}>{a.status === 'fail' ? '✕' : '✓'}</span>
                      <span className="w-28 shrink-0 text-muted-foreground">{a.ts ? thaiDate(a.ts) : ''}</span>
                      <span className="truncate">{a.actor ?? '—'} · {a.action ?? ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </StateView>
      </SheetContent>
    </Sheet>
  );
}

export default function PlatformConsole({
  initialCompanies,
  initialRequests,
}: {
  initialCompanies?: Company[];
  initialRequests?: SignupRequest[];
}) {
  const qc = useQueryClient();
  // Auto-refresh so the fleet view stays current without a manual reload — new signup requests, trials
  // slipping past due, etc. surface on their own (near-real-time; platform events aren't sub-second).
  const companies = useQuery<Company[]>({
    queryKey: ['admin-tenants'],
    queryFn: () => api<Company[]>('/api/admin/tenants'),
    initialData: initialCompanies,
    refetchInterval: 60_000,
  });
  const requests = useQuery<SignupRequest[]>({
    queryKey: ['signup-requests', 'pending'],
    queryFn: () => api<{ requests: SignupRequest[] }>('/api/admin/signup-requests?status=pending').then((r) => r.requests),
    initialData: initialRequests,
    refetchInterval: 45_000,
  });
  const invites = useQuery<any[]>({
    queryKey: ['signup-invites'],
    queryFn: () => api<{ invites: any[] }>('/api/admin/signup-invites').then((r) => r.invites),
  });
  const metrics = useQuery<any>({
    queryKey: ['saas-metrics'],
    queryFn: () => api('/api/billing/saas-metrics'),
  });
  const comps = companies.data ?? [];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-tenants'] });
    qc.invalidateQueries({ queryKey: ['signup-requests', 'pending'] });
    qc.invalidateQueries({ queryKey: ['signup-invites'] });
  };

  const [detailId, setDetailId] = useState<number | null>(null);

  // Live alert — when the auto-refresh brings in more pending requests than last time, toast the god so a
  // new company waiting for approval doesn't sit unseen. Seeded on first load so it never fires spuriously.
  const prevPending = useRef<number | null>(null);
  useEffect(() => {
    const n = requests.data?.length ?? 0;
    if (prevPending.current != null && n > prevPending.current) {
      notifyInfo(`มีคำขอเปิดบริษัทใหม่ ${n - prevPending.current} รายการ — ดูที่แท็บ Onboarding`);
    }
    prevPending.current = n;
  }, [requests.data]);

  // Cross-company activity feed (audit_log; god RLS bypass returns every tenant's rows). Company + status
  // filter server-side (so a company filter spans all pages); the free-text box filters the fetched page.
  const [auditCompany, setAuditCompany] = useState('');
  const [auditStatus, setAuditStatus] = useState('');
  const [auditText, setAuditText] = useState('');
  const auditQs = `limit=100${auditCompany ? `&tenant_id=${auditCompany}` : ''}${auditStatus ? `&status=${auditStatus}` : ''}`;
  const audit = useQuery<{ rows: any[]; total: number }>({
    queryKey: ['platform-audit', auditCompany, auditStatus],
    queryFn: () => api(`/api/admin/audit?${auditQs}`),
  });
  const companyName = (tid: any) => {
    const c = comps.find((x) => Number(x.id) === Number(tid));
    return c ? c.name : (tid == null ? '— (ระบบ)' : `#${tid}`);
  };
  const verifyChain = useMutation({
    mutationFn: () => api<{ ok: boolean; broken_at?: any }>('/api/admin/audit/verify'),
    onSuccess: (r) => r.ok ? notifySuccess('ห่วงโซ่ audit ครบถ้วน (ไม่พบการแก้ไข)') : notifyError(`พบความผิดปกติของห่วงโซ่ audit${r.broken_at ? ` ที่ #${r.broken_at}` : ''}`),
    onError: (e: any) => notifyError(e.message),
  });

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
      <button type="button" className="grid text-left leading-tight hover:underline" onClick={() => setDetailId(c.id)}>
        <span className="font-medium">{c.name}</span>
        <span className="text-xs text-muted-foreground">{c.code}</span>
      </button>
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
  const auditRows = (audit.data?.rows ?? []).filter((r: any) => {
    if (!auditText.trim()) return true;
    const q = auditText.toLowerCase();
    return `${r.actor ?? ''} ${r.action ?? ''}`.toLowerCase().includes(q);
  });
  const selectCls = 'h-9 rounded-md border border-input bg-transparent px-2 text-sm';

  const activityTab = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <Label className="text-xs">บริษัท</Label>
          <select className={selectCls} value={auditCompany} onChange={(e) => setAuditCompany(e.target.value)}>
            <option value="">ทุกบริษัท</option>
            {comps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">ผล</Label>
          <select className={selectCls} value={auditStatus} onChange={(e) => setAuditStatus(e.target.value)}>
            <option value="">ทั้งหมด</option>
            <option value="success">สำเร็จ</option>
            <option value="fail">ล้มเหลว</option>
          </select>
        </div>
        <div className="grid flex-1 gap-1">
          <Label className="text-xs">ค้นหา (ผู้ทำ/การกระทำ)</Label>
          <Input value={auditText} onChange={(e) => setAuditText(e.target.value)} placeholder="เช่น POST /api/ledger…" />
        </div>
        <Button size="sm" variant="outline" onClick={() => verifyChain.mutate()} disabled={verifyChain.isPending}>
          <ShieldCheck className="size-3.5" /> ตรวจ hash-chain
        </Button>
        <Button size="sm" variant="outline" onClick={() => apiDownload(`/api/admin/audit/export?${auditQs.replace('limit=100', '')}`, 'audit-log.csv')}>
          <Download className="size-3.5" /> ส่งออก CSV
        </Button>
      </div>
      <StateView q={audit}>
        <DataTable
          rows={auditRows}
          columns={[
            { key: 'ts', label: 'เวลา', render: (r: any) => (r.ts ? thaiDate(r.ts) : '—') },
            { key: 'tenant_id', label: 'บริษัท', render: (r: any) => companyName(r.tenant_id) },
            { key: 'actor', label: 'ผู้ทำ', render: (r: any) => r.actor ?? '—' },
            { key: 'action', label: 'การกระทำ', render: (r: any) => <span className="font-mono text-xs">{r.action ?? ''}</span> },
            { key: 'status', label: 'ผล', render: (r: any) => <Badge variant={r.status === 'fail' ? 'destructive' : 'secondary'}>{r.status === 'fail' ? 'ล้มเหลว' : 'สำเร็จ'}</Badge> },
          ]}
          rowKey={(r: any) => r.id}
          emptyText="ไม่มีกิจกรรมตามเงื่อนไข"
          pageSize={50}
        />
      </StateView>
      <p className="text-xs text-muted-foreground">แสดงล่าสุด {num(audit.data?.rows?.length ?? 0)} รายการ (จากทั้งหมด {num(audit.data?.total ?? 0)}) — กรองบริษัท/ผลเพื่อเจาะจง แล้วส่งออก CSV ได้ทั้งชุด</p>
    </div>
  );

  // Needs-attention — derived from the company list + request queue (no extra endpoint). "Trial ending soon"
  // = a Trialing company whose trial_ends_at is within the next 7 days.
  const now = Date.now();
  const suspendedN = comps.filter((c) => c.suspended).length;
  const pastDueN = comps.filter((c) => c.status === 'PastDue').length;
  const trialSoonN = comps.filter((c) => {
    if (c.status !== 'Trialing' || !c.trial_ends_at) return false;
    const dt = new Date(c.trial_ends_at).getTime() - now;
    return dt > 0 && dt < 7 * 864e5;
  }).length;

  const overviewTab = (
    <StateView q={metrics}>
      {metrics.data && (
        <div className="space-y-6">
          {/* Revenue + engagement KPIs (cross-company; god RLS bypass spans the whole book). */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="MRR (รายเดือน)" value={baht(metrics.data.revenue.mrr)} icon={CircleDollarSign} tone="primary" hint={`ARR ${baht(metrics.data.revenue.arr)} · ARPU ${baht(metrics.data.revenue.arpu)}`} />
            <StatCard label="บริษัทที่จ่ายเงิน" value={num(metrics.data.subscriptions.active)} icon={Building2} tone="success" hint={`ทดลอง ${num(metrics.data.subscriptions.trialing)} · ค้างชำระ ${num(metrics.data.subscriptions.past_due)}`} />
            <StatCard label="ผู้ใช้ active (30 วัน)" value={num(metrics.data.engagement.mau)} icon={Users} tone="info" hint={`วันนี้ ${num(metrics.data.engagement.dau)} · stickiness ${metrics.data.engagement.stickiness_pct}%`} />
            <StatCard label="Churn (30 วัน)" value={`${metrics.data.churn.churn_rate_30d_pct}%`} icon={TrendingUp} tone={metrics.data.churn.churn_rate_30d_pct > 5 ? 'danger' : 'default'} hint={`ยกเลิก ${num(metrics.data.churn.canceled_30d)} ราย`} />
          </div>

          {/* Needs-attention — what a god should act on. Open the Onboarding tab for the request queue. */}
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium"><AlertTriangle className="size-4 text-warning-foreground dark:text-warning" /> ต้องดูแล</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="คำขอรออนุมัติ" value={num(pending)} icon={UserPlus} tone={pending ? 'warning' : 'default'} hint="ดูที่แท็บ Onboarding" />
              <StatCard label="ทดลองใกล้หมด (7 วัน)" value={num(trialSoonN)} icon={Clock} tone={trialSoonN ? 'warning' : 'default'} />
              <StatCard label="ค้างชำระ" value={num(pastDueN)} icon={CircleDollarSign} tone={pastDueN ? 'danger' : 'default'} />
              <StatCard label="ถูกระงับ" value={num(suspendedN)} icon={PauseCircle} tone={suspendedN ? 'danger' : 'default'} />
            </div>
          </div>

          {/* Plan mix — active subscriptions + MRR contribution per plan. */}
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium"><Activity className="size-4 text-primary" /> สัดส่วนตามแพ็กเกจ</h3>
            <Card className="p-0">
              <DataTable
                rows={metrics.data.by_plan ?? []}
                columns={[
                  { key: 'name', label: 'แพ็กเกจ', render: (p: any) => <span className="font-medium">{p.name}</span> },
                  { key: 'price_monthly', label: 'ราคา/เดือน', align: 'right', render: (p: any) => baht(p.price_monthly) },
                  { key: 'active_subscriptions', label: 'ใช้งาน', align: 'right', render: (p: any) => num(p.active_subscriptions) },
                  { key: 'trialing', label: 'ทดลอง', align: 'right', render: (p: any) => num(p.trialing) },
                  { key: 'mrr', label: 'MRR', align: 'right', render: (p: any) => baht(p.mrr) },
                ]}
                rowKey={(p: any) => p.plan}
                emptyText="ยังไม่มีแพ็กเกจ"
              />
            </Card>
          </div>
        </div>
      )}
    </StateView>
  );

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
          { key: 'overview', label: 'ภาพรวม', content: overviewTab },
          { key: 'companies', label: `บริษัท (${companies.data?.length ?? 0})`, content: companiesTab },
          { key: 'onboarding', label: pending ? `Onboarding (${pending})` : 'Onboarding', content: onboardingTab },
          { key: 'activity', label: 'กิจกรรม', content: activityTab },
        ]}
      />
      <CompanyDrawer id={detailId} onClose={() => setDetailId(null)} onChanged={refresh} />
    </div>
  );
}
