'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IdCard, SearchX, Plus, Pencil, X, MapPin, Contact, Trash2, Building2, GitMerge, History } from 'lucide-react';
import { api } from '@/lib/api';
import { num, baht, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifyError, notifySuccess } from '@/lib/notify';
import { ModulePage } from '@/components/module-page';
import { SearchInput } from '@/components/search-input';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { FormField } from '@/components/form-field';
import { ChangeHistorySection } from '@/components/change-history-section';
import { ProvinceInput } from '@/components/province-input';
import { PartyRelationshipsSection } from '@/components/party-relationships';
import { CustomFieldsSection } from '@/components/custom-fields-section';

const CUSTOMER_REL_TYPES = ['bill_to', 'ship_to', 'sold_to', 'guarantor', 'related_party', 'subsidiary', 'franchisee', 'other'] as const;
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Customer {
  customer_no: string; name: string; kind: string; email?: string | null; phone?: string | null; tax_id?: string | null;
  address?: string | null; branch_code?: string | null; account_code?: string | null; member_id?: number | null;
  status: string; notes?: string | null; credit_terms?: string | null; sales_rep?: string | null;
  category?: string | null; language?: string | null; external_ref?: string | null; parent_customer_no?: string | null;
}

interface CustomerAddress {
  id: number; address_type: string; address_line1?: string | null; address_line2?: string | null;
  sub_district?: string | null; district?: string | null; province?: string | null; postal_code?: string | null;
  is_primary: boolean;
}
interface CustomerContact {
  id: number; name: string; title?: string | null; phone?: string | null; email?: string | null; notes?: string | null; is_primary: boolean;
}

// Unified customer master (REV-14/15) — the customer-of-record joining the B2C loyalty and B2B account
// silos. Previously had no interactive CRUD screen at all (only invoice-issuance auto-upsert + a member/
// account link endpoint); this screen adds list/create/edit + the existing 360° view.
export default function CustomersPage() {
  const { t } = useLang();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [dedup, setDedup] = useState(false);
  const q = useQuery<{ customers: Customer[] }>({ queryKey: ['customer-master', search], queryFn: () => api(`/api/customer-master${search ? `?search=${encodeURIComponent(search)}` : ''}`) });
  const rows = q.data?.customers ?? [];

  const filtered = useMemo(() => rows, [rows]);

  return (
    <ModulePage
      title={t('mx.cm_title')}
      description={t('mx.cm_subtitle')}
      query={q}
      toolbar={
        <div className="flex items-center gap-2">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t('mx.cm_search_ph')}
            ariaLabel={t('mx.cm_search_aria')}
            count={q.data ? t('mx.cm_count', { n: num(filtered.length) }) : undefined}
          />
          <Button variant="outline" onClick={() => setDedup(true)}><GitMerge className="size-4" /> {t('mx.cm_dedup')}</Button>
          <Button onClick={() => setCreating(true)}><Plus className="size-4" /> {t('mx.cm_add')}</Button>
        </div>
      }
    >
      {q.data && (
        <DataTable
          rows={filtered}
          rowKey={(r) => r.customer_no}
          onRowClick={(r) => setViewing(r.customer_no)}
          emptyState={
            search
              ? { icon: SearchX, title: t('mx.cm_no_match'), description: t('mx.cm_no_match_desc') }
              : { icon: IdCard, title: t('mx.cm_empty_title'), description: t('mx.cm_empty_desc') }
          }
          columns={[
            { key: 'customer_no', label: t('mx.cm_col_no') },
            { key: 'name', label: t('mx.cm_col_name') },
            { key: 'kind', label: t('mx.cm_col_kind'), render: (r) => r.kind === 'company' ? t('mx.cm_kind_company') : t('mx.cm_kind_person') },
            { key: 'phone', label: t('mx.cm_col_phone'), render: (r) => r.phone || '—' },
            { key: 'category', label: t('mx.cm_col_category'), render: (r) => r.category || '—' },
            { key: 'sales_rep', label: t('mx.cm_col_sales_rep'), render: (r) => r.sales_rep || '—' },
            { key: 'credit_terms', label: t('mx.cm_col_credit_terms'), render: (r) => r.credit_terms || '—' },
            { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={r.status === 'inactive' ? 'destructive' : 'success'}>{r.status === 'inactive' ? t('mx.cm_status_inactive') : t('mx.cm_status_active')}</Badge> },
            {
              key: 'actions', label: '', sortable: false,
              render: (r) => <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setEditing(r); }}><Pencil className="size-4" /> {t('mx.cm_edit')}</Button>,
            },
          ]}
        />
      )}
      {creating && <CustomerFormDialog onClose={() => setCreating(false)} />}
      {editing && <CustomerFormDialog customer={editing} onClose={() => setEditing(null)} />}
      {viewing && <Customer360Panel customerNo={viewing} onClose={() => setViewing(null)} />}
      {dedup && <CustomerDuplicatesDialog onClose={() => setDedup(false)} />}
    </ModulePage>
  );
}

// Match-merge / DQM (master-data audit Phase 5) — a steward review queue for probable duplicate customers
// (exact tax-id/email/phone + fuzzy name). Merging repoints the duplicate's child rows onto the survivor and
// soft-retires the duplicate; the historical record is preserved (status='merged'), never destroyed.
function CustomerDuplicatesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ groups: any[]; count: number }>({ queryKey: ['customer-duplicates'], queryFn: () => api('/api/customer-master/duplicates') });
  const merge = useMutation({
    mutationFn: ({ survivor, duplicate }: { survivor: string; duplicate: string }) => api<any>(`/api/customer-master/${survivor}/merge`, { method: 'POST', body: JSON.stringify({ duplicate_customer_no: duplicate }) }),
    onSuccess: () => { notifySuccess(t('mx.cm_merged')); q.refetch(); qc.invalidateQueries({ queryKey: ['customer-master'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('mx.cm_dedup_title')}</DialogTitle>
          <DialogDescription>{t('mx.cm_dedup_desc')}</DialogDescription>
        </DialogHeader>
        <StateView q={q}>
          {q.data && (q.data.groups.length === 0
            ? <p className="py-6 text-center text-sm text-muted-foreground">{t('mx.cm_dedup_none')}</p>
            : (
              <div className="grid max-h-[60vh] gap-3 overflow-y-auto">
                {q.data.groups.map((g) => (
                  <Card key={g.primary.customer_no} className="p-3 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge variant="success" className="text-xs">{t('mx.cm_dedup_keep')}</Badge>
                      <span className="font-medium">{g.primary.name}</span>
                      <span className="text-muted-foreground">{g.primary.customer_no}</span>
                    </div>
                    <div className="mt-2 grid gap-2">
                      {g.duplicates.map((d: any) => (
                        <div key={d.customer_no} className="flex items-center gap-2 rounded-md border border-border/60 p-2">
                          <div className="flex-1">
                            <div className="font-medium">{d.name} <span className="font-normal text-muted-foreground">{d.customer_no}</span></div>
                            <div className="mt-0.5 flex flex-wrap gap-1">
                              {d.reasons.map((r: string) => <Badge key={r} variant="secondary" className="text-xs">{t(`mx.cm_dedup_reason_${r}` as any)}</Badge>)}
                              <Badge variant="outline" className="text-xs">{Math.round(d.score * 100)}%</Badge>
                            </div>
                          </div>
                          <Button size="sm" variant="outline" disabled={merge.isPending} onClick={() => { if (window.confirm(t('mx.cm_merge_confirm', { dup: d.name, keep: g.primary.name }))) merge.mutate({ survivor: g.primary.customer_no, duplicate: d.customer_no }); }}>
                            <GitMerge className="size-4" /> {t('mx.cm_merge')}
                          </Button>
                        </div>
                      ))}
                    </div>
                  </Card>
                ))}
              </div>
            ))}
        </StateView>
        <DialogFooter><Button variant="outline" onClick={onClose}><X className="size-4" /> {t('fin.cancel')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const emptyForm = {
  name: '', kind: 'person' as 'person' | 'company', email: '', phone: '', tax_id: '', address: '', branch_code: '',
  credit_terms: '', sales_rep: '', category: '', language: 'th', external_ref: '', notes: '', status: 'active' as 'active' | 'inactive',
  parent_customer_no: '',
};

function CustomerFormDialog({ customer, onClose }: { customer?: Customer; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [form, setForm] = useState(customer ? {
    name: customer.name, kind: (customer.kind as 'person' | 'company') ?? 'person', email: customer.email ?? '', phone: customer.phone ?? '',
    tax_id: customer.tax_id ?? '', address: customer.address ?? '', branch_code: customer.branch_code ?? '',
    credit_terms: customer.credit_terms ?? '', sales_rep: customer.sales_rep ?? '', category: customer.category ?? '',
    language: customer.language ?? 'th', external_ref: customer.external_ref ?? '', notes: customer.notes ?? '',
    status: (customer.status as 'active' | 'inactive') ?? 'active', parent_customer_no: customer.parent_customer_no ?? '',
  } : emptyForm);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: async () => {
      const { parent_customer_no, ...body } = form;
      const r = customer
        ? await api<any>(`/api/customer-master/${customer.customer_no}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await api<any>('/api/customer-master', { method: 'POST', body: JSON.stringify(body) });
      if (customer && parent_customer_no !== (customer.parent_customer_no ?? '')) {
        await api<any>(`/api/customer-master/${customer.customer_no}/parent`, { method: 'PATCH', body: JSON.stringify({ parent_customer_no: parent_customer_no || null }) });
      }
      return r;
    },
    onSuccess: () => { notifySuccess(customer ? t('mx.cm_saved') : t('mx.cm_created')); qc.invalidateQueries({ queryKey: ['customer-master'] }); onClose(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{customer ? customer.name : t('mx.cm_add')}</DialogTitle>
          <DialogDescription>{t('mx.cm_dialog_desc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('mx.cm_col_name')} required><Input value={form.name} onChange={set('name')} /></FormField>
          <FormField label={t('mx.cm_col_kind')}>
            <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v as 'person' | 'company' }))}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="person">{t('mx.cm_kind_person')}</SelectItem>
                <SelectItem value="company">{t('mx.cm_kind_company')}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField label={t('mx.cm_col_phone')}><Input value={form.phone} onChange={set('phone')} /></FormField>
          <FormField label={t('mx.vp_col_email')}><Input type="email" value={form.email} onChange={set('email')} /></FormField>
          <FormField label={t('mx.setup_f_tax_id')}><Input value={form.tax_id} onChange={set('tax_id')} /></FormField>
          <FormField label={t('mx.setup_f_branch_code')}><Input value={form.branch_code} onChange={set('branch_code')} placeholder="00000" /></FormField>
          <FormField label={t('mx.vp_f_address')} className="sm:col-span-2"><Input value={form.address} onChange={set('address')} /></FormField>
          <FormField label={t('mx.cm_col_credit_terms')}><Input value={form.credit_terms} onChange={set('credit_terms')} placeholder="Net 30" /></FormField>
          <FormField label={t('mx.cm_col_sales_rep')}><Input value={form.sales_rep} onChange={set('sales_rep')} /></FormField>
          <FormField label={t('mx.cm_col_category')}><Input value={form.category} onChange={set('category')} /></FormField>
          <FormField label={t('mx.cm_f_language')}>
            <Select value={form.language} onValueChange={(v) => setForm((f) => ({ ...f, language: v }))}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="th">ไทย</SelectItem>
                <SelectItem value="en">English</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField label={t('mx.cm_f_external_ref')}><Input value={form.external_ref} onChange={set('external_ref')} /></FormField>
          {customer && (
            <FormField label={t('mx.cm_f_parent')} hint={t('mx.cm_f_parent_hint')}>
              <Input value={form.parent_customer_no} onChange={set('parent_customer_no')} placeholder={t('mx.cm_f_parent_ph')} />
            </FormField>
          )}
          {customer && (
            <FormField label={t('mx.cm_col_status')}>
              <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as 'active' | 'inactive' }))}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t('mx.cm_status_active')}</SelectItem>
                  <SelectItem value="inactive">{t('mx.cm_status_inactive')}</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
          <FormField label={t('mx.vp_f_notes')} className="sm:col-span-2"><Input value={form.notes} onChange={set('notes')} /></FormField>
        </div>
        <DialogFooter>
          <Button disabled={!form.name || save.isPending} onClick={() => save.mutate()}>{customer ? t('mx.cm_save') : t('mx.cm_create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Customer360Panel({ customerNo, onClose }: { customerNo: string; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['customer-360', customerNo], queryFn: () => api(`/api/customer-master/${customerNo}/360`) });
  const [addingAddress, setAddingAddress] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['customer-360', customerNo] });

  const deleteAddress = useMutation({
    mutationFn: (id: number) => api<any>(`/api/customer-master/${customerNo}/addresses/${id}`, { method: 'DELETE' }),
    onSuccess: () => { notifySuccess(t('mx.cm_addr_deleted')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const deleteContact = useMutation({
    mutationFn: (id: number) => api<any>(`/api/customer-master/${customerNo}/contacts/${id}`, { method: 'DELETE' }),
    onSuccess: () => { notifySuccess(t('mx.cm_contact_deleted')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{q.data?.customer?.name ?? customerNo}</DialogTitle>
          <DialogDescription>{customerNo}</DialogDescription>
        </DialogHeader>
        <StateView q={q}>
          {q.data && (
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <Card className="p-3"><div className="text-xs text-muted-foreground">{t('mx.cm_360_lifetime')}</div><div className="tabular text-base font-semibold">{baht(q.data.summary?.sales_lifetime ?? 0)}</div></Card>
                <Card className="p-3"><div className="text-xs text-muted-foreground">{t('mx.cm_360_ar')}</div><div className="tabular text-base font-semibold">{baht(q.data.summary?.ar_outstanding ?? 0)}</div></Card>
                <Card className="p-3"><div className="text-xs text-muted-foreground">{t('mx.cm_360_loyalty')}</div><div className="text-base font-semibold">{q.data.loyalty ? `${q.data.loyalty.tier} · ${num(q.data.loyalty.points_balance)} pts` : '—'}</div></Card>
              </div>
              {q.data.parent && (
                <Card className="flex items-center gap-2 p-3 text-sm">
                  <Building2 className="size-4 text-muted-foreground" />
                  <span className="text-muted-foreground">{t('mx.cm_360_parent')}:</span>
                  <span className="font-medium">{q.data.parent.name}</span>
                  <span className="text-muted-foreground">({q.data.parent.customer_no})</span>
                </Card>
              )}
              {q.data.b2b?.orders?.length > 0 && (
                <DataTable
                  rows={q.data.b2b.orders}
                  dense
                  columns={[
                    { key: 'Sale_No', label: t('dash.col_no') },
                    { key: 'Sale_Date', label: t('dash.col_date'), render: (r: any) => thaiDate(r.Sale_Date) },
                    { key: 'Total', label: t('fin.col_amount'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.Total)}</span> },
                    { key: 'Status', label: t('fin.col_status') },
                  ]}
                />
              )}
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <h4 className="flex items-center gap-1.5 text-sm font-medium"><MapPin className="size-4" /> {t('mx.cm_addresses')}</h4>
                  <Button size="sm" variant="outline" onClick={() => setAddingAddress(true)}><Plus className="size-3.5" /> {t('mx.cm_add_address')}</Button>
                </div>
                {(q.data.addresses ?? []).length === 0 && <p className="text-xs text-muted-foreground">{t('mx.cm_no_addresses')}</p>}
                {(q.data.addresses as CustomerAddress[] ?? []).map((a) => (
                  <div key={a.id} className="flex items-start gap-2 rounded-md border border-border/60 p-2.5 text-sm">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="text-xs">{t(`mx.cm_addr_type_${a.address_type}` as any)}</Badge>
                        {a.is_primary && <Badge variant="success" className="text-xs">{t('mx.cm_primary')}</Badge>}
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {[a.address_line1, a.address_line2, a.sub_district, a.district, a.province, a.postal_code].filter(Boolean).join(' ') || '—'}
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" className="size-7" aria-label={t('mx.cm_delete')} onClick={() => deleteAddress.mutate(a.id)}><Trash2 className="size-4" /></Button>
                  </div>
                ))}
              </div>
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <h4 className="flex items-center gap-1.5 text-sm font-medium"><Contact className="size-4" /> {t('mx.cm_contacts')}</h4>
                  <Button size="sm" variant="outline" onClick={() => setAddingContact(true)}><Plus className="size-3.5" /> {t('mx.cm_add_contact')}</Button>
                </div>
                {(q.data.contacts ?? []).length === 0 && <p className="text-xs text-muted-foreground">{t('mx.cm_no_contacts')}</p>}
                {(q.data.contacts as CustomerContact[] ?? []).map((c) => (
                  <div key={c.id} className="flex items-start gap-2 rounded-md border border-border/60 p-2.5 text-sm">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{c.name}</span>
                        {c.title && <span className="text-muted-foreground">· {c.title}</span>}
                        {c.is_primary && <Badge variant="success" className="text-xs">{t('mx.cm_primary')}</Badge>}
                      </div>
                      <div className="mt-1 text-muted-foreground">{[c.phone, c.email].filter(Boolean).join(' · ') || '—'}</div>
                    </div>
                    <Button variant="ghost" size="icon" className="size-7" aria-label={t('mx.cm_delete')} onClick={() => deleteContact.mutate(c.id)}><Trash2 className="size-4" /></Button>
                  </div>
                ))}
              </div>
              <PartyRelationshipsSection
                listUrl={`/api/customer-master/${customerNo}/relationships`}
                addUrl={`/api/customer-master/${customerNo}/relationships`}
                deleteBase={`/api/customer-master/${customerNo}/relationships`}
                queryKey={['customer-relationships', customerNo]}
                relTypes={CUSTOMER_REL_TYPES}
                targetPlaceholder={t('mx.rel_target_customer')}
                buildBody={(target, relType) => ({ to_customer_no: target, rel_type: relType })}
              />
              <CustomFieldsSection entity="customer" recordId={customerNo} />
              <ChangeHistorySection url={`/api/customer-master/${customerNo}/history`} queryKey={['customer-history', customerNo]} />
            </div>
          )}
        </StateView>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}><X className="size-4" /> {t('fin.cancel')}</Button>
        </DialogFooter>
      </DialogContent>
      {addingAddress && <AddressFormDialog customerNo={customerNo} onClose={() => setAddingAddress(false)} onSaved={refresh} />}
      {addingContact && <ContactFormDialog customerNo={customerNo} onClose={() => setAddingContact(false)} onSaved={refresh} />}
    </Dialog>
  );
}

function AddressFormDialog({ customerNo, onClose, onSaved }: { customerNo: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  const [form, setForm] = useState({ address_type: 'other' as 'billing' | 'shipping' | 'registered' | 'other', address_line1: '', address_line2: '', sub_district: '', district: '', province: '', postal_code: '', is_primary: false });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => api<any>(`/api/customer-master/${customerNo}/addresses`, { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => { notifySuccess(t('mx.cm_address_added')); onSaved(); onClose(); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('mx.cm_add_address')}</DialogTitle></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('mx.cm_col_kind')}>
            <Select value={form.address_type} onValueChange={(v) => setForm((f) => ({ ...f, address_type: v as typeof form.address_type }))}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="billing">{t('mx.cm_addr_type_billing')}</SelectItem>
                <SelectItem value="shipping">{t('mx.cm_addr_type_shipping')}</SelectItem>
                <SelectItem value="registered">{t('mx.cm_addr_type_registered')}</SelectItem>
                <SelectItem value="other">{t('mx.cm_addr_type_other')}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField label={t('mx.cm_f_is_primary')}>
            <Select value={form.is_primary ? '1' : '0'} onValueChange={(v) => setForm((f) => ({ ...f, is_primary: v === '1' }))}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="0">{t('mx.cm_no')}</SelectItem><SelectItem value="1">{t('mx.cm_yes')}</SelectItem></SelectContent>
            </Select>
          </FormField>
          <FormField label={t('mx.cm_f_address_line1')} className="sm:col-span-2"><Input value={form.address_line1} onChange={set('address_line1')} /></FormField>
          <FormField label={t('mx.cm_f_address_line2')} className="sm:col-span-2"><Input value={form.address_line2} onChange={set('address_line2')} /></FormField>
          <FormField label={t('mx.cm_f_sub_district')}><Input value={form.sub_district} onChange={set('sub_district')} /></FormField>
          <FormField label={t('mx.cm_f_district')}><Input value={form.district} onChange={set('district')} /></FormField>
          <FormField label={t('mx.cm_f_province')}><ProvinceInput value={form.province} onChange={(v) => setForm((f) => ({ ...f, province: v }))} placeholder={t('mx.cm_f_province_ph')} /></FormField>
          <FormField label={t('mx.cm_f_postal_code')}><Input inputMode="numeric" maxLength={5} value={form.postal_code} onChange={set('postal_code')} placeholder="10230" /></FormField>
        </div>
        <DialogFooter><Button disabled={save.isPending} onClick={() => save.mutate()}>{t('mx.cm_save')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ContactFormDialog({ customerNo, onClose, onSaved }: { customerNo: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  const [form, setForm] = useState({ name: '', title: '', phone: '', email: '', notes: '', is_primary: false });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => api<any>(`/api/customer-master/${customerNo}/contacts`, { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => { notifySuccess(t('mx.cm_contact_added')); onSaved(); onClose(); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('mx.cm_add_contact')}</DialogTitle></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('mx.cm_col_name')} required><Input value={form.name} onChange={set('name')} /></FormField>
          <FormField label={t('mx.cm_f_contact_title')}><Input value={form.title} onChange={set('title')} /></FormField>
          <FormField label={t('mx.cm_col_phone')}><Input value={form.phone} onChange={set('phone')} /></FormField>
          <FormField label={t('mx.vp_col_email')}><Input type="email" value={form.email} onChange={set('email')} /></FormField>
          <FormField label={t('mx.cm_f_is_primary')}>
            <Select value={form.is_primary ? '1' : '0'} onValueChange={(v) => setForm((f) => ({ ...f, is_primary: v === '1' }))}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="0">{t('mx.cm_no')}</SelectItem><SelectItem value="1">{t('mx.cm_yes')}</SelectItem></SelectContent>
            </Select>
          </FormField>
          <FormField label={t('mx.vp_f_notes')} className="sm:col-span-2"><Input value={form.notes} onChange={set('notes')} /></FormField>
        </div>
        <DialogFooter><Button disabled={!form.name || save.isPending} onClick={() => save.mutate()}>{t('mx.cm_save')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
