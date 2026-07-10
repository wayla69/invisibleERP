'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SearchX, Truck, Landmark, ShieldAlert, Pencil, MapPin, Contact, Trash2, Building2, Plus, GitMerge, X } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { useMe, hasPerm } from '@/lib/auth';
import { notifyError, notifySuccess } from '@/lib/notify';
import { ModulePage } from '@/components/module-page';
import { SearchInput } from '@/components/search-input';
import { DataTable } from '@/components/data-table';
import { FormField } from '@/components/form-field';
import { ChangeHistorySection } from '@/components/change-history-section';
import { ProvinceInput } from '@/components/province-input';
import { PartyRelationshipsSection } from '@/components/party-relationships';
import { CustomFieldsSection } from '@/components/custom-fields-section';
import { MasterIo } from '@/components/master-io';

const VENDOR_REL_TYPES = ['related_party', 'subsidiary', 'franchisee', 'subcontractor', 'parent', 'other'] as const;
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Supplier {
  Vendor_ID: number; Supplier_ID: string; Supplier_Name?: string; Contact_Person?: string; Phone?: string; Email?: string | null;
  Payment_Terms?: string; Bank_Name?: string | null; Bank_Account?: string | null;
  Address?: string | null; Rating?: number | string | null; Category?: string | null; Currency?: string | null;
  Lead_Time_Days?: number | null; Notes?: string | null;
  Approval_Status?: string; Blocklisted?: boolean; Blocklist_Reason?: string | null;
  parent_vendor_id?: number | null;
}

interface VendorAddress {
  id: number; address_type: string; address_line1?: string | null; address_line2?: string | null;
  sub_district?: string | null; district?: string | null; province?: string | null; postal_code?: string | null;
  is_primary: boolean;
}
interface VendorContact {
  id: number; name: string; title?: string | null; phone?: string | null; email?: string | null; notes?: string | null; is_primary: boolean;
}

export default function SuppliersPage() {
  const { t } = useLang();
  const { data: me } = useMe();
  const canEditBank = hasPerm(me, 'md_vendor');
  const q = useQuery<{ suppliers: Supplier[] }>({ queryKey: ['suppliers'], queryFn: () => api('/api/inventory/suppliers') });
  const rows = q.data?.suppliers ?? [];
  const [search, setSearch] = useState('');
  const [editingBank, setEditingBank] = useState<Supplier | null>(null);
  const [editingProfile, setEditingProfile] = useState<Supplier | null>(null);
  const [editingParty, setEditingParty] = useState<Supplier | null>(null);
  const [dedup, setDedup] = useState(false);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) => [r.Supplier_ID, r.Supplier_Name, r.Contact_Person, r.Phone].some((v) => (v ?? '').toLowerCase().includes(term)));
  }, [rows, search]);

  return (
    <ModulePage
      title={t('inv.suppliers_title')}
      description={t('inv.suppliers_subtitle')}
      query={q}
      toolbar={
        <div className="flex items-center gap-2">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t('inv.suppliers_search_ph')}
            ariaLabel={t('inv.suppliers_search_aria')}
            count={
              q.data
                ? (search && filtered.length !== rows.length
                    ? t('inv.suppliers_count_of', { n: num(filtered.length), total: num(rows.length) })
                    : t('inv.suppliers_count', { n: num(filtered.length) }))
                : undefined
            }
          />
          {canEditBank && <Button variant="outline" onClick={() => setDedup(true)}><GitMerge className="size-4" /> {t('mx.cm_dedup')}</Button>}
        </div>
      }
    >
      <VendorBankApprovals />
      {q.data && (
        <DataTable
          rows={filtered}
          rowKey={(r) => r.Supplier_ID}
          emptyState={
            search
              ? {
                  icon: SearchX,
                  title: t('inv.no_match_suppliers'),
                  description: t('inv.no_match_desc'),
                  action: (
                    <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                      {t('inv.clear_filter')}
                    </Button>
                  ),
                }
              : { icon: Truck, title: t('inv.suppliers_empty_title'), description: t('inv.suppliers_empty_desc') }
          }
          columns={[
            { key: 'Supplier_ID', label: t('inv.col_code') },
            { key: 'Supplier_Name', label: t('inv.col_name2'), render: (r) => r.Supplier_Name || '—' },
            { key: 'Contact_Person', label: t('inv.col_contact'), render: (r) => r.Contact_Person || '—' },
            { key: 'Phone', label: t('inv.col_phone'), render: (r) => r.Phone || '—' },
            { key: 'Email', label: t('mx.vp_col_email'), render: (r) => r.Email || '—' },
            { key: 'Payment_Terms', label: t('inv.col_terms'), render: (r) => r.Payment_Terms || '—' },
            {
              key: 'Approval_Status',
              label: t('mx.vp_col_status'),
              render: (r) => (
                <Badge variant={r.Blocklisted ? 'destructive' : r.Approval_Status === 'pending' ? 'warning' : 'success'}>
                  {r.Blocklisted ? t('mx.vp_status_blocked') : r.Approval_Status === 'pending' ? t('mx.vp_status_pending') : t('mx.vp_status_approved')}
                </Badge>
              ),
            },
            {
              key: 'Bank_Account',
              label: t('mx.vbc_col_bank'),
              render: (r) => (
                <div className="flex items-center gap-2">
                  <span className="text-sm">{r.Bank_Name || r.Bank_Account ? `${r.Bank_Name ?? '—'} · ${r.Bank_Account ?? '—'}` : t('mx.vbc_no_bank')}</span>
                  {canEditBank && (
                    <Button variant="ghost" size="icon" className="size-7" aria-label={t('mx.vbc_edit_bank')} onClick={() => setEditingBank(r)}>
                      <Landmark className="size-4" />
                    </Button>
                  )}
                </div>
              ),
            },
            ...(canEditBank ? [{
              key: 'actions', label: '', sortable: false,
              render: (r: Supplier) => (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditingProfile(r)}><Pencil className="size-4" /> {t('mx.vp_edit')}</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingParty(r)}><Building2 className="size-4" /> {t('mx.vp_party')}</Button>
                </div>
              ),
            }] : []),
          ]}
        />
      )}
      {/* Bulk import/export of the vendor/supplier master — reuses the master-data registry engine (entity
          `vendors`); gated to the coarse `masterdata` setup duty the /api/admin/master-data endpoints require. */}
      {hasPerm(me, 'masterdata') && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground">{t('mdio.section_title')}</h3>
          <MasterIo entityKey="vendors" base="admin" onImported={() => q.refetch()} />
        </div>
      )}
      {editingBank && <BankChangeDialog vendor={editingBank} onClose={() => setEditingBank(null)} />}
      {editingProfile && <ProfileDialog vendor={editingProfile} onClose={() => setEditingProfile(null)} />}
      {editingParty && <VendorPartyPanel vendor={editingParty} onClose={() => setEditingParty(null)} />}
      {dedup && <VendorDuplicatesDialog onClose={() => setDedup(false)} />}
    </ModulePage>
  );
}

// Match-merge / DQM (master-data audit Phase 5) — steward review queue for probable duplicate vendors.
// Merging repoints the duplicate's child rows (POs, AP txns, addresses, …) onto the survivor and soft-retires
// the duplicate (active=false); the record is preserved, never destroyed.
function VendorDuplicatesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [mergeAsk, setMergeAsk] = useState<{ survivor: number; duplicate: number; dup: string; keep: string } | null>(null);
  const q = useQuery<{ groups: any[]; count: number }>({ queryKey: ['vendor-duplicates'], queryFn: () => api('/api/procurement/vendors/duplicates') });
  const merge = useMutation({
    mutationFn: ({ survivor, duplicate }: { survivor: number; duplicate: number }) => api<any>(`/api/procurement/vendors/${survivor}/merge`, { method: 'POST', body: JSON.stringify({ duplicate_vendor_id: duplicate }) }),
    onSuccess: () => { notifySuccess(t('mx.cm_merged')); q.refetch(); qc.invalidateQueries({ queryKey: ['suppliers'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('mx.cm_dedup_title')}</DialogTitle>
          <DialogDescription>{t('mx.vp_dedup_desc')}</DialogDescription>
        </DialogHeader>
        {q.data && (q.data.groups.length === 0
          ? <p className="py-6 text-center text-sm text-muted-foreground">{t('mx.cm_dedup_none')}</p>
          : (
            <div className="grid max-h-[60vh] gap-3 overflow-y-auto">
              {q.data.groups.map((g) => (
                <Card key={g.primary.vendor_id} className="p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant="success" className="text-xs">{t('mx.cm_dedup_keep')}</Badge>
                    <span className="font-medium">{g.primary.name}</span>
                    {g.primary.vendor_code && <span className="text-muted-foreground">{g.primary.vendor_code}</span>}
                  </div>
                  <div className="mt-2 grid gap-2">
                    {g.duplicates.map((d: any) => (
                      <div key={d.vendor_id} className="flex items-center gap-2 rounded-md border border-border/60 p-2">
                        <div className="flex-1">
                          <div className="font-medium">{d.name} {d.vendor_code && <span className="font-normal text-muted-foreground">{d.vendor_code}</span>}</div>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            {d.reasons.map((r: string) => <Badge key={r} variant="secondary" className="text-xs">{t(`mx.cm_dedup_reason_${r}` as any)}</Badge>)}
                            <Badge variant="outline" className="text-xs">{Math.round(d.score * 100)}%</Badge>
                          </div>
                        </div>
                        <Button size="sm" variant="outline" disabled={merge.isPending} onClick={() => setMergeAsk({ survivor: g.primary.vendor_id, duplicate: d.vendor_id, dup: d.name, keep: g.primary.name })}>
                          <GitMerge className="size-4" /> {t('mx.cm_merge')}
                        </Button>
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          ))}
        <ConfirmDialog
          open={!!mergeAsk}
          onOpenChange={(o) => !o && setMergeAsk(null)}
          title={t('mx.cm_merge')}
          description={mergeAsk ? t('mx.cm_merge_confirm', { dup: mergeAsk.dup, keep: mergeAsk.keep }) : null}
          busy={merge.isPending}
          onConfirm={() => { if (mergeAsk) merge.mutate({ survivor: mergeAsk.survivor, duplicate: mergeAsk.duplicate }); setMergeAsk(null); }}
        />
        <DialogFooter><Button variant="outline" onClick={onClose}><X className="size-4" /> {t('fin.cancel')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 0270 — a vendor's payee bank details change only after a DISTINCT exec/approvals user releases the staged
// request (closes a BEC/vendor-payment-fraud gap). Mirrors setup/page.tsx's tenant-profile ProfileApprovals.
function BankChangeDialog({ vendor, onClose }: { vendor: Supplier; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [bankName, setBankName] = useState(vendor.Bank_Name ?? '');
  const [bankAccount, setBankAccount] = useState(vendor.Bank_Account ?? '');
  // Governed bank master (Phase 9) — steer bank_name to the canonical Thai-banks list; server normalises too.
  const banksQ = useQuery<{ banks: { code: string; th: string; en: string }[] }>({ queryKey: ['geo-banks'], queryFn: () => api('/api/geo/banks'), staleTime: Infinity });
  const stage = useMutation({
    mutationFn: () => api<any>(`/api/procurement/vendors/${vendor.Vendor_ID}/bank`, {
      method: 'PATCH',
      body: JSON.stringify({ bank_name: bankName || undefined, bank_account: bankAccount || undefined }),
    }),
    onSuccess: () => { notifySuccess(t('mx.vbc_staged')); qc.invalidateQueries({ queryKey: ['vendor-bank-approvals'] }); onClose(); },
    onError: (e: any) => notifyError(e.message ?? t('mx.vbc_stage_failed')),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('mx.vbc_dialog_title')}</DialogTitle>
          <DialogDescription>{t('mx.vbc_dialog_desc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('mx.vbc_f_bank_name')} htmlFor="vbc-bank-name">
            <Input id="vbc-bank-name" list="th-banks-list" value={bankName} onChange={(e) => setBankName(e.target.value)} />
            <datalist id="th-banks-list">{(banksQ.data?.banks ?? []).map((b) => <option key={b.code} value={b.th}>{b.en}</option>)}</datalist>
          </FormField>
          <FormField label={t('mx.vbc_f_bank_account')} htmlFor="vbc-bank-account">
            <Input id="vbc-bank-account" value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} />
          </FormField>
        </div>
        <DialogFooter>
          <Button disabled={stage.isPending} onClick={() => stage.mutate()}>{t('mx.vbc_submit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VendorBankApprovals() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ pending: { req_no: string; vendor_id: number; vendor_name: string; bank_name: string | null; bank_account: string | null; prev_bank_name: string | null; prev_bank_account: string | null; requested_by: string }[] }>({
    queryKey: ['vendor-bank-approvals'], queryFn: () => api('/api/procurement/vendor-bank-changes'),
  });
  const decide = useMutation({
    mutationFn: ({ reqNo, action }: { reqNo: string; action: 'approve' | 'reject' }) => api<any>(`/api/procurement/vendor-bank-changes/${reqNo}/${action}`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (_r, v) => { notifySuccess(v.action === 'approve' ? t('mx.vbc_appr_approved') : t('mx.vbc_appr_rejected')); q.refetch(); qc.invalidateQueries({ queryKey: ['suppliers'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const rows = q.data?.pending ?? [];
  if (!rows.length) return null;
  return (
    <Card className="border-amber-300 dark:border-amber-700">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldAlert className="size-4" /> {t('mx.vbc_appr_title')}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">{t('mx.vbc_appr_desc')}</p>
        {rows.map((r) => (
          <div key={r.req_no} className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-2.5 text-sm">
            <span className="font-medium">{r.vendor_name}</span>
            <span>
              <span className="text-muted-foreground">{r.prev_bank_name ?? '—'} / {r.prev_bank_account ?? '—'} →</span>{' '}
              <span className="font-medium">{r.bank_name ?? '—'} / {r.bank_account ?? '—'}</span>
            </span>
            <Badge variant="secondary" className="text-xs">{r.requested_by}</Badge>
            <div className="ml-auto flex gap-2">
              <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ reqNo: r.req_no, action: 'approve' })}>{t('fin.approve')}</Button>
              <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ reqNo: r.req_no, action: 'reject' })}>{t('fnx.bank.reject')}</Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// Direct-edit vendor master fields (master-data audit Phase 2) — contact/address/terms/rating/category/
// currency/notes have no fraud-relevant "who changed it" concern (unlike bank details), so this saves
// immediately with no maker-checker. Blocklist/approval status uses the existing suppliers/:id/status
// endpoint (built earlier for Phase 16 supplier screening, previously with no web caller).
function ProfileDialog({ vendor, onClose }: { vendor: Supplier; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    contact: vendor.Contact_Person ?? '', phone: vendor.Phone ?? '', email: vendor.Email ?? '', address: vendor.Address ?? '',
    payment_terms: vendor.Payment_Terms ?? '', lead_time_days: vendor.Lead_Time_Days ?? '', rating: vendor.Rating ?? '',
    category: vendor.Category ?? '', currency: vendor.Currency ?? '', notes: vendor.Notes ?? '',
    parent_vendor_id: vendor.parent_vendor_id != null ? String(vendor.parent_vendor_id) : '',
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const refresh = () => qc.invalidateQueries({ queryKey: ['suppliers'] });

  const save = useMutation({
    mutationFn: async () => {
      const r = await api<any>(`/api/procurement/vendors/${vendor.Vendor_ID}/profile`, {
        method: 'PATCH',
        body: JSON.stringify({
          contact: form.contact || undefined, phone: form.phone || undefined, email: form.email || undefined, address: form.address || undefined,
          payment_terms: form.payment_terms || undefined, lead_time_days: form.lead_time_days !== '' ? Number(form.lead_time_days) : undefined,
          rating: form.rating !== '' ? Number(form.rating) : undefined, category: form.category || undefined,
          currency: form.currency || undefined, notes: form.notes || undefined,
        }),
      });
      const prevParent = vendor.parent_vendor_id != null ? String(vendor.parent_vendor_id) : '';
      if (form.parent_vendor_id !== prevParent) {
        await api<any>(`/api/procurement/vendors/${vendor.Vendor_ID}/parent`, { method: 'PATCH', body: JSON.stringify({ parent_vendor_id: form.parent_vendor_id ? Number(form.parent_vendor_id) : null }) });
      }
      return r;
    },
    onSuccess: () => { notifySuccess(t('mx.vp_saved')); refresh(); onClose(); },
    onError: (e: any) => notifyError(e.message),
  });
  const setStatus = useMutation({
    mutationFn: (body: { approval_status?: string; blocklisted?: boolean; reason?: string }) => api<any>(`/api/procurement/suppliers/${vendor.Vendor_ID}/status`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => { notifySuccess(t('mx.vp_status_saved')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{vendor.Supplier_Name}</DialogTitle>
          <DialogDescription>{t('mx.vp_dialog_desc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('inv.col_contact')}><Input value={form.contact} onChange={set('contact')} /></FormField>
          <FormField label={t('inv.col_phone')}><Input value={form.phone} onChange={set('phone')} /></FormField>
          <FormField label={t('mx.vp_col_email')}><Input type="email" value={form.email} onChange={set('email')} /></FormField>
          <FormField label={t('mx.vp_f_address')} className="sm:col-span-2"><Input value={form.address} onChange={set('address')} /></FormField>
          <FormField label={t('inv.col_terms')}><Input value={form.payment_terms} onChange={set('payment_terms')} placeholder="Net 30" /></FormField>
          <FormField label={t('mx.vp_f_lead_time')}><Input type="number" min="0" value={form.lead_time_days} onChange={set('lead_time_days')} /></FormField>
          <FormField label={t('mx.vp_f_rating')}><Input type="number" min="0" max="5" step="0.1" value={form.rating} onChange={set('rating')} /></FormField>
          <FormField label={t('mx.vp_f_category')}><Input value={form.category} onChange={set('category')} /></FormField>
          <FormField label={t('mx.vp_f_currency')}><Input value={form.currency} onChange={set('currency')} placeholder="THB" /></FormField>
          <FormField label={t('mx.vp_f_parent')} hint={t('mx.vp_f_parent_hint')}>
            <Input type="number" min="1" value={form.parent_vendor_id} onChange={set('parent_vendor_id')} placeholder={String(vendor.Vendor_ID)} />
          </FormField>
          <FormField label={t('mx.vp_f_notes')} className="sm:col-span-2"><Input value={form.notes} onChange={set('notes')} /></FormField>
          <FormField label={t('mx.vp_col_status')}>
            <Select
              value={vendor.Blocklisted ? 'blocked' : (vendor.Approval_Status ?? 'approved')}
              onValueChange={(v) => setStatus.mutate(v === 'blocked' ? { blocklisted: true, reason: window.prompt(t('mx.vp_block_reason_prompt')) || undefined } : { blocklisted: false, approval_status: v })}
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="approved">{t('mx.vp_status_approved')}</SelectItem>
                <SelectItem value="pending">{t('mx.vp_status_pending')}</SelectItem>
                <SelectItem value="blocked">{t('mx.vp_status_blocked')}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
        </div>
        <DialogFooter>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>{t('mx.vp_save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Party-model depth (master-data audit Phase 4) — a vendor can carry more than one address/contact
// (previously one scalar each). Direct-edit, no maker-checker (mirrors the customer-side pattern).
function VendorPartyPanel({ vendor, onClose }: { vendor: Supplier; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [addingAddress, setAddingAddress] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const addrQ = useQuery<{ addresses: VendorAddress[] }>({ queryKey: ['vendor-addresses', vendor.Vendor_ID], queryFn: () => api(`/api/procurement/vendors/${vendor.Vendor_ID}/addresses`) });
  const contactQ = useQuery<{ contacts: VendorContact[] }>({ queryKey: ['vendor-contacts', vendor.Vendor_ID], queryFn: () => api(`/api/procurement/vendors/${vendor.Vendor_ID}/contacts`) });
  const refreshAddr = () => qc.invalidateQueries({ queryKey: ['vendor-addresses', vendor.Vendor_ID] });
  const refreshContact = () => qc.invalidateQueries({ queryKey: ['vendor-contacts', vendor.Vendor_ID] });

  const deleteAddress = useMutation({
    mutationFn: (id: number) => api<any>(`/api/procurement/vendors/${vendor.Vendor_ID}/addresses/${id}`, { method: 'DELETE' }),
    onSuccess: () => { notifySuccess(t('mx.cm_addr_deleted')); refreshAddr(); },
    onError: (e: any) => notifyError(e.message),
  });
  const deleteContact = useMutation({
    mutationFn: (id: number) => api<any>(`/api/procurement/vendors/${vendor.Vendor_ID}/contacts/${id}`, { method: 'DELETE' }),
    onSuccess: () => { notifySuccess(t('mx.cm_contact_deleted')); refreshContact(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{vendor.Supplier_Name}</DialogTitle>
          <DialogDescription>{t('mx.vp_party_dialog_desc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <h4 className="flex items-center gap-1.5 text-sm font-medium"><MapPin className="size-4" /> {t('mx.cm_addresses')}</h4>
              <Button size="sm" variant="outline" onClick={() => setAddingAddress(true)}><Plus className="size-3.5" /> {t('mx.cm_add_address')}</Button>
            </div>
            {(addrQ.data?.addresses ?? []).length === 0 && <p className="text-xs text-muted-foreground">{t('mx.cm_no_addresses')}</p>}
            {(addrQ.data?.addresses ?? []).map((a) => (
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
            {(contactQ.data?.contacts ?? []).length === 0 && <p className="text-xs text-muted-foreground">{t('mx.cm_no_contacts')}</p>}
            {(contactQ.data?.contacts ?? []).map((c) => (
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
            listUrl={`/api/procurement/vendors/${vendor.Vendor_ID}/relationships`}
            addUrl={`/api/procurement/vendors/${vendor.Vendor_ID}/relationships`}
            deleteBase={`/api/procurement/vendors/${vendor.Vendor_ID}/relationships`}
            queryKey={['vendor-relationships', vendor.Vendor_ID]}
            relTypes={VENDOR_REL_TYPES}
            targetPlaceholder={t('mx.rel_target_vendor')}
            buildBody={(target, relType) => ({ to_vendor_id: Number(target), rel_type: relType })}
          />
          <CustomFieldsSection entity="vendor" recordId={String(vendor.Vendor_ID)} />
          <ChangeHistorySection url={`/api/procurement/vendors/${vendor.Vendor_ID}/history`} queryKey={['vendor-history', vendor.Vendor_ID]} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('fin.cancel')}</Button>
        </DialogFooter>
      </DialogContent>
      {addingAddress && <VendorAddressFormDialog vendorId={vendor.Vendor_ID} onClose={() => setAddingAddress(false)} onSaved={refreshAddr} />}
      {addingContact && <VendorContactFormDialog vendorId={vendor.Vendor_ID} onClose={() => setAddingContact(false)} onSaved={refreshContact} />}
    </Dialog>
  );
}

function VendorAddressFormDialog({ vendorId, onClose, onSaved }: { vendorId: number; onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  const [form, setForm] = useState({ address_type: 'other' as 'billing' | 'shipping' | 'registered' | 'other', address_line1: '', address_line2: '', sub_district: '', district: '', province: '', postal_code: '', is_primary: false });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => api<any>(`/api/procurement/vendors/${vendorId}/addresses`, { method: 'POST', body: JSON.stringify(form) }),
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
          <FormField label={t('mx.cm_f_postal_code')}><Input inputMode="numeric" maxLength={5} value={form.postal_code} onChange={set('postal_code')} placeholder="50000" /></FormField>
        </div>
        <DialogFooter><Button disabled={save.isPending} onClick={() => save.mutate()}>{t('mx.cm_save')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VendorContactFormDialog({ vendorId, onClose, onSaved }: { vendorId: number; onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  const [form, setForm] = useState({ name: '', title: '', phone: '', email: '', notes: '', is_primary: false });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => api<any>(`/api/procurement/vendors/${vendorId}/contacts`, { method: 'POST', body: JSON.stringify(form) }),
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
