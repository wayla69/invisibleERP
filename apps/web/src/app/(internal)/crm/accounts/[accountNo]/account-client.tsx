'use client';

// CRM-2 — account (company) island: header + contacts + open deals + a light activity timeline across the
// account's deals. Edit account basics via PATCH; add a contact under this account (duplicate-governed).
import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Building2, Pencil, Plus, Target, Users, History } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { statusVariant } from '@/components/ui';
import { Select } from '@/components/form-controls';

interface Contact { id: number; name: string; email: string | null; phone: string | null; role: string; status: string }
interface AccOpp { opp_no: string; name: string; stage: string; status: string; amount: number; probability: number; owner: string | null; expected_close_date: string | null; created_at: string }
interface AccActivity { id: number; entity_no: string; type: string; subject: string | null; notes: string | null; due_date: string | null; done: boolean; owner: string | null; created_at: string }
interface AccountDetail {
  account_no: string; name: string; tax_id: string | null; industry: string | null; size: string | null;
  email: string | null; phone: string | null; website: string | null; customer_no: string | null;
  status: string; notes: string | null; created_at: string;
  contacts: Contact[]; opportunities: AccOpp[]; recent_activities: AccActivity[]; opportunity_count: number;
}
interface DupMatch { name: string; email: string | null; phone: string | null; reasons: string[] }

const CONTACT_ROLES = ['decision_maker', 'billing', 'technical', 'other'] as const;

export default function AccountClient({ accountNo, initial }: { accountNo: string; initial?: unknown }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<AccountDetail>({
    queryKey: ['crm-account', accountNo],
    queryFn: () => api(`/api/crm/accounts/${encodeURIComponent(accountNo)}`),
    initialData: initial as AccountDetail | undefined,
  });
  const a = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['crm-account', accountNo] });

  // edit basics
  const [editOpen, setEditOpen] = useState(false);
  const [ef, setEf] = useState({ name: '', industry: '', email: '', phone: '', website: '', notes: '' });
  const openEdit = () => { if (!a) return; setEf({ name: a.name, industry: a.industry ?? '', email: a.email ?? '', phone: a.phone ?? '', website: a.website ?? '', notes: a.notes ?? '' }); setEditOpen(true); };
  const update = useMutation({
    mutationFn: () => api(`/api/crm/accounts/${encodeURIComponent(accountNo)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: ef.name, industry: ef.industry || null, email: ef.email || null, phone: ef.phone || null, website: ef.website || null, notes: ef.notes || null }),
    }),
    onSuccess: () => { notifySuccess(t('crmx.toast_account_updated')); setEditOpen(false); refresh(); },
    onError: (e: Error) => notifyError(e.message),
  });

  // add contact under this account (duplicate-governed like the contacts tab)
  const [cOpen, setCOpen] = useState(false);
  const [cf, setCf] = useState({ name: '', email: '', phone: '', role: 'other' });
  const [dups, setDups] = useState<DupMatch[] | null>(null);
  const addContact = useMutation({
    mutationFn: (force: boolean) => api('/api/crm/contacts', {
      method: 'POST',
      body: JSON.stringify({ account_no: accountNo, name: cf.name, email: cf.email || undefined, phone: cf.phone || undefined, role: cf.role, force: force || undefined }),
    }),
    onSuccess: () => { notifySuccess(t('crmx.toast_contact_created')); setCOpen(false); setDups(null); setCf({ name: '', email: '', phone: '', role: 'other' }); refresh(); },
    onError: (e: Error & { code?: string; details?: { matches?: DupMatch[] } }) => {
      if (e.code === 'DUPLICATE_SUSPECT') setDups(e.details?.matches ?? []);
      else notifyError(e.message);
    },
  });

  const openDeals = (a?.opportunities ?? []).filter((o) => o.status === 'Open');
  const closedDeals = (a?.opportunities ?? []).filter((o) => o.status !== 'Open');

  return (
    <div>
      <PageHeader
        title={a?.name ?? accountNo}
        description={a ? `${a.account_no}${a.industry ? ` · ${a.industry}` : ''}${a.customer_no ? ` · ${t('crmx.col_customer_no')}: ${a.customer_no}` : ''}` : ''}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild><Link href="/crm?tab=accounts"><ArrowLeft className="size-4" /> {t('crmx.btn_back_accounts')}</Link></Button>
            <Button variant="outline" onClick={openEdit}><Pencil className="size-4" /> {t('crmx.btn_edit')}</Button>
          </div>
        }
      />
      <StateView q={q}>
        {a && (
          <div className="grid gap-5">
            <Card className="gap-2 p-5">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="flex items-center gap-1.5"><Building2 className="size-4 text-muted-foreground" /> <Badge variant={statusVariant(a.status)}>{a.status}</Badge></span>
                {a.tax_id && <span>{t('crmx.f_tax_id')}: {a.tax_id}</span>}
                {a.email && <span>{a.email}</span>}
                {a.phone && <span>{a.phone}</span>}
                {a.website && <a className="text-primary underline-offset-2 hover:underline" href={a.website.startsWith('http') ? a.website : `https://${a.website}`} target="_blank" rel="noreferrer">{a.website}</a>}
              </div>
              {a.notes && <p className="text-sm text-muted-foreground">{a.notes}</p>}
            </Card>

            <div className="grid gap-5 lg:grid-cols-2">
              {/* deals */}
              <Card className="gap-3 p-5">
                <h3 className="flex items-center gap-2 text-base font-semibold"><Target className="size-4" /> {t('crmx.acc_deals_title', { n: a.opportunity_count })}</h3>
                <DataTable
                  rows={[...openDeals, ...closedDeals]}
                  rowKey={(r) => r.opp_no}
                  columns={[
                    { key: 'name', label: t('crmx.col_deal'), render: (r: AccOpp) => <Link className="text-primary underline-offset-2 hover:underline" href={`/crm/deals/${encodeURIComponent(r.opp_no)}`}>{r.name}</Link> },
                    { key: 'stage', label: t('crmx.col_stage'), render: (r: AccOpp) => <Badge variant={statusVariant(r.status === 'Open' ? r.stage : r.status)}>{r.status === 'Open' ? r.stage : r.status}</Badge> },
                    { key: 'amount', label: t('crmx.col_amount'), align: 'right', render: (r: AccOpp) => <span className="tabular">{baht(r.amount)}</span> },
                    { key: 'owner', label: t('crmx.col_owner'), render: (r: AccOpp) => r.owner ?? '—' },
                  ]}
                  emptyState={{ icon: Target, title: t('crmx.empty_deals_title'), description: t('crmx.empty_deals_desc') }}
                />
              </Card>

              {/* contacts */}
              <Card className="gap-3 p-5">
                <div className="flex items-center justify-between">
                  <h3 className="flex items-center gap-2 text-base font-semibold"><Users className="size-4" /> {t('crmx.acc_contacts_title', { n: a.contacts.length })}</h3>
                  <Button size="sm" variant="outline" onClick={() => { setDups(null); setCOpen(true); }}><Plus className="size-4" /> {t('crmx.btn_new_contact')}</Button>
                </div>
                <DataTable
                  rows={a.contacts}
                  rowKey={(r) => r.id}
                  columns={[
                    { key: 'name', label: t('crmx.f_contact_name') },
                    { key: 'role', label: t('crmx.col_role'), render: (r: Contact) => <Badge variant="secondary">{t(`crmx.role_${r.role}`)}</Badge> },
                    { key: 'email', label: t('crmx.f_email'), render: (r: Contact) => r.email ?? '—' },
                    { key: 'phone', label: t('crmx.f_phone'), render: (r: Contact) => r.phone ?? '—' },
                  ]}
                  emptyState={{ icon: Users, title: t('crmx.empty_contacts_title'), description: t('crmx.empty_contacts_desc') }}
                />
              </Card>
            </div>

            {/* recent activity across the account's deals */}
            <Card className="gap-3 p-5">
              <h3 className="flex items-center gap-2 text-base font-semibold"><History className="size-4" /> {t('crmx.acc_timeline_title')}</h3>
              {a.recent_activities.length ? (
                <div className="grid gap-0.5">
                  {a.recent_activities.map((x) => (
                    <div key={x.id} className="flex items-start gap-3 border-s-2 border-primary/40 ps-3 py-2 text-sm">
                      <Badge variant="secondary">{t(`crmx.act_${x.type}`)}</Badge>
                      <div className="min-w-0 flex-1">
                        <span className="font-medium">{x.subject ?? '—'}</span>
                        <Link className="ms-2 text-xs text-primary underline-offset-2 hover:underline" href={`/crm/deals/${encodeURIComponent(x.entity_no)}`}>{x.entity_no}</Link>
                        <span className="ms-2 text-xs text-muted-foreground">{x.owner ?? ''} · {thaiDate(x.created_at)}</span>
                        {x.notes && <p className="mt-0.5 text-xs text-muted-foreground">{x.notes}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('crmx.timeline_empty')}</p>
              )}
            </Card>
          </div>
        )}
      </StateView>

      {/* edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('crmx.dlg_edit_account')}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>{t('crmx.f_account_name')}</Label><Input value={ef.name} onChange={(e) => setEf({ ...ef, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>{t('crmx.col_industry')}</Label><Input value={ef.industry} onChange={(e) => setEf({ ...ef, industry: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('crmx.f_email')}</Label><Input value={ef.email} onChange={(e) => setEf({ ...ef, email: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('crmx.f_phone')}</Label><Input value={ef.phone} onChange={(e) => setEf({ ...ef, phone: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('crmx.f_website')}</Label><Input value={ef.website} onChange={(e) => setEf({ ...ef, website: e.target.value })} /></div>
            </div>
            <div className="grid gap-1.5"><Label>{t('crmx.f_notes')}</Label><Input value={ef.notes} onChange={(e) => setEf({ ...ef, notes: e.target.value })} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>{t('crmx.btn_cancel')}</Button>
            <Button disabled={!ef.name.trim() || update.isPending} onClick={() => update.mutate()}>{t('crmx.btn_save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* add-contact dialog */}
      <Dialog open={cOpen} onOpenChange={setCOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('crmx.dlg_new_contact')} — {a?.name}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>{t('crmx.f_contact_name')}</Label><Input value={cf.name} onChange={(e) => setCf({ ...cf, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>{t('crmx.f_email')}</Label><Input value={cf.email} onChange={(e) => setCf({ ...cf, email: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('crmx.f_phone')}</Label><Input value={cf.phone} onChange={(e) => setCf({ ...cf, phone: e.target.value })} /></div>
            </div>
            <div className="grid gap-1.5">
              <Label>{t('crmx.col_role')}</Label>
              <Select value={cf.role} onChange={(e) => setCf({ ...cf, role: e.target.value })}>
                {CONTACT_ROLES.map((r) => <option key={r} value={r}>{t(`crmx.role_${r}`)}</option>)}
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCOpen(false)}>{t('crmx.btn_cancel')}</Button>
            <Button disabled={!cf.name.trim() || addContact.isPending} onClick={() => addContact.mutate(false)}><Plus className="size-4" /> {t('crmx.btn_create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* duplicate-suspect dialog */}
      <Dialog open={!!dups} onOpenChange={(o) => !o && setDups(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('crmx.dlg_dup_title')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t('crmx.dup_help')}</p>
          <div className="grid max-h-64 gap-2 overflow-y-auto">
            {(dups ?? []).map((m, i) => (
              <div key={i} className="rounded-md border p-2 text-sm">
                <div className="font-medium">{m.name}</div>
                <div className="text-xs text-muted-foreground">{[m.email, m.phone].filter(Boolean).join(' · ') || '—'}</div>
                <div className="mt-1 flex gap-1">{m.reasons.map((r) => <Badge key={r} variant="warning">{t(`crmx.dup_reason_${r}`)}</Badge>)}</div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDups(null)}>{t('crmx.btn_cancel')}</Button>
            <Button variant="destructive" onClick={() => addContact.mutate(true)}>{t('crmx.btn_force_create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
