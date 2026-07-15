'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, ArrowUpCircle, BadgeCheck, Bell, Building2, CheckCheck, CircleDollarSign, Clock, Database, Download, Eye, PauseCircle, Pause, Play, Plus, Server, ShieldCheck, Sparkles, Ticket, Trash2, TrendingUp, UserPlus, Users } from 'lucide-react';

import { api, apiDownload, setActingTenant } from '@/lib/api';
import { INTERNAL_NAV } from '@/lib/nav';
import { baht, num, thaiDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useLang } from '@/lib/i18n';
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
import { Select } from '@/components/form-controls';

interface Company {
  id: number;
  code: string;
  name: string;
  suspended: boolean;
  deleted?: boolean;
  deleted_by?: string | null;
  purged?: boolean;
  status: string | null;
  plan_code: string | null;
  trial_ends_at: string | null;
  users: number;
  created_at: string | null;
  setup_complete?: boolean;
  tags?: string[];
  control_profile?: 'enterprise' | 'sme'; // docs/49 — SME single-user edition
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

function statusBadge(s: string | null, t: (key: string, vars?: Record<string, string | number>) => string) {
  const variant =
    s === 'Active' ? 'default'
    : s === 'Trialing' ? 'secondary'
    : s === 'Suspended' ? 'destructive'
    : s === 'Deleted' ? 'destructive'
    : s === 'Purged' ? 'destructive'
    : s === 'PastDue' ? 'destructive'
    : 'outline';
  const label =
    s === 'Active' ? t('plt.status_active')
    : s === 'Trialing' ? t('plt.status_trialing')
    : s === 'Suspended' ? t('plt.status_suspended')
    : s === 'Deleted' ? t('plt.status_deleted')
    : s === 'Purged' ? t('plt.status_purged')
    : s === 'PastDue' ? t('plt.status_past_due')
    : s === 'Canceled' ? t('plt.status_canceled')
    : (s ?? '—');
  return <Badge variant={variant as 'default' | 'secondary' | 'destructive' | 'outline'}>{label}</Badge>;
}

// Slide-over with the full picture of one company (drill-down without fully switching into it) + the
// platform subscription controls (change plan / extend trial). Lives in this already-'use client' island.
function CompanyDrawer({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }) {
  const { t } = useLang();
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
  const [tagsInput, setTagsInput] = useState('');
  const [resetConfirm, setResetConfirm] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [purgeConfirm, setPurgeConfirm] = useState('');
  useEffect(() => { setTagsInput((detail.data?.tags ?? []).join(', ')); }, [detail.data]);
  useEffect(() => { setResetConfirm(''); setDeleteConfirm(''); setPurgeConfirm(''); }, [id]);

  const saveTags = useMutation({
    mutationFn: () => api(`/api/admin/tenants/${id}/tags`, { method: 'POST', body: JSON.stringify({ tags: tagsInput.split(',').map((s) => s.trim()).filter(Boolean) }) }),
    onSuccess: () => { notifySuccess(t('plt.drawer_tags_saved')); detail.refetch(); onChanged(); },
    onError: (e: any) => notifyError(e.message),
  });

  const changePlan = useMutation({
    mutationFn: () => api(`/api/admin/tenants/${id}/plan`, { method: 'POST', body: JSON.stringify({ plan_code: plan }) }),
    onSuccess: () => { notifySuccess(t('plt.drawer_plan_changed')); detail.refetch(); onChanged(); },
    onError: (e: any) => notifyError(e.message),
  });
  const extendTrial = useMutation({
    mutationFn: () => api(`/api/admin/tenants/${id}/extend-trial`, { method: 'POST', body: JSON.stringify({ days: Number(days) || 14 }) }),
    onSuccess: () => { notifySuccess(t('plt.drawer_trial_extended')); detail.refetch(); onChanged(); },
    onError: (e: any) => notifyError(e.message),
  });
  // Factory reset — the danger-zone section renders only for a SUSPENDED company (mirrors the server's
  // TENANT_NOT_SUSPENDED gate: suspend → reset → reactivate, so an active company is unwipeable); the
  // button stays disabled until the typed company code matches exactly (server: CONFIRM_MISMATCH).
  const factoryReset = useMutation({
    mutationFn: () => api(`/api/admin/tenants/${id}/factory-reset`, { method: 'POST', body: JSON.stringify({ confirm: resetConfirm.trim() }) }),
    onSuccess: (r: any) => { notifySuccess(t('plt.company_reset_done', { name: detail.data?.name ?? String(id), rows: num(r?.rows_deleted ?? 0) })); setResetConfirm(''); detail.refetch(); onChanged(); },
    onError: (e: any) => notifyError(e.message),
  });
  // Soft-delete — hides the company + permanently blocks its logins WITHOUT touching business data
  // (unlike factory reset above). Same suspended-first gate; reversible via restoreTenant.
  const deleteTenant = useMutation({
    mutationFn: () => api(`/api/admin/tenants/${id}/delete`, { method: 'POST', body: JSON.stringify({ confirm: deleteConfirm.trim() }) }),
    onSuccess: () => { notifySuccess(t('plt.company_deleted', { name: detail.data?.name ?? String(id) })); setDeleteConfirm(''); detail.refetch(); onChanged(); },
    onError: (e: any) => notifyError(e.message),
  });
  const restoreTenant = useMutation({
    mutationFn: () => api(`/api/admin/tenants/${id}/restore`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => { notifySuccess(t('plt.company_restored', { name: detail.data?.name ?? String(id) })); detail.refetch(); onChanged(); },
    onError: (e: any) => notifyError(e.message),
  });
  // Purge — IRREVERSIBLE, only offered on an already-soft-deleted company (delete → purge). Erases every
  // row referencing this tenant anywhere in the schema (incl. users/audit_log) plus the tenants row itself.
  const purgeTenant = useMutation({
    mutationFn: () => api(`/api/admin/tenants/${id}/purge`, { method: 'POST', body: JSON.stringify({ confirm: purgeConfirm.trim() }) }),
    onSuccess: () => { notifySuccess(t('plt.company_purged', { name: detail.data?.name ?? String(id) })); setPurgeConfirm(''); detail.refetch(); onChanged(); },
    onError: (e: any) => notifyError(e.message),
  });

  const d = detail.data;
  return (
    <Sheet open={id != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{d?.name ?? t('plt.drawer_title_fallback')}</SheetTitle>
          <SheetDescription>{d ? `${d.code}${d.legal_name ? ` · ${d.legal_name}` : ''}` : t('plt.drawer_loading')}</SheetDescription>
        </SheetHeader>
        <StateView q={detail}>
          {d && (
            <div className="space-y-5 px-4 pb-6 text-sm">
              {/* Snapshot */}
              <div className="grid grid-cols-2 gap-3">
                <div><div className="text-xs text-muted-foreground">{t('plt.drawer_status')}</div>{statusBadge(d.purged ? 'Purged' : d.deleted ? 'Deleted' : d.suspended ? 'Suspended' : d.subscription?.status ?? null, t)}</div>
                <div><div className="text-xs text-muted-foreground">{t('plt.drawer_plan')}</div>{d.subscription?.plan_code ?? '—'}</div>
                <div><div className="text-xs text-muted-foreground">{t('plt.drawer_users_branches')}</div>{d.counts.users} · {d.counts.branches}</div>
                <div><div className="text-xs text-muted-foreground">{t('plt.drawer_trial_until')}</div>{d.subscription?.trial_ends_at ? thaiDate(d.subscription.trial_ends_at) : '—'}</div>
                <div><div className="text-xs text-muted-foreground">{t('plt.drawer_tax_id')}</div>{d.tax_id ?? '—'}</div>
                <div><div className="text-xs text-muted-foreground">{t('plt.drawer_opened_at')}</div>{d.created_at ? thaiDate(d.created_at) : '—'}</div>
              </div>
              {d.suspended && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
                  {t('plt.drawer_suspended_note', {
                    by: d.suspended_by ? t('plt.drawer_suspended_by', { who: d.suspended_by }) : '',
                    reason: d.suspend_reason ? t('plt.drawer_suspended_reason', { reason: d.suspend_reason }) : '',
                  })}
                </div>
              )}
              {d.purged && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
                  {t('plt.drawer_purged_note')}
                </div>
              )}
              {d.deleted && !d.purged && (
                <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                    <AlertTriangle className="size-3.5" /> {t('plt.drawer_restore_title')}
                  </div>
                  <p className="text-xs text-muted-foreground">{t('plt.drawer_restore_desc')}</p>
                  <Button size="sm" variant="outline" onClick={() => restoreTenant.mutate()} disabled={restoreTenant.isPending}>
                    <Play className="size-3.5" /> {t('plt.drawer_restore_btn')}
                  </Button>
                  <div className="mt-1 border-t border-destructive/20 pt-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                      <AlertTriangle className="size-3.5" /> {t('plt.drawer_purge_title')}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{t('plt.drawer_purge_desc')}</p>
                    <div className="mt-2 flex items-end gap-2">
                      <div className="grid flex-1 gap-1">
                        <Label className="text-xs">{t('plt.drawer_purge_confirm_label', { code: d.code })}</Label>
                        <Input value={purgeConfirm} onChange={(e) => setPurgeConfirm(e.target.value)} placeholder={d.code} />
                      </div>
                      <Button size="sm" variant="destructive" onClick={() => purgeTenant.mutate()} disabled={purgeConfirm.trim() !== d.code || purgeTenant.isPending}>
                        <Trash2 className="size-3.5" /> {t('plt.drawer_purge_btn')}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* AI usage */}
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">{t('plt.drawer_ai_usage')}</div>
                <div className="text-sm">{t('plt.drawer_ai_usage_line', { input: num(d.ai_usage.input_tokens), output: num(d.ai_usage.output_tokens), overage: num(d.ai_usage.overage_tokens) })}</div>
              </div>

              {/* Subscription controls (platform-level, no impersonation) */}
              <div className="space-y-2 rounded-md border p-3">
                <div className="text-xs font-medium">{t('plt.drawer_subscription_mgmt')}</div>
                <div className="flex items-end gap-2">
                  <div className="grid flex-1 gap-1">
                    <Label className="text-xs">{t('plt.drawer_change_plan')}</Label>
                    <Select className="w-auto" value={plan} onChange={(e) => setPlan(e.target.value)}>
                      <option value="">{t('plt.drawer_choose')}</option>
                      {(plans.data?.plans ?? []).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                    </Select>
                  </div>
                  <Button size="sm" onClick={() => changePlan.mutate()} disabled={!plan || changePlan.isPending}>{t('plt.drawer_change_btn')}</Button>
                </div>
                <div className="flex items-end gap-2">
                  <div className="grid w-24 gap-1">
                    <Label className="text-xs">{t('plt.drawer_extend_trial_days')}</Label>
                    <Input value={days} onChange={(e) => setDays(e.target.value)} />
                  </div>
                  <Button size="sm" variant="outline" onClick={() => extendTrial.mutate()} disabled={extendTrial.isPending}>{t('plt.drawer_extend_trial_btn')}</Button>
                </div>
              </div>

              {/* Tags/segments */}
              <div className="space-y-1">
                <Label className="text-xs">{t('plt.drawer_tags_label')}</Label>
                <div className="flex items-end gap-2">
                  <Input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder={t('plt.drawer_tags_placeholder')} />
                  <Button size="sm" variant="outline" onClick={() => saveTags.mutate()} disabled={saveTags.isPending}>{t('plt.drawer_save')}</Button>
                </div>
              </div>

              {/* Quick actions — jump into the company (act-as) for the full workspace or its user admin. */}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => { setActingTenant({ id: d.id, name: d.name, code: d.code }); window.location.assign('/dashboard'); }}>
                  <Eye className="size-3.5" /> {t('plt.drawer_view_company')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setActingTenant({ id: d.id, name: d.name, code: d.code }); window.location.assign('/admin/users'); }}>
                  <Users className="size-3.5" /> {t('plt.drawer_manage_users')}
                </Button>
              </div>

              {/* Danger zone — factory reset + delete. Only offered on a suspended, non-deleted company
                  (two-step safety: suspend → reset/delete). */}
              {d.suspended && !d.deleted && (
                <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                    <AlertTriangle className="size-3.5" /> {t('plt.drawer_reset_title')}
                  </div>
                  <p className="text-xs text-muted-foreground">{t('plt.drawer_reset_desc')}</p>
                  <div className="flex items-end gap-2">
                    <div className="grid flex-1 gap-1">
                      <Label className="text-xs">{t('plt.drawer_reset_confirm_label', { code: d.code })}</Label>
                      <Input value={resetConfirm} onChange={(e) => setResetConfirm(e.target.value)} placeholder={d.code} />
                    </div>
                    <Button size="sm" variant="destructive" onClick={() => factoryReset.mutate()} disabled={resetConfirm.trim() !== d.code || factoryReset.isPending}>
                      <Trash2 className="size-3.5" /> {t('plt.drawer_reset_btn')}
                    </Button>
                  </div>
                  <div className="mt-1 border-t border-destructive/20 pt-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                      <AlertTriangle className="size-3.5" /> {t('plt.drawer_delete_title')}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{t('plt.drawer_delete_desc')}</p>
                    <div className="mt-2 flex items-end gap-2">
                      <div className="grid flex-1 gap-1">
                        <Label className="text-xs">{t('plt.drawer_delete_confirm_label', { code: d.code })}</Label>
                        <Input value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} placeholder={d.code} />
                      </div>
                      <Button size="sm" variant="destructive" onClick={() => deleteTenant.mutate()} disabled={deleteConfirm.trim() !== d.code || deleteTenant.isPending}>
                        <Trash2 className="size-3.5" /> {t('plt.drawer_delete_btn')}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Recent activity */}
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">{t('plt.drawer_recent_activity')}</div>
                <div className="space-y-1">
                  {(d.recent_activity ?? []).length === 0 && <div className="text-xs text-muted-foreground">{t('plt.drawer_no_activity')}</div>}
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
  const { t } = useLang();
  const qc = useQueryClient();
  // Show-deleted toggle (migration 0386 soft-delete) — off by default so the fleet list matches the
  // pre-delete behaviour; flipping it refetches with deleted companies included, for restoreTenant.
  const [showDeleted, setShowDeleted] = useState(false);
  // Auto-refresh so the fleet view stays current without a manual reload — new signup requests, trials
  // slipping past due, etc. surface on their own (near-real-time; platform events aren't sub-second).
  const companies = useQuery<Company[]>({
    queryKey: ['admin-tenants', showDeleted],
    queryFn: () => api<Company[]>(`/api/admin/tenants${showDeleted ? '?include_deleted=1' : ''}`),
    initialData: showDeleted ? undefined : initialCompanies,
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
  const aiUsage = useQuery<any[]>({
    queryKey: ['admin-ai-usage'],
    queryFn: () => api<any[]>('/api/admin/ai-usage'),
  });
  const ops = useQuery<any>({ queryKey: ['ops-metrics'], queryFn: () => api('/api/ops/metrics') });
  const jobs = useQuery<any>({ queryKey: ['jobs-ops-metrics'], queryFn: () => api('/api/jobs/ops-metrics') });
  // Platform notification inbox — the durable god event feed (signup requests, company lifecycle) with read state.
  const notifs = useQuery<{ items: any[]; unread_count: number; total: number }>({
    queryKey: ['platform-notifs'],
    queryFn: () => api('/api/admin/notifications?limit=50'),
    refetchInterval: 45_000,
  });
  const markNotif = useMutation({
    mutationFn: (id: number) => api(`/api/admin/notifications/${id}/read`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => notifs.refetch(),
  });
  const markAllNotif = useMutation({
    mutationFn: () => api('/api/admin/notifications/mark-all-read', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => { notifs.refetch(); notifySuccess(t('plt.notif_mark_all_done')); },
  });

  // Global item-master garbage collection (§ PN-17 step 14). `items` is a SHARED master (no tenant_id), so a
  // company's factory-reset/purge leaves its catalogue rows behind and they keep showing in every tenant's
  // /shop. Preview counts the items no tenant references any more (cross-tenant, under the @PlatformAdmin
  // bypass); purge deletes exactly those. Manual (not an auto-query) — the scan is a heavy cross-tenant sweep.
  type KeptBy = { tenant_id: number | null; code: string | null; name: string | null; items: number };
  type UnusedPreview = { total: number; item_ids: string[]; sampled: boolean; ref_columns: number; kept_by: KeptBy[] };
  const [unusedPreview, setUnusedPreview] = useState<UnusedPreview | null>(null);
  const checkUnused = useMutation({
    mutationFn: () => api<UnusedPreview>('/api/admin/item-maintenance/unused-items'),
    onSuccess: (r) => { setUnusedPreview(r); notifyInfo(t('plt.mnt_preview_done', { n: r.total })); },
    onError: (e: any) => notifyError(e.message),
  });
  const purgeUnused = useMutation({
    mutationFn: () => api<{ items_deleted: number; images_deleted: number }>('/api/admin/item-maintenance/purge-unused-items', { method: 'POST', body: JSON.stringify({ confirm: 'PURGE-UNUSED-ITEMS' }) }),
    onSuccess: (r) => { notifySuccess(t('plt.mnt_purge_done', { n: r.items_deleted })); setUnusedPreview(null); },
    onError: (e: any) => notifyError(e.message),
  });

  // FORCE purge (DANGER) — deletes products even if a company still uses them, wiping the references across
  // EVERY company. force-preview is the mandatory blast-radius report shown before the destructive call.
  type ForcePreview = { items: number; total_ref_rows: number; by_tenant: (KeptBy & { ref_rows: number })[] };
  const [forcePreview, setForcePreview] = useState<ForcePreview | null>(null);
  const checkForce = useMutation({
    mutationFn: () => api<ForcePreview>('/api/admin/item-maintenance/force-preview', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (r) => { setForcePreview(r); notifyInfo(t('plt.mnt_force_preview_done', { n: r.items, rows: r.total_ref_rows })); },
    onError: (e: any) => notifyError(e.message),
  });
  const forcePurge = useMutation({
    mutationFn: () => api<{ items_deleted: number; ref_rows_deleted: number }>('/api/admin/item-maintenance/force-purge', { method: 'POST', body: JSON.stringify({ confirm: 'FORCE-PURGE-ITEMS' }) }),
    onSuccess: (r) => { notifySuccess(t('plt.mnt_force_done', { n: r.items_deleted, rows: r.ref_rows_deleted })); setForcePreview(null); setUnusedPreview(null); },
    onError: (e: any) => notifyError(e.message),
  });

  const comps = companies.data ?? [];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-tenants'] });
    qc.invalidateQueries({ queryKey: ['signup-requests', 'pending'] });
    qc.invalidateQueries({ queryKey: ['signup-invites'] });
  };

  const [detailId, setDetailId] = useState<number | null>(null);

  // Bulk actions (item 7) — select companies in the table, then act on all at once (loops the per-company
  // endpoints; there's no batch endpoint, but a handful of parallel calls is fine at fleet size).
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const toggleSel = (id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSel = () => setSelected(new Set());
  const [bulkPlan, setBulkPlan] = useState('');
  const runBulk = async (fn: (c: Company) => Promise<unknown>, label: string) => {
    const targets = comps.filter((c) => selected.has(c.id));
    if (!targets.length) return;
    const res = await Promise.allSettled(targets.map(fn));
    const okN = res.filter((r) => r.status === 'fulfilled').length;
    const failN = res.length - okN;
    failN ? notifyError(t('plt.bulk_result', { label, ok: okN, fail: failN })) : notifySuccess(t('plt.bulk_success', { label, n: okN }));
    clearSel();
    refresh();
  };
  const bulkPlans = useQuery<{ plans: { code: string; name: string }[] }>({ queryKey: ['plans'], queryFn: () => api('/api/billing/plans') });

  // Tags/segments (item 8) — filter the company table by a tag chip.
  const [tagFilter, setTagFilter] = useState('');
  const allTags = Array.from(new Set(comps.flatMap((c) => c.tags ?? []))).sort();

  // Live alert — when the auto-refresh brings in more pending requests than last time, toast the god so a
  // new company waiting for approval doesn't sit unseen. Seeded on first load so it never fires spuriously.
  const prevPending = useRef<number | null>(null);
  useEffect(() => {
    const n = requests.data?.length ?? 0;
    if (prevPending.current != null && n > prevPending.current) {
      notifyInfo(t('plt.new_pending_toast', { n: n - prevPending.current }));
    }
    prevPending.current = n;
  }, [requests.data]);

  // Cross-company activity feed (audit_log; god RLS bypass returns every tenant's rows). Company + status
  // filter server-side (so a company filter spans all pages); the free-text box filters the fetched page.
  const [auditCompany, setAuditCompany] = useState('');
  const [auditStatus, setAuditStatus] = useState('');
  const [auditText, setAuditText] = useState('');
  const [auditGodOnly, setAuditGodOnly] = useState(false);
  const auditQs = `limit=100${auditCompany ? `&tenant_id=${auditCompany}` : ''}${auditStatus ? `&status=${auditStatus}` : ''}`;
  const audit = useQuery<{ rows: any[]; total: number }>({
    queryKey: ['platform-audit', auditCompany, auditStatus],
    queryFn: () => api(`/api/admin/audit?${auditQs}`),
  });
  const companyName = (tid: any) => {
    const c = comps.find((x) => Number(x.id) === Number(tid));
    return c ? c.name : (tid == null ? t('plt.act_system_actor') : `#${tid}`);
  };
  const verifyChain = useMutation({
    mutationFn: () => api<{ ok: boolean; broken_at?: any }>('/api/admin/audit/verify'),
    onSuccess: (r) => r.ok ? notifySuccess(t('plt.act_chain_ok')) : notifyError(t('plt.act_chain_broken', { at: r.broken_at ? t('plt.act_chain_broken_at', { id: r.broken_at }) : '' })),
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
    onSuccess: (_d, c) => { notifySuccess(c.suspended ? t('plt.company_reactivated', { name: c.name }) : t('plt.company_suspended', { name: c.name })); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const [prov, setProv] = useState({ company_name: '', tenant_code: '', admin_username: '', admin_password: '', email: '', industry: 'restaurant', control_profile: 'enterprise' });
  const [provOpen, setProvOpen] = useState(false);
  const provision = useMutation({
    mutationFn: () => api('/api/admin/tenants', { method: 'POST', body: JSON.stringify(prov) }),
    onSuccess: () => {
      notifySuccess(t('plt.prov_created', { name: prov.company_name }));
      setProv({ company_name: '', tenant_code: '', admin_username: '', admin_password: '', email: '', industry: 'restaurant', control_profile: 'enterprise' });
      setProvOpen(false);
      refresh();
    },
    onError: (e: any) => notifyError(e.message),
  });

  // docs/49 — upgrade-only edition transition (SME → Enterprise). Enterprise rows never show the button.
  const upgradeProfile = useMutation({
    mutationFn: (c: Company) => {
      if (!confirm(t('plt.sme_upgrade_confirm', { name: c.name }))) return Promise.resolve(null);
      return api(`/api/admin/tenants/${c.id}/control-profile`, { method: 'POST', body: JSON.stringify({ control_profile: 'enterprise' }) });
    },
    onSuccess: (d, c) => { if (d) { notifySuccess(t('plt.sme_upgraded', { name: c.name })); refresh(); } },
    onError: (e: any) => notifyError(e.message),
  });

  // docs/49 — platform-wide SME provisioning defaults (identical for every new SME at creation).
  const smeDefaults = useQuery<{ hidden_nav_groups: string[]; accountant_email: string | null; updated_by: string | null }>({
    queryKey: ['sme-defaults'],
    queryFn: () => api('/api/admin/sme-defaults'),
  });
  const [smeEmail, setSmeEmail] = useState('');
  const [smeHiddenGroups, setSmeHiddenGroups] = useState<string[]>([]);
  useEffect(() => {
    if (smeDefaults.data) {
      setSmeEmail(smeDefaults.data.accountant_email ?? '');
      setSmeHiddenGroups(smeDefaults.data.hidden_nav_groups ?? []);
    }
  }, [smeDefaults.data]);
  const saveSmeDefaults = useMutation({
    mutationFn: () => api('/api/admin/sme-defaults', { method: 'POST', body: JSON.stringify({ hidden_nav_groups: smeHiddenGroups, accountant_email: smeEmail.trim() || null }) }),
    onSuccess: () => { notifySuccess(t('plt.sme_def_saved')); smeDefaults.refetch(); },
    onError: (e: any) => notifyError(e.message),
  });

  const approve = useMutation({
    mutationFn: (r: SignupRequest) => api(`/api/admin/signup-requests/${r.id}/approve`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (_d, r) => { notifySuccess(t('plt.onb_approved', { name: r.company_name })); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (r: SignupRequest) => {
      const reason = prompt(t('plt.onb_reject_prompt', { name: r.company_name }));
      if (reason === null) return Promise.resolve(null);
      return api(`/api/admin/signup-requests/${r.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: reason || undefined }) });
    },
    onSuccess: (d, r) => { if (d) { notifySuccess(t('plt.onb_rejected', { name: r.company_name })); refresh(); } },
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
    onSuccess: (d) => { setLastInvite(d); setInv({ company_name: '', email: '', ttl_hours: '72' }); notifySuccess(t('plt.inv_issued')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const companyCols: Column<Company>[] = [
    { key: 'sel', label: '', render: (c) => (
      <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSel(c.id)} onClick={(e) => e.stopPropagation()} aria-label={t('plt.select_company_aria', { name: c.name })} />
    ) },
    { key: 'name', label: t('plt.col_company'), sortable: true, render: (c) => (
      <div className="grid gap-0.5">
        <button type="button" className="grid text-left leading-tight hover:underline" onClick={() => setDetailId(c.id)}>
          <span className="font-medium">{c.name}</span>
          <span className="text-xs text-muted-foreground">{c.code}</span>
        </button>
        {(c.tags ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {(c.tags ?? []).map((tg) => <Badge key={tg} variant="outline" className="px-1 py-0 text-[10px]">{tg}</Badge>)}
          </div>
        )}
      </div>
    ) },
    { key: 'status', label: t('plt.col_status'), render: (c) => statusBadge(c.purged ? 'Purged' : c.deleted ? 'Deleted' : c.status, t) },
    { key: 'control_profile', label: t('plt.col_edition'), render: (c) => (
      c.control_profile === 'sme'
        ? <Badge variant="secondary" className="bg-sky-500/15 text-sky-700 dark:text-sky-300">SME</Badge>
        : <Badge variant="outline">Enterprise</Badge>
    ) },
    { key: 'plan_code', label: t('plt.col_plan'), render: (c) => c.plan_code ?? '—' },
    { key: 'users', label: t('plt.col_users'), align: 'right', sortable: true, render: (c) => c.users },
    { key: 'trial_ends_at', label: t('plt.col_trial_until'), render: (c) => (c.trial_ends_at ? thaiDate(c.trial_ends_at) : '—') },
    { key: 'created_at', label: t('plt.col_opened_at'), sortable: true, render: (c) => (c.created_at ? thaiDate(c.created_at) : '—') },
    { key: 'actions', label: '', align: 'right', render: (c) => (
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="outline" onClick={() => view(c)} disabled={c.deleted}><Eye className="size-3.5" /> {t('plt.action_view')}</Button>
        <Button size="sm" variant={c.suspended ? 'outline' : 'ghost'} onClick={() => suspend.mutate(c)} disabled={suspend.isPending || c.deleted}>
          {c.suspended ? <><Play className="size-3.5" /> {t('plt.action_reactivate')}</> : <><Pause className="size-3.5" /> {t('plt.action_suspend')}</>}
        </Button>
        {c.control_profile === 'sme' && !c.deleted && (
          <Button size="sm" variant="outline" onClick={() => upgradeProfile.mutate(c)} disabled={upgradeProfile.isPending} title={t('plt.sme_upgrade_title')}>
            <ArrowUpCircle className="size-3.5" /> {t('plt.sme_upgrade_btn')}
          </Button>
        )}
        {c.deleted && (
          <Button size="sm" variant="outline" onClick={() => setDetailId(c.id)}>{t('plt.drawer_restore_btn')}</Button>
        )}
      </div>
    ) },
  ];

  const requestCols: Column<SignupRequest>[] = [
    { key: 'company_name', label: t('plt.col_company'), render: (r) => (
      <div className="grid leading-tight">
        <span className="font-medium">{r.company_name}</span>
        <span className="text-xs text-muted-foreground">{r.tenant_code} · {r.admin_username}{r.email ? ` · ${r.email}` : ''}</span>
      </div>
    ) },
    { key: 'requested_at', label: t('plt.onb_requested_at'), render: (r) => (r.requested_at ? thaiDate(r.requested_at) : '—') },
    { key: 'actions', label: '', align: 'right', render: (r) => (
      <div className="flex justify-end gap-1">
        <Button size="sm" onClick={() => approve.mutate(r)} disabled={approve.isPending}>{t('plt.onb_approve')}</Button>
        <Button size="sm" variant="ghost" onClick={() => reject.mutate(r)} disabled={reject.isPending}>{t('plt.onb_reject')}</Button>
      </div>
    ) },
  ];

  const provisionDialog = (
    <Dialog open={provOpen} onOpenChange={setProvOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="size-4" /> {t('plt.prov_new_company_btn')}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('plt.prov_new_company_btn')}</DialogTitle>
          <DialogDescription>{t('plt.prov_dialog_desc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1"><Label>{t('plt.prov_company_name')}</Label><Input value={prov.company_name} onChange={(e) => setProv({ ...prov, company_name: e.target.value })} placeholder={t('plt.prov_company_name_ph')} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1"><Label>{t('plt.prov_tenant_code')}</Label><Input value={prov.tenant_code} onChange={(e) => setProv({ ...prov, tenant_code: e.target.value })} placeholder="OSHINEI" /></div>
            <div className="grid gap-1"><Label>{t('plt.prov_industry')}</Label>
              <Select className="w-auto" value={prov.industry} onChange={(e) => setProv({ ...prov, industry: e.target.value })}>
                {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1"><Label>{t('plt.prov_admin_username')}</Label><Input value={prov.admin_username} onChange={(e) => setProv({ ...prov, admin_username: e.target.value })} /></div>
            <div className="grid gap-1"><Label>{t('plt.prov_admin_password')}</Label><Input type="password" value={prov.admin_password} onChange={(e) => setProv({ ...prov, admin_password: e.target.value })} /></div>
          </div>
          <div className="grid gap-1"><Label>{t('plt.prov_email')}</Label><Input type="email" value={prov.email} onChange={(e) => setProv({ ...prov, email: e.target.value })} /></div>
          {/* docs/49 — edition chosen AT CREATION; upgrade-only afterwards (SME → Enterprise, never back). */}
          <div className="grid gap-1"><Label>{t('plt.prov_edition')}</Label>
            <Select className="w-auto" value={prov.control_profile} onChange={(e) => setProv({ ...prov, control_profile: e.target.value })}>
              <option value="enterprise">{t('plt.edition_enterprise')}</option>
              <option value="sme">{t('plt.edition_sme')}</option>
            </Select>
            <p className="text-xs text-muted-foreground">{prov.control_profile === 'sme' ? t('plt.prov_edition_sme_hint') : t('plt.prov_edition_ent_hint')}</p>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => provision.mutate()} disabled={provision.isPending || !prov.company_name || !prov.tenant_code || !prov.admin_username || !prov.admin_password}>
            {provision.isPending ? t('plt.prov_creating') : t('plt.prov_create_btn')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const inviteDialog = (
    <Dialog open={invOpen} onOpenChange={(o) => { setInvOpen(o); if (!o) setLastInvite(null); }}>
      <DialogTrigger asChild>
        <Button variant="outline"><Ticket className="size-4" /> {t('plt.inv_issue_btn')}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('plt.inv_dialog_title')}</DialogTitle>
          <DialogDescription>{t('plt.inv_dialog_desc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1"><Label>{t('plt.inv_company_name_optional')}</Label><Input value={inv.company_name} onChange={(e) => setInv({ ...inv, company_name: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1"><Label>{t('plt.inv_email_optional')}</Label><Input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></div>
            <div className="grid gap-1"><Label>{t('plt.inv_ttl_hours')}</Label><Input value={inv.ttl_hours} onChange={(e) => setInv({ ...inv, ttl_hours: e.target.value })} /></div>
          </div>
          {lastInvite && (
            <div className="rounded-md border border-primary/40 bg-primary/5 p-2 text-xs">
              <div className="font-medium">{t('plt.inv_token_label')}</div>
              <code className="mt-1 block break-all rounded bg-background p-1.5">{lastInvite.invite_token}</code>
              {lastInvite.expires_at && <div className="mt-1 text-muted-foreground">{t('plt.inv_expires', { date: thaiDate(lastInvite.expires_at) })}</div>}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => issueInvite.mutate()} disabled={issueInvite.isPending}>{issueInvite.isPending ? t('plt.inv_issuing') : t('plt.inv_issue_link_btn')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const companyRows = tagFilter ? comps.filter((c) => (c.tags ?? []).includes(tagFilter)) : comps;
  const companiesTab = (
    <StateView q={companies}>
      <label className="mb-2 flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
        <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
        {t('plt.show_deleted_toggle')}
      </label>
      {allTags.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t('plt.tags_label')}</span>
          <button type="button" onClick={() => setTagFilter('')} className={cn('rounded-full border px-2 py-0.5', !tagFilter && 'border-primary bg-primary/10 text-primary')}>{t('plt.tags_all')}</button>
          {allTags.map((tg) => (
            <button key={tg} type="button" onClick={() => setTagFilter(tg)} className={cn('rounded-full border px-2 py-0.5', tagFilter === tg && 'border-primary bg-primary/10 text-primary')}>{tg}</button>
          ))}
        </div>
      )}
      {selected.size > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs">
          <span className="font-medium">{t('plt.bulk_selected', { n: selected.size })}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => runBulk((c) => api(`/api/admin/tenants/${c.id}/suspend`, { method: 'POST', body: JSON.stringify({}) }), t('plt.bulk_label_suspend'))}><Pause className="size-3.5" /> {t('plt.bulk_suspend')}</Button>
            <Button size="sm" variant="ghost" onClick={() => runBulk((c) => api(`/api/admin/tenants/${c.id}/reactivate`, { method: 'POST', body: JSON.stringify({}) }), t('plt.bulk_label_reactivate'))}><Play className="size-3.5" /> {t('plt.bulk_reactivate')}</Button>
            <Button size="sm" variant="ghost" onClick={() => runBulk((c) => api(`/api/admin/tenants/${c.id}/extend-trial`, { method: 'POST', body: JSON.stringify({ days: 14 }) }), t('plt.bulk_label_extend_trial'))}><Clock className="size-3.5" /> {t('plt.bulk_extend_trial14')}</Button>
            <Select className="w-auto h-8" value={bulkPlan} onChange={(e) => setBulkPlan(e.target.value)}>
              <option value="">{t('plt.bulk_change_plan_ph')}</option>
              {(bulkPlans.data?.plans ?? []).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
            </Select>
            <Button size="sm" variant="ghost" disabled={!bulkPlan} onClick={() => runBulk((c) => api(`/api/admin/tenants/${c.id}/plan`, { method: 'POST', body: JSON.stringify({ plan_code: bulkPlan }) }), t('plt.bulk_label_change_plan'))}>{t('plt.bulk_apply')}</Button>
          </div>
          <button type="button" className="ml-auto text-muted-foreground hover:underline" onClick={clearSel}>{t('plt.bulk_clear')}</button>
        </div>
      )}
      <DataTable
        rows={companyRows}
        columns={companyCols}
        rowKey={(c) => c.id}
        // First column is a bare selection checkbox (no label) — feature the company name/code
        // instead as the mobile-card title, or the fallback card shows only a checkbox.
        cardTitleKey="name"
        emptyState={{ icon: Building2, title: tagFilter ? t('plt.empty_no_tag_title') : t('plt.empty_no_company_title'), description: tagFilter ? t('plt.empty_no_tag_desc') : t('plt.empty_no_company_desc') }}
      />
    </StateView>
  );

  const onboardingTab = (
    <div className="space-y-6">
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-medium"><UserPlus className="size-4 text-primary" /> {t('plt.onb_requests_title')}</h3>
        <StateView q={requests}>
          <DataTable
            rows={requests.data ?? []}
            columns={requestCols}
            rowKey={(r) => r.id}
            emptyState={{ icon: UserPlus, title: t('plt.onb_empty_title'), description: t('plt.onb_empty_desc') }}
          />
        </StateView>
      </div>
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-medium"><Ticket className="size-4 text-primary" /> {t('plt.onb_invites_title')}</h3>
        <StateView q={invites}>
          <DataTable
            rows={invites.data ?? []}
            columns={[
              { key: 'company_name', label: t('plt.onb_invite_col_company'), render: (i: any) => i.company_name ?? '—' },
              { key: 'email', label: t('plt.onb_invite_col_email'), render: (i: any) => i.email ?? '—' },
              { key: 'status', label: t('plt.onb_invite_col_status'), render: (i: any) => (i.status === 'used' ? t('plt.onb_invite_status_used') : i.status === 'expired' ? t('plt.onb_invite_status_expired') : t('plt.onb_invite_status_pending')) },
              { key: 'expires_at', label: t('plt.onb_invite_col_expires'), render: (i: any) => (i.expires_at ? thaiDate(i.expires_at) : '—') },
            ]}
            rowKey={(i: any, idx) => i.id ?? idx}
            emptyText={t('plt.onb_invite_empty')}
          />
        </StateView>
      </div>
    </div>
  );

  const pending = requests.data?.length ?? 0;
  const auditRows = (audit.data?.rows ?? []).filter((r: any) => {
    // Impersonation/god-action lens (item 4) — rows where a god ran cross-tenant (act-as or full bypass).
    if (auditGodOnly && !(r.meta?.god_act_as_tenant != null || r.meta?.rls_bypass)) return false;
    if (!auditText.trim()) return true;
    const q = auditText.toLowerCase();
    return `${r.actor ?? ''} ${r.action ?? ''}`.toLowerCase().includes(q);
  });
  
  const activityTab = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <Label className="text-xs">{t('plt.act_company')}</Label>
          <Select className="w-auto" value={auditCompany} onChange={(e) => setAuditCompany(e.target.value)}>
            <option value="">{t('plt.act_all_companies')}</option>
            {comps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">{t('plt.act_result')}</Label>
          <Select className="w-auto" value={auditStatus} onChange={(e) => setAuditStatus(e.target.value)}>
            <option value="">{t('plt.act_all')}</option>
            <option value="success">{t('plt.act_success')}</option>
            <option value="fail">{t('plt.act_fail')}</option>
          </Select>
        </div>
        <div className="grid flex-1 gap-1">
          <Label className="text-xs">{t('plt.act_search_label')}</Label>
          <Input value={auditText} onChange={(e) => setAuditText(e.target.value)} placeholder={t('plt.act_search_ph')} />
        </div>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={auditGodOnly} onChange={(e) => setAuditGodOnly(e.target.checked)} />
          {t('plt.act_god_only')}
        </label>
        <Button size="sm" variant="outline" onClick={() => verifyChain.mutate()} disabled={verifyChain.isPending}>
          <ShieldCheck className="size-3.5" /> {t('plt.act_verify_chain')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => apiDownload(`/api/admin/audit/export?${auditQs.replace('limit=100', '')}`, 'audit-log.csv')}>
          <Download className="size-3.5" /> {t('plt.act_export_csv')}
        </Button>
      </div>
      <StateView q={audit}>
        <DataTable
          rows={auditRows}
          columns={[
            { key: 'ts', label: t('plt.act_col_time'), render: (r: any) => (r.ts ? thaiDate(r.ts) : '—') },
            { key: 'tenant_id', label: t('plt.act_col_company'), render: (r: any) => companyName(r.tenant_id) },
            { key: 'actor', label: t('plt.act_col_actor'), render: (r: any) => r.actor ?? '—' },
            { key: 'action', label: t('plt.act_col_action'), render: (r: any) => <span className="font-mono text-xs">{r.action ?? ''}</span> },
            { key: 'status', label: t('plt.act_col_result'), render: (r: any) => <Badge variant={r.status === 'fail' ? 'destructive' : 'secondary'}>{r.status === 'fail' ? t('plt.act_fail') : t('plt.act_success')}</Badge> },
          ]}
          rowKey={(r: any) => r.id}
          emptyText={t('plt.act_empty')}
          pageSize={50}
        />
      </StateView>
      <p className="text-xs text-muted-foreground">{t('plt.act_showing', { shown: num(audit.data?.rows?.length ?? 0), total: num(audit.data?.total ?? 0) })}</p>
    </div>
  );

  const notifIcon = (type: string) =>
    type === 'signup_request' ? <UserPlus className="size-4 text-primary" />
    : type === 'tenant_suspended' ? <PauseCircle className="size-4 text-destructive" />
    : type === 'company_provisioned' ? <Building2 className="size-4 text-success" />
    : <Bell className="size-4 text-muted-foreground" />;

  const notificationsTab = (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{t('plt.notif_unread_of_total', { unread: num(notifs.data?.unread_count ?? 0), total: num(notifs.data?.total ?? 0) })}</span>
        <Button size="sm" variant="outline" disabled={!(notifs.data?.unread_count ?? 0) || markAllNotif.isPending} onClick={() => markAllNotif.mutate()}>
          <CheckCheck className="size-3.5" /> {t('plt.notif_mark_all_read')}
        </Button>
      </div>
      <StateView q={notifs}>
        <div className="divide-y rounded-md border">
          {(notifs.data?.items ?? []).length === 0 && <div className="p-4 text-center text-xs text-muted-foreground">{t('plt.notif_empty')}</div>}
          {(notifs.data?.items ?? []).map((nt: any) => (
            <div key={nt.id} className={cn('flex items-start gap-2 p-3 text-sm', !nt.is_read && 'bg-primary/5')}>
              <div className="mt-0.5 shrink-0">{notifIcon(nt.type)}</div>
              <div className="grid flex-1 gap-0.5 leading-tight">
                <span className={cn('truncate', !nt.is_read && 'font-medium')}>{nt.title}</span>
                {nt.body && <span className="text-xs text-muted-foreground">{nt.body}</span>}
                <span className="text-[10px] text-muted-foreground">{nt.created_at ? thaiDate(nt.created_at) : ''}</span>
              </div>
              {nt.tenant_id != null && (
                <button type="button" className="shrink-0 text-xs text-primary hover:underline" onClick={() => setDetailId(nt.tenant_id)}>{t('plt.notif_view_company')}</button>
              )}
              {!nt.is_read && (
                <button type="button" className="shrink-0 text-xs text-muted-foreground hover:underline" onClick={() => markNotif.mutate(nt.id)}>{t('plt.notif_mark_read')}</button>
              )}
            </div>
          ))}
        </div>
      </StateView>
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
  const setupIncompleteN = comps.filter((c) => c.setup_complete === false && !c.suspended).length;

  const overviewTab = (
    <StateView q={metrics}>
      {metrics.data && (
        <div className="space-y-6">
          {/* Revenue + engagement KPIs (cross-company; god RLS bypass spans the whole book). */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label={t('plt.ov_mrr')} value={baht(metrics.data.revenue.mrr)} icon={CircleDollarSign} tone="primary" hint={t('plt.ov_mrr_hint', { arr: baht(metrics.data.revenue.arr), arpu: baht(metrics.data.revenue.arpu) })} />
            <StatCard label={t('plt.ov_paying_companies')} value={num(metrics.data.subscriptions.active)} icon={Building2} tone="success" hint={t('plt.ov_paying_hint', { trialing: num(metrics.data.subscriptions.trialing), past_due: num(metrics.data.subscriptions.past_due) })} />
            <StatCard label={t('plt.ov_mau')} value={num(metrics.data.engagement.mau)} icon={Users} tone="info" hint={t('plt.ov_mau_hint', { dau: num(metrics.data.engagement.dau), stickiness: metrics.data.engagement.stickiness_pct })} />
            <StatCard label={t('plt.ov_churn')} value={`${metrics.data.churn.churn_rate_30d_pct}%`} icon={TrendingUp} tone={metrics.data.churn.churn_rate_30d_pct > 5 ? 'danger' : 'default'} hint={t('plt.ov_churn_hint', { n: num(metrics.data.churn.canceled_30d) })} />
          </div>

          {/* Needs-attention — what a god should act on. Open the Onboarding tab for the request queue. */}
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium"><AlertTriangle className="size-4 text-warning-foreground dark:text-warning" /> {t('plt.ov_needs_attention')}</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label={t('plt.ov_pending_requests')} value={num(pending)} icon={UserPlus} tone={pending ? 'warning' : 'default'} hint={t('plt.ov_pending_requests_hint')} />
              <StatCard label={t('plt.ov_trial_ending')} value={num(trialSoonN)} icon={Clock} tone={trialSoonN ? 'warning' : 'default'} />
              <StatCard label={t('plt.ov_past_due')} value={num(pastDueN)} icon={CircleDollarSign} tone={pastDueN ? 'danger' : 'default'} />
              <StatCard label={t('plt.ov_suspended')} value={num(suspendedN)} icon={PauseCircle} tone={suspendedN ? 'danger' : 'default'} />
              <StatCard label={t('plt.ov_setup_incomplete')} value={num(setupIncompleteN)} icon={AlertTriangle} tone={setupIncompleteN ? 'warning' : 'default'} hint={t('plt.ov_setup_incomplete_hint')} />
            </div>
          </div>

          {/* Platform health (item 10) — DB pool, cache, queue backlog + dead-letters. */}
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium"><Server className="size-4 text-primary" /> {t('plt.ov_system_health')}</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label={t('plt.ov_db_pool')} value={`${ops.data ? '' : '—'}${jobs.data?.pool?.saturation_pct ?? 0}%`} icon={Database} tone={(jobs.data?.pool?.saturation_pct ?? 0) > 80 ? 'danger' : 'default'} hint={t('plt.ov_db_pool_hint', { inflight: num(jobs.data?.pool?.in_flight_tx ?? 0), max: num(jobs.data?.pool?.max ?? 0) })} />
              <StatCard label={t('plt.ov_jobs_queued')} value={num(jobs.data?.jobs?.queued ?? 0)} icon={Activity} hint={t('plt.ov_jobs_queued_hint', { running: num(jobs.data?.jobs?.running ?? 0) })} />
              <StatCard label={t('plt.ov_jobs_failed')} value={num(jobs.data?.jobs?.failed ?? 0)} icon={AlertTriangle} tone={(jobs.data?.jobs?.failed ?? 0) > 0 ? 'danger' : 'default'} hint={t('plt.ov_jobs_failed_hint', { stuck: num(jobs.data?.jobs?.stuck ?? 0) })} />
              <StatCard label={t('plt.ov_cache')} value={ops.data?.cache?.provider ?? '—'} icon={Database} hint={ops.data ? t('plt.ov_cache_hint', { hits: num(ops.data.cache?.hits ?? 0), queue: ops.data.scale?.queue_provider ?? '—' }) : ''} />
            </div>
          </div>

          {/* AI spend oversight (item 5) — top token spenders across companies. */}
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium"><Sparkles className="size-4 text-primary" /> {t('plt.ov_ai_cross_company')}</h3>
            <Card className="p-0">
              <DataTable
                rows={(aiUsage.data ?? []).slice(0, 10)}
                columns={[
                  { key: 'name', label: t('plt.ov_ai_col_company'), render: (r: any) => <button type="button" className="text-left hover:underline" onClick={() => setDetailId(r.tenant_id)}>{r.name}</button> },
                  { key: 'total_tokens', label: t('plt.ov_ai_col_total_tokens'), align: 'right', render: (r: any) => num(r.total_tokens) },
                  { key: 'overage_tokens', label: t('plt.ov_ai_col_overage'), align: 'right', render: (r: any) => <span className={r.overage_tokens > 0 ? 'text-destructive' : ''}>{num(r.overage_tokens)}</span> },
                ]}
                rowKey={(r: any) => r.tenant_id}
                emptyText={t('plt.ov_ai_empty')}
              />
            </Card>
          </div>

          {/* Plan mix — active subscriptions + MRR contribution per plan. */}
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium"><Activity className="size-4 text-primary" /> {t('plt.ov_plan_mix')}</h3>
            <Card className="p-0">
              <DataTable
                rows={metrics.data.by_plan ?? []}
                columns={[
                  { key: 'name', label: t('plt.ov_plan_col_name'), render: (p: any) => <span className="font-medium">{p.name}</span> },
                  { key: 'price_monthly', label: t('plt.ov_plan_col_price'), align: 'right', render: (p: any) => baht(p.price_monthly) },
                  { key: 'active_subscriptions', label: t('plt.ov_plan_col_active'), align: 'right', render: (p: any) => num(p.active_subscriptions) },
                  { key: 'trialing', label: t('plt.ov_plan_col_trialing'), align: 'right', render: (p: any) => num(p.trialing) },
                  { key: 'mrr', label: t('plt.ov_plan_col_mrr'), align: 'right', render: (p: any) => baht(p.mrr) },
                ]}
                rowKey={(p: any) => p.plan}
                emptyText={t('plt.ov_plan_empty')}
              />
            </Card>
          </div>
        </div>
      )}
    </StateView>
  );

  const maintenanceTab = (
    <div className="space-y-4">
    <Card className="space-y-4 p-4">
      <div className="flex items-start gap-3">
        <Database className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div>
          <h3 className="font-medium">{t('plt.mnt_title')}</h3>
          <p className="text-sm text-muted-foreground">{t('plt.mnt_desc')}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => checkUnused.mutate()} disabled={checkUnused.isPending}>
          {checkUnused.isPending ? t('plt.mnt_checking') : t('plt.mnt_check')}
        </Button>
        {unusedPreview && (
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="destructive" disabled={unusedPreview.total === 0 || purgeUnused.isPending}>
                {t('plt.mnt_purge_btn', { n: unusedPreview.total })}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('plt.mnt_confirm_title')}</DialogTitle>
                <DialogDescription>{t('plt.mnt_confirm_desc', { n: unusedPreview.total })}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="destructive" onClick={() => purgeUnused.mutate()} disabled={purgeUnused.isPending}>
                  {purgeUnused.isPending ? t('plt.mnt_purging') : t('plt.mnt_confirm_btn')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
      {unusedPreview && (
        <div className="rounded-md border p-3 text-sm">
          <div className="font-medium">{t('plt.mnt_result', { n: unusedPreview.total, cols: unusedPreview.ref_columns })}</div>
          {unusedPreview.item_ids.length > 0 && (
            <div className="mt-1 break-words text-muted-foreground">
              {t('plt.mnt_sample')}: {unusedPreview.item_ids.slice(0, 50).join(', ')}{unusedPreview.sampled ? ' …' : ''}
            </div>
          )}
        </div>
      )}
      {unusedPreview && unusedPreview.kept_by.length > 0 && (
        <div className="rounded-md border p-3 text-sm">
          <div className="mb-1 font-medium">{t('plt.mnt_kept_title')}</div>
          <p className="mb-2 text-xs text-muted-foreground">{t('plt.mnt_kept_hint')}</p>
          <ul className="space-y-1">
            {unusedPreview.kept_by.slice(0, 20).map((k, i) => (
              <li key={k.tenant_id ?? `shared-${i}`} className="flex items-center justify-between gap-3">
                <span>{k.tenant_id == null ? t('plt.mnt_kept_shared') : `${k.name ?? k.code ?? `#${k.tenant_id}`}${k.code ? ` (${k.code})` : ''}`}</span>
                <Badge variant="secondary">{t('plt.mnt_kept_items', { n: k.items })}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>

    <Card className="space-y-4 border-destructive/40 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div>
          <h3 className="font-medium text-destructive">{t('plt.mnt_force_title')}</h3>
          <p className="text-sm text-muted-foreground">{t('plt.mnt_force_desc')}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => checkForce.mutate()} disabled={checkForce.isPending}>
          {checkForce.isPending ? t('plt.mnt_checking') : t('plt.mnt_force_check')}
        </Button>
        {forcePreview && (
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="destructive" disabled={forcePreview.items === 0 || forcePurge.isPending}>
                {t('plt.mnt_force_btn', { n: forcePreview.items })}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="text-destructive">{t('plt.mnt_force_confirm_title')}</DialogTitle>
                <DialogDescription>{t('plt.mnt_force_confirm_desc', { n: forcePreview.items, rows: forcePreview.total_ref_rows })}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="destructive" onClick={() => forcePurge.mutate()} disabled={forcePurge.isPending}>
                  {forcePurge.isPending ? t('plt.mnt_purging') : t('plt.mnt_force_confirm_btn')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
      {forcePreview && (
        <div className="rounded-md border border-destructive/40 p-3 text-sm">
          <div className="mb-1 font-medium text-destructive">{t('plt.mnt_force_result', { n: forcePreview.items, rows: forcePreview.total_ref_rows })}</div>
          {forcePreview.by_tenant.length > 0 ? (
            <>
              <p className="mb-2 text-xs text-muted-foreground">{t('plt.mnt_force_blast_hint')}</p>
              <ul className="space-y-1">
                {forcePreview.by_tenant.slice(0, 20).map((k, i) => (
                  <li key={k.tenant_id ?? `shared-${i}`} className="flex items-center justify-between gap-3">
                    <span>{k.tenant_id == null ? t('plt.mnt_kept_shared') : `${k.name ?? k.code ?? `#${k.tenant_id}`}${k.code ? ` (${k.code})` : ''}`}</span>
                    <Badge variant="destructive">{t('plt.mnt_force_rows', { n: k.ref_rows })}</Badge>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t('plt.mnt_force_no_refs')}</p>
          )}
        </div>
      )}
    </Card>
    </div>
  );

  // ── docs/49 — platform-wide SME provisioning defaults ─────────────────────
  // What every NEW SME company is stamped with at creation (identical for all SMEs). Changing these
  // affects only future companies — existing tenants keep their stamped copy.
  const smeDefaultsTab = (
    <Card className="space-y-4 p-4">
      <div className="flex items-start gap-3">
        <BadgeCheck className="mt-0.5 h-5 w-5 shrink-0 text-sky-600 dark:text-sky-400" />
        <div>
          <h3 className="font-medium">{t('plt.sme_def_title')}</h3>
          <p className="text-sm text-muted-foreground">{t('plt.sme_def_desc')}</p>
        </div>
      </div>
      <div className="grid max-w-md gap-1">
        <Label>{t('plt.sme_def_accountant_email')}</Label>
        <Input type="email" value={smeEmail} onChange={(e) => setSmeEmail(e.target.value)} placeholder="accountant@example.com" />
        <p className="text-xs text-muted-foreground">{t('plt.sme_def_accountant_hint')}</p>
      </div>
      <div className="grid gap-1">
        <Label>{t('plt.sme_def_hidden_groups')}</Label>
        <p className="text-xs text-muted-foreground">{t('plt.sme_def_hidden_hint')}</p>
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {INTERNAL_NAV.map((g) => (
            <label key={g.title} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
              <input
                type="checkbox"
                checked={smeHiddenGroups.includes(g.title)}
                onChange={(e) => setSmeHiddenGroups(e.target.checked ? [...smeHiddenGroups, g.title] : smeHiddenGroups.filter((k) => k !== g.title))}
              />
              <span className="truncate">{t(g.title)}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={() => saveSmeDefaults.mutate()} disabled={saveSmeDefaults.isPending}>
          {saveSmeDefaults.isPending ? t('plt.sme_def_saving') : t('plt.sme_def_save')}
        </Button>
        {smeDefaults.data?.updated_by && (
          <span className="text-xs text-muted-foreground">{t('plt.sme_def_last_updated', { by: smeDefaults.data.updated_by })}</span>
        )}
      </div>
    </Card>
  );

  return (
    <div>
      <PageHeader
        title={t('plt.page_title')}
        description={t('plt.page_desc')}
        actions={<div className="flex gap-2">{inviteDialog}{provisionDialog}</div>}
      />
      <Tabs
        urlParam="tab"
        tabs={[
          { key: 'overview', label: t('plt.tab_overview'), content: overviewTab },
          { key: 'companies', label: `${t('plt.tab_companies')} (${companies.data?.length ?? 0})`, content: companiesTab },
          { key: 'onboarding', label: pending ? `${t('plt.tab_onboarding')} (${pending})` : t('plt.tab_onboarding'), content: onboardingTab },
          { key: 'notifications', label: (notifs.data?.unread_count ?? 0) > 0 ? `${t('plt.tab_notifications')} (${notifs.data?.unread_count})` : t('plt.tab_notifications'), content: notificationsTab },
          { key: 'activity', label: t('plt.tab_activity'), content: activityTab },
          { key: 'maintenance', label: t('plt.tab_maintenance'), content: maintenanceTab },
          { key: 'sme', label: t('plt.tab_sme'), content: smeDefaultsTab },
        ]}
      />
      <CompanyDrawer id={detailId} onClose={() => setDetailId(null)} onChanged={refresh} />
    </div>
  );
}
