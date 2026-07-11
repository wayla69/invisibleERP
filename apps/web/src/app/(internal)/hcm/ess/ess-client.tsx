'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IdCard, FileText, Users, Plus, ShieldCheck, Check, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';
import { Select } from '@/components/form-controls';

// HR-8 (docs/42, Wave 3) — Employee Self-Service depth. Profile-change requests (HR-08 maker-checker: a
// sensitive field is parked pending until a different hr/hr_admin approves), personal documents, team
// directory. Own-scoped by emp_code server-side.
interface ChangeReq { id: number; emp_code: string; field: string; sensitive: boolean; old_value: string | null; new_value: string; status: string; reason: string | null; requested_by: string | null; approved_by: string | null }
interface EmpDoc { id: number; emp_code: string; doc_type: string; title: string; file_ref: string | null; visibility: string; uploaded_by: string | null }
interface TeamMember { emp_code: string; name: string; position: string | null; department: string | null }

const SENSITIVE = new Set(['name', 'national_id', 'bank_account', 'tax_id']);

export default function EssProfileClient({ initialRequests }: { initialRequests?: any }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('hx.ess.title')} description={t('hx.ess.subtitle')} />
      <Tabs tabs={[
        { key: 'profile', label: t('hx.ess.tab_profile'), content: <ProfileTab initialRequests={initialRequests} /> },
        { key: 'documents', label: t('hx.ess.tab_documents'), content: <DocumentsTab /> },
        { key: 'team', label: t('hx.ess.tab_team'), content: <TeamTab /> },
      ]} />
    </div>
  );
}

function ProfileTab({ initialRequests }: { initialRequests?: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ requests: ChangeReq[]; count: number }>({ queryKey: ['ess-changes'], queryFn: () => api('/api/hcm/ess/profile-requests'), initialData: initialRequests });

  const [field, setField] = useState('phone');
  const [newValue, setNewValue] = useState('');
  const [reason, setReason] = useState('');

  const submit = useMutation({
    mutationFn: () => api('/api/hcm/ess/profile-requests', { method: 'POST', body: JSON.stringify({ field, new_value: newValue, reason: reason || undefined }) }),
    onSuccess: (r: any) => {
      notifySuccess(r.status === 'applied' ? t('hx.ess.change_applied') : t('hx.ess.change_pending'));
      setNewValue(''); setReason('');
      qc.invalidateQueries({ queryKey: ['ess-changes'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const decide = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'approve' | 'reject' }) => api(`/api/hcm/ess/profile-requests/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => { notifySuccess(t('hx.common.update_status')); qc.invalidateQueries({ queryKey: ['ess-changes'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const rows = q.data?.requests ?? [];

  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><IdCard className="size-4" /> {t('hx.ess.request_title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('hx.ess.request_hint')}</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="pc-field">{t('hx.ess.field')}</Label>
              <Select id="pc-field" value={field} onChange={(e) => setField(e.target.value)}>
                <option value="phone">{t('hx.ess.field_phone')}</option>
                <option value="address">{t('hx.ess.field_address')}</option>
                <option value="emergency_contact">{t('hx.ess.field_emergency')}</option>
                <option value="name">{t('hx.ess.field_name')}</option>
                <option value="bank_account">{t('hx.ess.field_bank')}</option>
                <option value="national_id">{t('hx.ess.field_nid')}</option>
                <option value="tax_id">{t('hx.ess.field_tax')}</option>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pc-value">{t('hx.ess.new_value')}</Label>
              <Input id="pc-value" value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder={t('hx.ess.new_value')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pc-reason">{t('hr.reason')}</Label>
              <Input id="pc-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </div>
          {SENSITIVE.has(field) && (
            <p className="flex items-center gap-2 text-sm text-warning"><ShieldCheck className="size-4" /> {t('hx.ess.sensitive_note')}</p>
          )}
          <Button disabled={submit.isPending || !newValue} onClick={() => submit.mutate()}>
            <Plus className="size-4" /> {submit.isPending ? t('hr.submitting') : t('hx.ess.submit_change')}
          </Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            emptyState={{ icon: IdCard, title: t('hx.ess.changes_empty_title'), description: t('hx.ess.changes_empty_desc') }}
            columns={[
              { key: 'field', label: t('hx.ess.field'), render: (r) => <span className="font-medium">{r.field}</span> },
              { key: 'new_value', label: t('hx.ess.new_value'), render: (r) => <span className="tabular">{r.new_value}</span> },
              { key: 'sensitive', label: t('hx.ess.sensitive_col'), render: (r) => <Badge variant={r.sensitive ? 'warning' : 'secondary'}>{r.sensitive ? t('hx.ess.sensitive_yes') : t('hx.ess.sensitive_no')}</Badge> },
              { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              { key: 'requested_by', label: t('hx.ess.requested_by'), render: (r) => r.requested_by ?? '—' },
              { key: 'act', label: '', sortable: false, render: (r) => (r.status === 'pending' ? (
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" title={t('fin.approve')} onClick={() => decide.mutate({ id: r.id, action: 'approve' })}><Check className="size-4 text-success" /></Button>
                  <Button variant="ghost" size="sm" title={t('appr.reject')} onClick={() => decide.mutate({ id: r.id, action: 'reject' })}><X className="size-4 text-destructive" /></Button>
                </div>
              ) : <span className="text-muted-foreground">—</span>) },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

function DocumentsTab() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ documents: EmpDoc[]; count: number }>({ queryKey: ['ess-docs'], queryFn: () => api('/api/hcm/ess/documents') });

  const [docType, setDocType] = useState('certificate');
  const [title, setTitle] = useState('');
  const [fileRef, setFileRef] = useState('');

  const submit = useMutation({
    mutationFn: () => api('/api/hcm/ess/documents', { method: 'POST', body: JSON.stringify({ doc_type: docType, title, file_ref: fileRef || undefined }) }),
    onSuccess: () => { notifySuccess(t('hx.ess.doc_uploaded')); setTitle(''); setFileRef(''); qc.invalidateQueries({ queryKey: ['ess-docs'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const rows = q.data?.documents ?? [];

  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileText className="size-4" /> {t('hx.ess.doc_add_title')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="doc-type">{t('hx.ess.doc_type')}</Label>
              <Select id="doc-type" value={docType} onChange={(e) => setDocType(e.target.value)}>
                <option value="contract">{t('hx.ess.doc_contract')}</option>
                <option value="id_card">{t('hx.ess.doc_id')}</option>
                <option value="certificate">{t('hx.ess.doc_certificate')}</option>
                <option value="tax_form">{t('hx.ess.doc_tax')}</option>
                <option value="other">{t('hr.cat_other')}</option>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="doc-title">{t('hx.ess.doc_title_field')}</Label>
              <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="doc-ref">{t('hx.ess.doc_ref')}</Label>
              <Input id="doc-ref" value={fileRef} onChange={(e) => setFileRef(e.target.value)} placeholder={t('hx.ess.doc_ref_ph')} />
            </div>
          </div>
          <Button disabled={submit.isPending || !title} onClick={() => submit.mutate()}>
            <Plus className="size-4" /> {submit.isPending ? t('hr.submitting') : t('hx.ess.doc_upload_btn')}
          </Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            emptyState={{ icon: FileText, title: t('hx.ess.docs_empty_title'), description: t('hx.ess.docs_empty_desc') }}
            columns={[
              { key: 'doc_type', label: t('hx.ess.doc_type'), render: (r) => <Badge variant="secondary">{r.doc_type}</Badge> },
              { key: 'title', label: t('hx.ess.doc_title_field'), render: (r) => <span className="font-medium">{r.title}</span> },
              { key: 'file_ref', label: t('hx.ess.doc_ref'), render: (r) => r.file_ref ?? '—' },
              { key: 'visibility', label: t('hx.ess.visibility'), render: (r) => <Badge variant="outline">{r.visibility}</Badge> },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

function TeamTab() {
  const { t } = useLang();
  const q = useQuery<{ team: TeamMember[]; count: number; scope: string }>({ queryKey: ['ess-team'], queryFn: () => api('/api/hcm/ess/team') });
  const rows = q.data?.team ?? [];
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable
          rows={rows}
          rowKey={(r) => r.emp_code}
          emptyState={{ icon: Users, title: t('hx.ess.team_empty_title'), description: t('hx.ess.team_empty_desc') }}
          columns={[
            { key: 'emp_code', label: t('hr.emp_code_colon'), render: (r) => <span className="tabular">{r.emp_code}</span> },
            { key: 'name', label: t('hr.full_name'), render: (r) => <span className="font-medium">{r.name}</span> },
            { key: 'position', label: t('hr.position_colon'), render: (r) => r.position ?? '—' },
            { key: 'department', label: t('hr.department_colon'), render: (r) => r.department ?? '—' },
          ]}
        />
      )}
    </StateView>
  );
}
