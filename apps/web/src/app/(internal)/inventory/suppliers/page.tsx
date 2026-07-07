'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SearchX, Truck, Landmark, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { useMe, hasPerm } from '@/lib/auth';
import { notifyError, notifySuccess } from '@/lib/notify';
import { ModulePage } from '@/components/module-page';
import { SearchInput } from '@/components/search-input';
import { DataTable } from '@/components/data-table';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

interface Supplier {
  Vendor_ID: number; Supplier_ID: string; Supplier_Name?: string; Contact_Person?: string; Phone?: string;
  Payment_Terms?: string; Bank_Name?: string | null; Bank_Account?: string | null;
}

export default function SuppliersPage() {
  const { t } = useLang();
  const { data: me } = useMe();
  const canEditBank = hasPerm(me, 'md_vendor');
  const q = useQuery<{ suppliers: Supplier[] }>({ queryKey: ['suppliers'], queryFn: () => api('/api/inventory/suppliers') });
  const rows = q.data?.suppliers ?? [];
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Supplier | null>(null);

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
            { key: 'Payment_Terms', label: t('inv.col_terms'), render: (r) => r.Payment_Terms || '—' },
            {
              key: 'Bank_Account',
              label: t('mx.vbc_col_bank'),
              render: (r) => (
                <div className="flex items-center gap-2">
                  <span className="text-sm">{r.Bank_Name || r.Bank_Account ? `${r.Bank_Name ?? '—'} · ${r.Bank_Account ?? '—'}` : t('mx.vbc_no_bank')}</span>
                  {canEditBank && (
                    <Button variant="ghost" size="icon" className="size-7" aria-label={t('mx.vbc_edit_bank')} onClick={() => setEditing(r)}>
                      <Landmark className="size-4" />
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      )}
      {editing && <BankChangeDialog vendor={editing} onClose={() => setEditing(null)} />}
    </ModulePage>
  );
}

// 0270 — a vendor's payee bank details change only after a DISTINCT exec/approvals user releases the staged
// request (closes a BEC/vendor-payment-fraud gap). Mirrors setup/page.tsx's tenant-profile ProfileApprovals.
function BankChangeDialog({ vendor, onClose }: { vendor: Supplier; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [bankName, setBankName] = useState(vendor.Bank_Name ?? '');
  const [bankAccount, setBankAccount] = useState(vendor.Bank_Account ?? '');
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
            <Input id="vbc-bank-name" value={bankName} onChange={(e) => setBankName(e.target.value)} />
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
