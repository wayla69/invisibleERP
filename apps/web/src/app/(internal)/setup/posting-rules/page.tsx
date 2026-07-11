'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Route, Save, Eye, History, ListChecks, BookOpen, Settings2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { num, thaiDateTime } from '@/lib/format';

// กฎการลงบัญชี — the full registry workspace over the account-determination engine (docs/43 PR-9).
// Four surfaces: (1) the posting-event REGISTRY grid — every event/role with its REAL default account,
// override tier and the tenant's current override; (2) configure & preview (the PR-1 editor); (3) the
// GL-24 pending-approval queue; (4) the append-only audit trail. Global defaults ship with the product;
// a tenant shadows a leg with its own account (docs/33 · GL-12/GL-21; governance = GL-24).

type RegistryRole = { side: 'DR' | 'CR'; default: string; tier: 'free' | 'widen' | 'pinned'; description: string };
type RegistryEvent = { name: string; description: string; wired: boolean; roles: Record<string, RegistryRole> };

const TIER_BADGE: Record<RegistryRole['tier'], 'success' | 'info' | 'muted'> = { free: 'success', widen: 'info', pinned: 'muted' };
const AUDIT_BADGE: Record<string, 'info' | 'success' | 'warning' | 'muted'> = { CREATE: 'info', APPROVE: 'success', REJECT: 'warning', DEACTIVATE: 'muted' };

export default function PostingRulesPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [tab, setTab] = useState('registry');

  const registry = useQuery<{ events: Record<string, RegistryEvent> }>({ queryKey: ['posting-registry'], queryFn: () => api('/api/ledger/posting-rules/registry') });
  const allRules = useQuery<any[]>({ queryKey: ['posting-rules-all'], queryFn: () => api('/api/ledger/posting-rules') });
  const events = useQuery<any[]>({ queryKey: ['posting-event-types'], queryFn: () => api('/api/ledger/posting-rules/event-types') });
  const audit = useQuery<{ audit: any[]; count: number }>({ queryKey: ['posting-rule-audit'], queryFn: () => api('/api/ledger/posting-rules/audit'), enabled: tab === 'audit' });
  // COA datalist for the account field — fail-soft (a gl_posting_rules-only user without the read just types the code; the server validates fail-closed either way).
  const coa = useQuery<{ accounts: { code: string; name: string; isPostable?: boolean | null }[] }>({ queryKey: ['coa-picker'], queryFn: () => api('/api/ledger/accounts'), retry: false });

  const [eventType, setEventType] = useState('');
  const rules = useQuery<any>({ queryKey: ['posting-rules', eventType], queryFn: () => api(`/api/ledger/posting-rules?eventType=${encodeURIComponent(eventType)}`), enabled: !!eventType });

  const [legOrder, setLegOrder] = useState('1');
  const [role, setRole] = useState('');
  const [side, setSide] = useState<'DR' | 'CR'>('DR');
  const [accountCode, setAccountCode] = useState('');

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['posting-rules', eventType] });
    qc.invalidateQueries({ queryKey: ['posting-rules-all'] });
    qc.invalidateQueries({ queryKey: ['posting-rule-audit'] });
  };

  // GL-24: an override lands PendingApproval — a DIFFERENT user must approve it before postings use it.
  const upsert = useMutation({
    mutationFn: () => api('/api/ledger/posting-rules', { method: 'POST', body: JSON.stringify({ eventType, legOrder: Number(legOrder), role: role.trim(), side, accountCode: accountCode.trim() }) }),
    onSuccess: () => { notifySuccess(t('st.spost_saved_pending')); setRole(''); setAccountCode(''); invalidateAll(); },
    onError: (e: any) => notifyError(e.message),
  });
  const approve = useMutation({
    mutationFn: (id: number) => api(`/api/ledger/posting-rules/${id}/approve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('st.spost_approved')); invalidateAll(); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (id: number) => api(`/api/ledger/posting-rules/${id}/reject`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => { notifySuccess(t('st.spost_rejected')); invalidateAll(); },
    onError: (e: any) => notifyError(e.message),
  });
  const deactivate = useMutation({
    mutationFn: (id: number) => api(`/api/ledger/posting-rules/${id}/deactivate`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('st.spost_deactivated')); invalidateAll(); },
    onError: (e: any) => notifyError(e.message),
  });

  const [amounts, setAmounts] = useState('{"inventory":1000}');
  const preview = useMutation<any[]>({
    mutationFn: () => api('/api/ledger/posting-rules/preview', { method: 'POST', body: JSON.stringify({ eventType, amounts: JSON.parse(amounts || '{}') }) }),
    onError: (e: any) => notifyError(e.message?.includes('JSON') ? t('st.spost_json_error') : e.message),
  });

  const eventList = events.data ?? [];
  const registryEvents = registry.data?.events ?? {};

  // Tenant override per event|role (listRules returns active rows only, so Pending/Approved here);
  // the latest write wins for display. Global seed rows (tenantId null) feed the leg-order prefill.
  const overrideMap = useMemo(() => {
    const m = new Map<string, any>();
    for (const r of allRules.data ?? []) {
      if (!r.tenantId) continue;
      const k = `${r.eventType}|${r.role}`;
      const prev = m.get(k);
      if (!prev || Number(r.id) > Number(prev.id)) m.set(k, r);
    }
    return m;
  }, [allRules.data]);
  const anyRuleMap = useMemo(() => {
    const m = new Map<string, any>();
    for (const r of allRules.data ?? []) {
      const k = `${r.eventType}|${r.role}`;
      if (!m.has(k) || r.tenantId) m.set(k, r);
    }
    return m;
  }, [allRules.data]);

  const pendingRules = useMemo(() => (allRules.data ?? []).filter((r: any) => r.tenantId && r.status === 'PendingApproval'), [allRules.data]);
  const approvedOverrides = useMemo(() => [...overrideMap.values()].filter((r: any) => r.status === 'Approved'), [overrideMap]);

  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState('all');
  const filteredEvents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return Object.entries(registryEvents).filter(([key, ev]) => {
      const roleHit = Object.entries(ev.roles).some(([rk, rd]) =>
        (tierFilter === 'all' || rd.tier === tierFilter) &&
        (!q || rk.toLowerCase().includes(q) || rd.default.includes(q) || rd.description.toLowerCase().includes(q)));
      const headHit = !q || key.toLowerCase().includes(q) || ev.name.toLowerCase().includes(q);
      return tierFilter === 'all' ? (headHit || roleHit) : roleHit && (headHit || true);
    });
  }, [registryEvents, search, tierFilter]);

  const configureRole = (eventKey: string, roleKey: string, def: RegistryRole) => {
    const existing = anyRuleMap.get(`${eventKey}|${roleKey}`);
    setEventType(eventKey);
    setRole(roleKey);
    setSide(def.side);
    setLegOrder(String(existing?.legOrder ?? 1));
    setAccountCode(overrideMap.get(`${eventKey}|${roleKey}`)?.accountCode ?? '');
    setTab('manage');
  };

  const tierBadge = (tier: RegistryRole['tier']) => <Badge variant={TIER_BADGE[tier]}>{t(`st.spost_tier_${tier}`)}</Badge>;
  const statusBadge = (status: string) => status === 'PendingApproval'
    ? <Badge variant="warning">{t('st.spost_status_pending')}</Badge>
    : <Badge variant="success">{t('st.spost_status_approved')}</Badge>;

  return (
    <div>
      <PageHeader title={t('st.spost_title')} description={t('st.spost_desc')} />
      <Tabs value={tab} onValueChange={setTab} className="gap-5">
        <TabsList>
          <TabsTrigger value="registry"><BookOpen className="size-4" /> {t('st.spost_tab_registry')}</TabsTrigger>
          <TabsTrigger value="manage"><Settings2 className="size-4" /> {t('st.spost_tab_manage')}</TabsTrigger>
          <TabsTrigger value="queue">
            <ListChecks className="size-4" /> {t('st.spost_tab_queue')}
            {pendingRules.length > 0 && <Badge variant="warning" className="ml-1">{pendingRules.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="audit"><History className="size-4" /> {t('st.spost_tab_audit')}</TabsTrigger>
        </TabsList>

        {/* ── 1 · Registry grid: every event/role with default vs override ── */}
        <TabsContent value="registry" className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-4">
            <Card className="gap-1 p-4"><div className="text-2xl font-semibold">{Object.keys(registryEvents).length}</div><div className="text-sm text-muted-foreground">{t('st.spost_reg_events')}</div></Card>
            <Card className="gap-1 p-4"><div className="text-2xl font-semibold">{Object.values(registryEvents).filter((e) => e.wired).length}</div><div className="text-sm text-muted-foreground">{t('st.spost_reg_wired')}</div></Card>
            <Card className="gap-1 p-4"><div className="text-2xl font-semibold">{approvedOverrides.length}</div><div className="text-sm text-muted-foreground">{t('st.spost_reg_overridden')}</div></Card>
            <Card className="gap-1 p-4"><div className="text-2xl font-semibold">{pendingRules.length}</div><div className="text-sm text-muted-foreground">{t('st.spost_status_pending')}</div></Card>
          </div>
          <div className="flex flex-wrap gap-3">
            <Input className="max-w-sm" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('st.spost_reg_search_ph')} />
            <Select value={tierFilter} onValueChange={setTierFilter}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('st.spost_reg_tier_all')}</SelectItem>
                <SelectItem value="free">{t('st.spost_tier_free')}</SelectItem>
                <SelectItem value="widen">{t('st.spost_tier_widen')}</SelectItem>
                <SelectItem value="pinned">{t('st.spost_tier_pinned')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {filteredEvents.length === 0 && (
            <Card className="items-center gap-2 p-10 text-center">
              <Route className="size-8 text-muted-foreground" />
              <div className="font-medium">{t('st.spost_reg_empty')}</div>
            </Card>
          )}
          {filteredEvents.map(([key, ev]) => (
            <Card key={key} className="gap-3 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold">{key}</span>
                <span className="text-base font-semibold">{ev.name}</span>
                <Badge variant={ev.wired ? 'success' : 'muted'}>{ev.wired ? t('st.spost_reg_wired_badge') : t('st.spost_reg_catalog')}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{ev.description}</p>
              <DataTable
                rows={Object.entries(ev.roles)
                  .filter(([, rd]) => tierFilter === 'all' || rd.tier === tierFilter)
                  .map(([rk, rd]) => ({ roleKey: rk, ...rd, ovr: overrideMap.get(`${key}|${rk}`) }))}
                rowKey={(r: any) => r.roleKey}
                columns={[
                  { key: 'roleKey', label: t('st.spost_col_role'), render: (r: any) => <span className="font-mono text-xs">{r.roleKey}</span> },
                  { key: 'side', label: t('st.spost_col_side'), render: (r: any) => <Badge variant={r.side === 'DR' ? 'success' : 'warning'}>{r.side}</Badge> },
                  { key: 'default', label: t('st.spost_col_default'), render: (r: any) => <span className="font-mono">{r.default}</span> },
                  { key: 'tier', label: t('st.spost_col_tier'), render: (r: any) => tierBadge(r.tier) },
                  { key: 'description', label: t('st.spost_col_detail'), render: (r: any) => <span className="text-xs text-muted-foreground">{r.description}</span> },
                  {
                    key: 'ovr', label: t('st.spost_col_override'), sortable: false, render: (r: any) => r.ovr ? (
                      <span className="flex items-center gap-1.5"><span className="font-mono">{r.ovr.accountCode}</span>{statusBadge(r.ovr.status)}</span>
                    ) : <span className="text-muted-foreground">—</span>,
                  },
                  {
                    key: 'actions', label: t('st.spost_col_actions'), sortable: false, render: (r: any) => r.tier === 'free' ? (
                      <Button size="sm" variant="outline" onClick={() => configureRole(key, r.roleKey, r)}>{t('st.spost_reg_configure')}</Button>
                    ) : <span className="text-muted-foreground">—</span>,
                  },
                ]}
              />
            </Card>
          ))}
        </TabsContent>

        {/* ── 2 · Configure & preview (the PR-1 editor) ── */}
        <TabsContent value="manage" className="space-y-5">
          <Card className="max-w-xl gap-4 p-5">
            <Label>{t('st.spost_event_type')}</Label>
            <Select value={eventType} onValueChange={setEventType}>
              <SelectTrigger className="w-full"><SelectValue placeholder={t('st.spost_event_ph')} /></SelectTrigger>
              <SelectContent>
                {eventList.map((e: any) => <SelectItem key={e.key} value={e.key}>{e.key} — {e.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Card>

          {eventType && (
            <>
              <Card className="gap-4 p-5">
                <h3 className="text-base font-semibold">{t('st.spost_active_rules')}</h3>
                <DataTable
                  rows={rules.data ?? []}
                  rowKey={(r: any, i: number) => `${r.legOrder}-${r.role}-${i}`}
                  columns={[
                    { key: 'legOrder', label: t('st.spost_col_order') },
                    { key: 'role', label: t('st.spost_col_role') },
                    { key: 'side', label: t('st.spost_col_side'), render: (r: any) => <Badge variant={r.side === 'DR' ? 'success' : 'warning'}>{r.side}</Badge> },
                    { key: 'accountCode', label: t('st.spost_col_account') },
                    { key: 'tenantId', label: t('st.spost_col_source'), render: (r: any) => <Badge variant={r.tenantId ? 'info' : 'muted'}>{r.tenantId ? t('st.spost_source_tenant') : t('st.spost_source_default')}</Badge> },
                    { key: 'status', label: t('st.spost_col_status'), render: (r: any) => !r.tenantId ? <span className="text-muted-foreground">—</span> : statusBadge(r.status) },
                    {
                      key: 'actions', label: t('st.spost_col_actions'), sortable: false, render: (r: any) => r.tenantId && r.status === 'PendingApproval' ? (
                        <div className="flex gap-1">
                          <Button size="sm" variant="outline" disabled={approve.isPending} onClick={() => approve.mutate(Number(r.id))}>{t('st.spost_approve')}</Button>
                          <Button size="sm" variant="ghost" disabled={reject.isPending} onClick={() => reject.mutate(Number(r.id))}>{t('st.spost_reject')}</Button>
                        </div>
                      ) : r.tenantId && r.status === 'Approved' ? (
                        <Button size="sm" variant="ghost" disabled={deactivate.isPending} onClick={() => deactivate.mutate(Number(r.id))}>{t('st.spost_deactivate')}</Button>
                      ) : <span className="text-muted-foreground">—</span>,
                    },
                  ]}
                  emptyState={{ icon: Route, title: t('st.spost_empty_rules_title'), description: t('st.spost_empty_rules_desc') }}
                />
              </Card>

              <div className="grid gap-5 lg:grid-cols-2">
                <Card className="gap-4 p-5">
                  <h3 className="text-base font-semibold">{t('st.spost_override_heading')}</h3>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-2"><Label>{t('st.spost_leg')}</Label><Input type="number" value={legOrder} onChange={(e) => setLegOrder(e.target.value)} /></div>
                    <div className="grid gap-2"><Label>{t('st.spost_role')}</Label><Input value={role} onChange={(e) => setRole(e.target.value)} placeholder={t('st.spost_role_ph')} /></div>
                    <div className="grid gap-2">
                      <Label>{t('st.spost_side')}</Label>
                      <Select value={side} onValueChange={(v) => setSide(v as 'DR' | 'CR')}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="DR">{t('st.spost_debit')}</SelectItem><SelectItem value="CR">{t('st.spost_credit')}</SelectItem></SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label>{t('st.spost_account')}</Label>
                      <Input list="spost-coa-list" value={accountCode} onChange={(e) => setAccountCode(e.target.value)} placeholder={t('st.spost_account_ph')} />
                      <datalist id="spost-coa-list">
                        {(coa.data?.accounts ?? []).filter((a) => a.isPostable !== false).map((a) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                      </datalist>
                    </div>
                  </div>
                  <div>
                    <Button disabled={upsert.isPending || !role.trim() || !accountCode.trim()} onClick={() => upsert.mutate()}><Save className="size-4" /> {upsert.isPending ? t('st.spost_saving') : t('st.spost_save_override')}</Button>
                  </div>
                </Card>

                <Card className="gap-4 p-5">
                  <h3 className="text-base font-semibold">{t('st.spost_preview_heading')}</h3>
                  <div className="grid gap-2">
                    <Label>{t('st.spost_amounts_label')}</Label>
                    <Input value={amounts} onChange={(e) => setAmounts(e.target.value)} placeholder='{"inventory":1000}' />
                  </div>
                  <div><Button variant="outline" disabled={preview.isPending} onClick={() => preview.mutate()}><Eye className="size-4" /> {t('st.spost_show_preview')}</Button></div>
                  {preview.data && (
                    <DataTable
                      rows={preview.data as any[]}
                      rowKey={(r: any, i: number) => i}
                      columns={[
                        { key: 'role', label: t('st.spost_col_role2') },
                        { key: 'side', label: t('st.spost_col_side'), render: (r: any) => <Badge variant={r.side === 'DR' ? 'success' : 'warning'}>{r.side}</Badge> },
                        { key: 'accountCode', label: t('st.spost_col_account') },
                        { key: 'amount', label: t('st.spost_col_amount'), align: 'right', render: (r: any) => num(r.amount) },
                      ]}
                      emptyState={{ icon: Eye, title: t('st.spost_empty_preview_title'), description: t('st.spost_empty_preview_desc') }}
                    />
                  )}
                </Card>
              </div>
            </>
          )}
        </TabsContent>

        {/* ── 3 · GL-24 pending-approval queue (cross-event) ── */}
        <TabsContent value="queue">
          <Card className="gap-4 p-5">
            <h3 className="text-base font-semibold">{t('st.spost_tab_queue')}</h3>
            <DataTable
              rows={pendingRules}
              rowKey={(r: any) => r.id}
              columns={[
                { key: 'eventType', label: t('st.spost_col_event'), render: (r: any) => <span className="font-mono text-xs">{r.eventType}</span> },
                { key: 'legOrder', label: t('st.spost_col_order') },
                { key: 'role', label: t('st.spost_col_role'), render: (r: any) => <span className="font-mono text-xs">{r.role}</span> },
                { key: 'side', label: t('st.spost_col_side'), render: (r: any) => <Badge variant={r.side === 'DR' ? 'success' : 'warning'}>{r.side}</Badge> },
                { key: 'accountCode', label: t('st.spost_col_account'), render: (r: any) => <span className="font-mono">{r.accountCode}</span> },
                { key: 'createdBy', label: t('st.spost_col_by') },
                { key: 'createdAt', label: t('st.spost_col_at'), render: (r: any) => <span className="text-xs text-muted-foreground">{thaiDateTime(r.createdAt)}</span> },
                {
                  key: 'actions', label: t('st.spost_col_actions'), sortable: false, render: (r: any) => (
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" disabled={approve.isPending} onClick={() => approve.mutate(Number(r.id))}>{t('st.spost_approve')}</Button>
                      <Button size="sm" variant="ghost" disabled={reject.isPending} onClick={() => reject.mutate(Number(r.id))}>{t('st.spost_reject')}</Button>
                    </div>
                  ),
                },
              ]}
              emptyState={{ icon: ListChecks, title: t('st.spost_queue_empty_title'), description: t('st.spost_queue_empty_desc') }}
            />
          </Card>
        </TabsContent>

        {/* ── 4 · GL-24 append-only audit trail (newest first) ── */}
        <TabsContent value="audit">
          <Card className="gap-4 p-5">
            <h3 className="text-base font-semibold">{t('st.spost_tab_audit')}</h3>
            <DataTable
              rows={[...(audit.data?.audit ?? [])].reverse()}
              rowKey={(r: any) => r.id}
              columns={[
                { key: 'at', label: t('st.spost_col_at'), render: (r: any) => <span className="text-xs text-muted-foreground">{thaiDateTime(r.at)}</span> },
                { key: 'action', label: t('st.spost_col_action'), render: (r: any) => <Badge variant={AUDIT_BADGE[r.action] ?? 'muted'}>{r.action}</Badge> },
                { key: 'actor', label: t('st.spost_col_actor'), render: (r: any) => r.actor ?? <span className="text-muted-foreground">—</span> },
                { key: 'ruleId', label: t('st.spost_col_rule') },
                {
                  key: 'detail', label: t('st.spost_col_detail'), sortable: false, render: (r: any) => {
                    const d = r.detail ?? {};
                    const parts = [d.event_type, d.role, d.account_code ? `→ ${d.account_code}` : null, d.reason ? `(${d.reason})` : null].filter(Boolean);
                    return <span className="font-mono text-xs">{parts.join(' · ') || '—'}</span>;
                  },
                },
              ]}
              emptyState={{ icon: History, title: t('st.spost_audit_empty_title'), description: t('st.spost_audit_empty_desc') }}
            />
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
