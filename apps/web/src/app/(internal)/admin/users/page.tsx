'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Info, SearchX, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { ROLE_META, ROLES as ALL_ROLES, type Role } from '@/lib/roles';
import { api, apiDownload } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { useMe } from '@/lib/auth';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { SearchInput } from '@/components/search-input';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';

const selectCls = 'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';
// Grouped display order for the role guide (mirrors the ROLE_META `kind` taxonomy).
const ROLE_KIND_ORDER: { kind: RoleMetaKind; th: string; en: string }[] = [
  { kind: 'admin', th: 'ผู้ดูแล', en: 'Administration' },
  { kind: 'duty', th: 'บทบาทแยกหน้าที่ (SoD-clean)', en: 'Single-duty roles (SoD-clean)' },
  { kind: 'broad', th: 'บทบาทรวม (ระยะเปลี่ยนผ่าน)', en: 'Broad roles (transition)' },
  { kind: 'portal', th: 'พอร์ทัลลูกค้า', en: 'Customer portal' },
];
type RoleMetaKind = (typeof ROLE_META)[Role]['kind'];

export default function AdminUsersPage() {
  const { t, lang } = useLang();
  const qc = useQueryClient();
  const me = useMe();
  // Only the platform owner ("god") may grant the Admin role (ITGC-AC-02) — hide it from the pickers for
  // everyone else; the API enforces the same rule (ADMIN_GRANT_DENIED).
  const isGod = me.data?.is_platform_owner ?? false;
  const roleLabel = (r: string) => (ROLE_META[r as Role] ? (lang === 'th' ? ROLE_META[r as Role].labelTh : ROLE_META[r as Role].label) : r);
  const roleDesc = (r: string) => (ROLE_META[r as Role] ? (lang === 'th' ? ROLE_META[r as Role].descriptionTh : ROLE_META[r as Role].description) : '');
  // Selectable roles: everyone except 'Admin', which only a god may assign.
  const selectableRoles = useMemo(() => ALL_ROLES.filter((r) => r !== 'Admin' || isGod), [isGod]);
  const list = useQuery<any>({ queryKey: ['admin-users'], queryFn: () => api('/api/admin/users') });
  const [f, setF] = useState({ username: '', password: '', role: 'Sales', customer_name: '' });

  const create = useMutation({
    mutationFn: () => api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: f.username, password: f.password, role: f.role, customer_name: f.customer_name || undefined }) }),
    onSuccess: () => { notifySuccess(t('st.usr.user_created', { username: f.username })); setF({ username: '', password: '', role: 'Sales', customer_name: '' }); qc.invalidateQueries({ queryKey: ['admin-users'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const setRole = useMutation({
    mutationFn: (v: { u: string; role: string }) => api(`/api/admin/users/${v.u}`, { method: 'PATCH', body: JSON.stringify({ role: v.role }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
  const reset = useMutation({
    mutationFn: (u: string) => { const pw = prompt(t('st.usr.reset_prompt', { u })); return pw ? api(`/api/admin/users/${u}/reset-password`, { method: 'POST', body: JSON.stringify({ password: pw }) }) : Promise.resolve(null); },
    onSuccess: (r) => { if (r) notifySuccess(t('st.usr.password_reset')); },
    onError: (e: any) => notifyError(e.message),
  });
  // ITGC-AC-17: set a staff member's POS quick-login PIN (front-of-house roles only — the API rejects
  // privileged accounts). Cancelling the prompt is a no-op.
  const setPin = useMutation({
    mutationFn: (u: string) => { const pin = prompt(t('st.usr.pin_prompt', { u })); if (pin == null) return Promise.resolve(null); if (!/^\d{4,6}$/.test(pin)) { notifyError(t('st.usr.pin_invalid')); return Promise.resolve(null); } return api(`/api/auth/users/${u}/pin`, { method: 'POST', body: JSON.stringify({ pin }) }); },
    onSuccess: (r) => { if (r) notifySuccess(t('st.usr.pin_set')); },
    onError: (e: any) => notifyError(e.message),
  });
  const del = useMutation({
    mutationFn: (u: string) => api(`/api/admin/users/${u}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: (e: any) => notifyError(e.message),
  });

  // ── ITGC-AC-08: User Access Review ──
  const certs = useQuery<any>({ queryKey: ['uar-certs'], queryFn: () => api('/api/admin/users/access-review/certifications') });
  const lastCert = certs.data?.reviews?.[0];
  const certify = useMutation({
    mutationFn: () => { const period = prompt(t('st.usr.review_period_prompt')); if (!period) return Promise.resolve(null); const notes = prompt(t('st.usr.notes_prompt')) ?? undefined; return api('/api/admin/users/access-review/certify', { method: 'POST', body: JSON.stringify({ period, notes }) }); },
    onSuccess: (r: any) => { if (r) { notifySuccess(t('st.usr.cert_done', { period: r.period, count: r.user_count })); qc.invalidateQueries({ queryKey: ['uar-certs'] }); } },
    onError: (e: any) => notifyError(e.message),
  });

  // ── ITGC-AC-09 (audit G11): two-person SoD-exception queue ──
  // A SoD-conflicting grant is staged PendingApproval; a DIFFERENT admin (≠ requester, ≠ affected user)
  // approves it here. The API enforces the distinct-approver rule (self-approval → SOD_VIOLATION).
  const exceptions = useQuery<any>({ queryKey: ['sod-exceptions'], queryFn: () => api('/api/admin/users/access-exceptions?status=PendingApproval') });
  const pendingExc: any[] = exceptions.data?.exceptions ?? [];
  const approveExc = useMutation({
    mutationFn: (reqNo: string) => api(`/api/admin/users/access-exceptions/${reqNo}/approve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(lang === 'th' ? 'อนุมัติคำขอข้ามสิทธิ์แล้ว' : 'Access exception approved'); qc.invalidateQueries({ queryKey: ['sod-exceptions'] }); qc.invalidateQueries({ queryKey: ['admin-users'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const rejectExc = useMutation({
    mutationFn: (reqNo: string) => { const reason = prompt(lang === 'th' ? 'เหตุผลที่ปฏิเสธ (ไม่บังคับ)' : 'Reject reason (optional)') ?? undefined; return api(`/api/admin/users/access-exceptions/${reqNo}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); },
    onSuccess: () => { notifySuccess(lang === 'th' ? 'ปฏิเสธคำขอแล้ว' : 'Access exception rejected'); qc.invalidateQueries({ queryKey: ['sod-exceptions'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const [search, setSearch] = useState('');
  const users: any[] = list.data?.users ?? [];
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return users;
    return users.filter((u) => [u.username, u.role, u.customer_name].some((v) => String(v ?? '').toLowerCase().includes(term)));
  }, [users, search]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('st.usr.title')} description={t('st.usr.subtitle')} />
      <Card className="gap-3 p-5">
        <h3 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck className="size-4" /> {t('st.usr.access_review')}</h3>
        <p className="text-sm text-muted-foreground">{t('st.usr.access_review_desc')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => apiDownload('/api/admin/users/access-review/export', 'access-review.csv').catch((e) => notifyError(e.message))}><Download className="size-4" /> {t('st.usr.export_csv')}</Button>
          <Button size="sm" disabled={certify.isPending} onClick={() => certify.mutate()}><ShieldCheck className="size-4" /> {t('st.usr.certify')}</Button>
          {lastCert && <span className="text-sm text-muted-foreground">{t('st.usr.last_cert', { period: lastCert.period, by: lastCert.reviewed_by, count: lastCert.user_count, conflicts: lastCert.conflict_user_count })}</span>}
        </div>
      </Card>
      {/* ITGC-AC-09 (audit G11): pending SoD-exception approvals — a conflicting grant needs a second admin. */}
      {pendingExc.length > 0 && (
        <Card className="gap-3 border-amber-300 p-5 dark:border-amber-700">
          <h3 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck className="size-4" /> {lang === 'th' ? 'คำขอข้ามการแบ่งแยกหน้าที่ (SoD) รออนุมัติ' : 'Pending SoD-exception approvals'}</h3>
          <p className="text-sm text-muted-foreground">{lang === 'th' ? 'การให้สิทธิ์ที่ขัดกับการแบ่งแยกหน้าที่ต้องให้ผู้ดูแลอีกคน (ไม่ใช่ผู้ขอ และไม่ใช่เจ้าของบัญชี) อนุมัติก่อนจึงมีผล' : 'A grant that conflicts with Segregation of Duties must be approved by a different admin (not the requester, not the affected user) before it takes effect.'}</p>
          <div className="space-y-2">
            {pendingExc.map((e: any) => (
              <div key={e.req_no} className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-2.5 text-sm">
                <span className="font-medium">{e.target_username}</span>
                <Badge variant="secondary">{e.role ?? '—'}</Badge>
                {(e.sod_rules ?? []).map((r: string) => <Badge key={r} variant="warning">{r}</Badge>)}
                <span className="text-muted-foreground">· {e.reason}</span>
                <span className="text-xs text-muted-foreground">({lang === 'th' ? 'ขอโดย' : 'by'} {e.requested_by})</span>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" disabled={approveExc.isPending} onClick={() => approveExc.mutate(e.req_no)}>{lang === 'th' ? 'อนุมัติ' : 'Approve'}</Button>
                  <Button size="sm" variant="outline" disabled={rejectExc.isPending} onClick={() => rejectExc.mutate(e.req_no)}>{lang === 'th' ? 'ปฏิเสธ' : 'Reject'}</Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      {/* Role guide — plain-language definition of every role so an admin understands what access each grants. */}
      <Card className="gap-3 p-5">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-base font-semibold">
            <Info className="size-4" /> {lang === 'th' ? 'คู่มือบทบาท — ความหมายของแต่ละบทบาท' : 'Role guide — what each role means'}
            <span className="ml-auto text-xs font-normal text-muted-foreground group-open:hidden">{lang === 'th' ? 'แสดง' : 'show'}</span>
            <span className="ml-auto hidden text-xs font-normal text-muted-foreground group-open:inline">{lang === 'th' ? 'ซ่อน' : 'hide'}</span>
          </summary>
          <div className="mt-3 space-y-4">
            {ROLE_KIND_ORDER.map((grp) => {
              const roles = ALL_ROLES.filter((r) => ROLE_META[r].kind === grp.kind);
              if (!roles.length) return null;
              return (
                <div key={grp.kind}>
                  <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{lang === 'th' ? grp.th : grp.en}</p>
                  <dl className="grid gap-2 sm:grid-cols-2">
                    {roles.map((r) => (
                      <div key={r} className="rounded-md border border-border/60 p-2.5">
                        <dt className="flex items-center gap-1.5 text-sm font-medium">
                          {roleLabel(r)}
                          <code className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{r}</code>
                        </dt>
                        <dd className="mt-0.5 text-xs text-muted-foreground">{roleDesc(r)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              );
            })}
          </div>
        </details>
      </Card>
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('st.usr.create_account')}</h3>
        <div className="grid gap-2 sm:grid-cols-4">
          <div className="grid gap-1.5"><Label>Username</Label><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>Password</Label><PasswordInput value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>Role</Label><select className={selectCls} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{selectableRoles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}</select></div>
          <div className="grid gap-1.5"><Label>{t('st.usr.company_optional')}</Label><Input value={f.customer_name} onChange={(e) => setF({ ...f, customer_name: e.target.value })} placeholder="tenant code" /></div>
        </div>
        {roleDesc(f.role) && <p className="text-xs text-muted-foreground">{roleDesc(f.role)}</p>}
        <Button className="w-fit" disabled={!f.username || f.password.length < 6 || create.isPending} onClick={() => create.mutate()}><UserPlus className="size-4" /> {t('st.usr.create_user')}</Button>
      </Card>
      <StateView q={list}>
        {list.data && (
          <div className="space-y-3">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t('st.usr.search_ph')}
              ariaLabel={t('st.usr.search_aria')}
              count={search && filtered.length !== users.length ? t('st.usr.count_filtered', { n: filtered.length, total: users.length }) : t('st.usr.count', { n: filtered.length })}
            />
          <DataTable
            rows={filtered}
            rowKey={(r: any) => r.username}
            emptyState={
              search
                ? {
                    icon: SearchX,
                    title: t('st.usr.no_match_title'),
                    description: t('st.usr.no_match_desc'),
                    action: (
                      <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                        {t('inv.clear_filter')}
                      </Button>
                    ),
                  }
                : { icon: Users, title: t('st.usr.empty_title'), description: t('st.usr.empty_desc') }
            }
            columns={[
              { key: 'username', label: 'Username' },
              { key: 'role', label: 'Role', render: (r: any) => {
                // Always include the row's CURRENT role so an existing Admin still shows correctly, even
                // though a non-god cannot switch a user TO Admin (that option is hidden + API-enforced).
                const opts = selectableRoles.includes(r.role) ? selectableRoles : [r.role, ...selectableRoles];
                return <select className={selectCls} value={r.role} onChange={(e) => setRole.mutate({ u: r.username, role: e.target.value })} title={roleDesc(r.role)}>{opts.map((x) => <option key={x} value={x}>{roleLabel(x)}</option>)}</select>;
              } },
              { key: 'customer_name', label: t('st.usr.company'), render: (r: any) => r.customer_name ?? '—' },
              { key: 'must_change_password', label: t('st.usr.must_change'), render: (r: any) => r.must_change_password ? <Badge variant="warning">{t('st.usr.yes')}</Badge> : '—' },
              { key: 'reset', label: '', render: (r: any) => <Button size="sm" variant="outline" disabled={reset.isPending} onClick={() => reset.mutate(r.username)}>{t('st.usr.reset_pw')}</Button> },
              { key: 'pin', label: '', render: (r: any) => <Button size="sm" variant="outline" disabled={setPin.isPending} onClick={() => setPin.mutate(r.username)}>{t('st.usr.set_pin')}</Button> },
              { key: 'del', label: '', render: (r: any) => <Button size="sm" variant="destructive" disabled={del.isPending} onClick={() => del.mutate(r.username)}>{t('st.usr.delete')}</Button> },
            ]}
          />
          </div>
        )}
      </StateView>
    </div>
  );
}
