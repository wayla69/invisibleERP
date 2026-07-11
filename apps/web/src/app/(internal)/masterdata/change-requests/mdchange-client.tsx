'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Send, Check, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// GRC-3 (control MDM-01) — a change to a SENSITIVE master-data field (vendor bank account / bank name /
// account-holder name / credit limit / payment terms) is staged here and applied to the master ONLY when a
// DISTINCT user approves it (requester ≠ approver → 403 SOD_SELF_APPROVAL). Reads/writes gate masterdata/
// md_vendor/exec; approve/reject gate masterdata/exec.
const FIELDS = ['bank_account', 'bank_name', 'bank_account_name', 'credit_limit', 'payment_terms'] as const;

export type ChangeReq = {
  req_no: string; entity_type: string; entity_id: number; field: string; field_label: string;
  old_value: string | null; new_value: string | null; status: string; reason: string | null; requested_by: string | null;
};

export default function MasterdataChangesClient({ initialPending }: { initialPending?: { requests: ChangeReq[]; count: number } }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('mdc.title')} description={t('mdc.subtitle')} />
      <Tabs tabs={[
        { key: 'queue', label: t('mdc.tab_queue'), content: <Queue initialPending={initialPending} /> },
        { key: 'new', label: t('mdc.tab_new'), content: <ProposeForm /> },
      ]} />
    </div>
  );
}

function Queue({ initialPending }: { initialPending?: { requests: ChangeReq[]; count: number } }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ requests: ChangeReq[]; count: number }>({ queryKey: ['mdc-pending'], queryFn: () => api('/api/masterdata/change-requests'), initialData: initialPending });
  const act = useMutation({
    mutationFn: ({ reqNo, action, reason }: { reqNo: string; action: 'approve' | 'reject'; reason?: string }) =>
      api<any>(`/api/masterdata/change-requests/${reqNo}/${action}`, { method: 'POST', body: JSON.stringify(action === 'reject' ? { reason } : {}) }),
    onSuccess: (_r, v) => { notifySuccess(v.action === 'approve' ? t('mdc.approved_ok') : t('mdc.rejected_ok')); qc.invalidateQueries({ queryKey: ['mdc-pending'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const rows = q.data?.requests ?? [];
  const fieldLabel = (r: ChangeReq) => t(`mdc.field_${r.field}` as any) || r.field_label || r.field;

  return (
    <StateView q={q}>
      <DataTable
        rows={rows}
        emptyText={t('mdc.empty')}
        columns={[
          { key: 'req_no', label: t('mdc.col_req_no'), render: (r) => <span className="font-mono text-xs">{r.req_no}</span> },
          { key: 'entity', label: t('mdc.col_entity'), render: (r) => t(`mdc.entity_${r.entity_type}` as any) || r.entity_type },
          { key: 'entity_id', label: t('mdc.col_entity_id'), render: (r) => r.entity_id },
          { key: 'field', label: t('mdc.col_field'), render: (r) => fieldLabel(r) },
          { key: 'old', label: t('mdc.col_old'), render: (r) => <span className="text-muted-foreground">{r.old_value ?? '—'}</span> },
          { key: 'new', label: t('mdc.col_new'), render: (r) => <span className="font-medium">{r.new_value ?? '—'}</span> },
          { key: 'requested_by', label: t('mdc.col_requested_by'), render: (r) => r.requested_by ?? '—' },
          { key: 'reason', label: t('mdc.col_reason'), render: (r) => <span className="text-sm text-muted-foreground">{r.reason ?? '—'}</span> },
          {
            key: 'actions', label: t('mdc.col_actions'), render: (r) => (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ reqNo: r.req_no, action: 'approve' })}>
                  <Check className="size-3.5" /> {t('mdc.approve')}
                </Button>
                <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => { const reason = window.prompt(t('mdc.reject_prompt')) ?? undefined; act.mutate({ reqNo: r.req_no, action: 'reject', reason }); }}>
                  <X className="size-3.5" /> {t('mdc.reject')}
                </Button>
              </div>
            ),
          },
        ]}
      />
    </StateView>
  );
}

function ProposeForm() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [vendorId, setVendorId] = useState('');
  const [field, setField] = useState<string>('bank_account_name');
  const [newValue, setNewValue] = useState('');
  const [reason, setReason] = useState('');
  const stage = useMutation({
    mutationFn: () => api<any>('/api/masterdata/change-requests', {
      method: 'POST',
      body: JSON.stringify({ entity_type: 'vendor', entity_id: Number(vendorId), field, new_value: newValue, reason: reason || undefined }),
    }),
    onSuccess: () => { notifySuccess(t('mdc.staged')); setNewValue(''); setReason(''); qc.invalidateQueries({ queryKey: ['mdc-pending'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const valid = vendorId !== '' && Number(vendorId) > 0 && newValue.trim() !== '';

  return (
    <Card className="max-w-xl p-6">
      <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
        <ShieldCheck className="size-4" /> {t('mdc.subtitle')}
      </div>
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="mdc-entity">{t('mdc.col_entity')}</Label>
          <Input id="mdc-entity" value={t('mdc.entity_vendor')} disabled readOnly />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="mdc-vendor">{t('mdc.f_vendor')}</Label>
          <Input id="mdc-vendor" type="number" min="1" value={vendorId} onChange={(e) => setVendorId(e.target.value)} placeholder={t('mdc.pick_vendor')} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="mdc-field">{t('mdc.f_field')}</Label>
          <Select value={field} onValueChange={setField}>
            <SelectTrigger id="mdc-field" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {FIELDS.map((f) => <SelectItem key={f} value={f}>{t(`mdc.field_${f}` as any)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="mdc-value">{t('mdc.f_new_value')}</Label>
          <Input id="mdc-value" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="mdc-reason">{t('mdc.f_reason')}</Label>
          <Input id="mdc-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <Button disabled={!valid || stage.isPending} onClick={() => stage.mutate()}>
          <Send className="size-4" /> {t('mdc.submit')}
        </Button>
      </div>
    </Card>
  );
}
