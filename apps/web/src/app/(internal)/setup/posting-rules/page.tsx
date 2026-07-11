'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Route, Save, Eye } from 'lucide-react';
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
import { num } from '@/lib/format';

// กฎการลงบัญชี — read + tenant-override editor over the account-determination engine (posting_rules).
// Global defaults ship with the product; a tenant shadows a leg with its own account (docs/33 · GL-12/GL-21).
export default function PostingRulesPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const events = useQuery<any[]>({ queryKey: ['posting-event-types'], queryFn: () => api('/api/ledger/posting-rules/event-types') });
  const [eventType, setEventType] = useState('');
  const rules = useQuery<any>({ queryKey: ['posting-rules', eventType], queryFn: () => api(`/api/ledger/posting-rules?eventType=${encodeURIComponent(eventType)}`), enabled: !!eventType });

  const [legOrder, setLegOrder] = useState('1');
  const [role, setRole] = useState('');
  const [side, setSide] = useState<'DR' | 'CR'>('DR');
  const [accountCode, setAccountCode] = useState('');
  // GL-24: an override lands PendingApproval — a DIFFERENT user must approve it before postings use it.
  const upsert = useMutation({
    mutationFn: () => api('/api/ledger/posting-rules', { method: 'POST', body: JSON.stringify({ eventType, legOrder: Number(legOrder), role: role.trim(), side, accountCode: accountCode.trim() }) }),
    onSuccess: () => { notifySuccess(t('st.spost_saved_pending')); setRole(''); setAccountCode(''); qc.invalidateQueries({ queryKey: ['posting-rules', eventType] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const approve = useMutation({
    mutationFn: (id: number) => api(`/api/ledger/posting-rules/${id}/approve`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('st.spost_approved')); qc.invalidateQueries({ queryKey: ['posting-rules', eventType] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const reject = useMutation({
    mutationFn: (id: number) => api(`/api/ledger/posting-rules/${id}/reject`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => { notifySuccess(t('st.spost_rejected')); qc.invalidateQueries({ queryKey: ['posting-rules', eventType] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const [amounts, setAmounts] = useState('{"inventory":1000}');
  const preview = useMutation<any[]>({
    mutationFn: () => api('/api/ledger/posting-rules/preview', { method: 'POST', body: JSON.stringify({ eventType, amounts: JSON.parse(amounts || '{}') }) }),
    onError: (e: any) => notifyError(e.message?.includes('JSON') ? t('st.spost_json_error') : e.message),
  });

  const eventList = events.data ?? [];

  return (
    <div>
      <PageHeader title={t('st.spost_title')} description={t('st.spost_desc')} />
      <div className="space-y-5">
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
                  { key: 'status', label: t('st.spost_col_status'), render: (r: any) => !r.tenantId ? <span className="text-muted-foreground">—</span> : r.status === 'PendingApproval' ? <Badge variant="warning">{t('st.spost_status_pending')}</Badge> : <Badge variant="success">{t('st.spost_status_approved')}</Badge> },
                  {
                    key: 'actions', label: t('st.spost_col_actions'), sortable: false, render: (r: any) => r.tenantId && r.status === 'PendingApproval' ? (
                      <div className="flex gap-1">
                        <Button size="sm" variant="outline" disabled={approve.isPending} onClick={() => approve.mutate(Number(r.id))}>{t('st.spost_approve')}</Button>
                        <Button size="sm" variant="ghost" disabled={reject.isPending} onClick={() => reject.mutate(Number(r.id))}>{t('st.spost_reject')}</Button>
                      </div>
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
                  <div className="grid gap-2"><Label>{t('st.spost_account')}</Label><Input value={accountCode} onChange={(e) => setAccountCode(e.target.value)} placeholder={t('st.spost_account_ph')} /></div>
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
      </div>
    </div>
  );
}
