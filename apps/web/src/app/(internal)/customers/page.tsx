'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IdCard, SearchX, Plus, Pencil, X } from 'lucide-react';
import { api } from '@/lib/api';
import { num, baht, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifyError, notifySuccess } from '@/lib/notify';
import { ModulePage } from '@/components/module-page';
import { SearchInput } from '@/components/search-input';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { FormField } from '@/components/form-field';
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
  category?: string | null; language?: string | null; external_ref?: string | null;
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
    </ModulePage>
  );
}

const emptyForm = {
  name: '', kind: 'person' as 'person' | 'company', email: '', phone: '', tax_id: '', address: '', branch_code: '',
  credit_terms: '', sales_rep: '', category: '', language: 'th', external_ref: '', notes: '', status: 'active' as 'active' | 'inactive',
};

function CustomerFormDialog({ customer, onClose }: { customer?: Customer; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [form, setForm] = useState(customer ? {
    name: customer.name, kind: (customer.kind as 'person' | 'company') ?? 'person', email: customer.email ?? '', phone: customer.phone ?? '',
    tax_id: customer.tax_id ?? '', address: customer.address ?? '', branch_code: customer.branch_code ?? '',
    credit_terms: customer.credit_terms ?? '', sales_rep: customer.sales_rep ?? '', category: customer.category ?? '',
    language: customer.language ?? 'th', external_ref: customer.external_ref ?? '', notes: customer.notes ?? '',
    status: (customer.status as 'active' | 'inactive') ?? 'active',
  } : emptyForm);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: () => customer
      ? api<any>(`/api/customer-master/${customer.customer_no}`, { method: 'PATCH', body: JSON.stringify(form) })
      : api<any>('/api/customer-master', { method: 'POST', body: JSON.stringify(form) }),
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
  const q = useQuery<any>({ queryKey: ['customer-360', customerNo], queryFn: () => api(`/api/customer-master/${customerNo}/360`) });
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
            </div>
          )}
        </StateView>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}><X className="size-4" /> {t('fin.cancel')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
