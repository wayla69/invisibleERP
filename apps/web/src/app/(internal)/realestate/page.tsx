'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, KeyRound, FileSignature, CheckCircle2, HandCoins, BadgeCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DocSelect } from '@/components/doc-select';

const unitTone: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = { available: 'default', reserved: 'outline', contracted: 'secondary', transferred: 'destructive' };

// Real-estate developer vertical (docs/35 P4/P5, RE-01..04). Developments/units availability grid, booking,
// maker-checker sale contract, installments, ownership transfer. Permission-gated (re_sales / re_transfer).
export default function RealEstatePage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [devCode, setDevCode] = useState('');
  const [active, setActive] = useState('');
  const [contractNo, setContractNo] = useState('');
  const units = useQuery<any>({ queryKey: ['re-units', active], queryFn: () => api(`/api/realestate/developments/${active}/units`), enabled: !!active });
  // Pending lists (new read-only GETs) — developments/contracts are picked from dropdowns, not typed.
  const devsQ = useQuery<any>({ queryKey: ['re-devs'], queryFn: () => api('/api/realestate/developments'), retry: false });
  const devOptions = (devsQ.data?.developments ?? []).map((d: any) => ({ value: d.dev_code, label: [d.name, d.status].filter(Boolean).join(' · ') || undefined }));
  const contractsQ = useQuery<any>({ queryKey: ['re-contracts'], queryFn: () => api('/api/realestate/contracts'), retry: false });
  const contractOptions = (contractsQ.data?.contracts ?? []).map((x: any) => ({ value: x.contract_no, label: [x.buyer_name, x.status].filter(Boolean).join(' · ') || undefined }));
  const contract = useQuery<any>({ queryKey: ['re-contract', contractNo], queryFn: () => api(`/api/realestate/contracts/${contractNo}`), enabled: !!contractNo });
  const [dev, setDev] = useState({ dev_code: '', name: '', location: '' });
  const [unit, setUnit] = useState({ unit_no: '', unit_type: 'condo', area_sqm: '', list_price: '', cost: '' });
  const refreshUnits = () => qc.invalidateQueries({ queryKey: ['re-units', active] });
  const refreshContract = () => qc.invalidateQueries({ queryKey: ['re-contract', contractNo] });

  const createDev = useMutation({ mutationFn: () => api('/api/realestate/developments', { method: 'POST', body: JSON.stringify(dev) }), onSuccess: () => { notifySuccess(t('cx.re_toast_dev')); setActive(dev.dev_code); setDev({ dev_code: '', name: '', location: '' }); qc.invalidateQueries({ queryKey: ['re-devs'] }); }, onError: (e: any) => notifyError(e.message) });
  const addUnit = useMutation({ mutationFn: () => api(`/api/realestate/developments/${active}/units`, { method: 'POST', body: JSON.stringify({ unit_no: unit.unit_no, unit_type: unit.unit_type, area_sqm: Number(unit.area_sqm) || 0, list_price: Number(unit.list_price) || 0, cost: Number(unit.cost) || 0 }) }), onSuccess: () => { notifySuccess(t('cx.re_toast_unit')); setUnit({ unit_no: '', unit_type: 'condo', area_sqm: '', list_price: '', cost: '' }); refreshUnits(); }, onError: (e: any) => notifyError(e.message) });
  const book = useMutation({ mutationFn: (v: { unit_no: string; deposit: number }) => api('/api/realestate/bookings', { method: 'POST', body: JSON.stringify({ dev_code: active, unit_no: v.unit_no, deposit: v.deposit }) }), onSuccess: () => { notifySuccess(t('cx.re_toast_book')); refreshUnits(); }, onError: (e: any) => notifyError(e.message) });
  const contractM = useMutation({ mutationFn: (v: { unit_no: string; discount: number; down: number; inst: number }) => api('/api/realestate/contracts', { method: 'POST', body: JSON.stringify({ dev_code: active, unit_no: v.unit_no, discount: v.discount, down_payment: v.down, installment_count: v.inst }) }), onSuccess: (d: any) => { notifySuccess(t('cx.re_toast_contract', { no: d.contract_no })); setContractNo(d.contract_no); refreshUnits(); qc.invalidateQueries({ queryKey: ['re-contracts'] }); }, onError: (e: any) => notifyError(e.message) });
  const approve = useMutation({ mutationFn: (no: string) => api(`/api/realestate/contracts/${no}/approve`, { method: 'POST' }), onSuccess: () => { notifySuccess(t('cx.re_toast_approve')); refreshContract(); refreshUnits(); }, onError: (e: any) => notifyError(e.message) });
  const pay = useMutation({ mutationFn: (v: { id: number; amount: number }) => api(`/api/realestate/installments/${v.id}/pay`, { method: 'POST', body: JSON.stringify({ amount: v.amount }) }), onSuccess: () => { notifySuccess(t('cx.re_toast_pay')); refreshContract(); }, onError: (e: any) => notifyError(e.message) });
  const transfer = useMutation({ mutationFn: (no: string) => api(`/api/realestate/contracts/${no}/transfer`, { method: 'POST' }), onSuccess: () => { notifySuccess(t('cx.re_toast_transfer')); refreshContract(); refreshUnits(); }, onError: (e: any) => notifyError(e.message) });

  const u = units.data;
  const c = contract.data;
  return (
    <div>
      <PageHeader title={t('cx.re_title')} description={t('cx.re_desc')} />

      <div className="mb-5 grid gap-4 lg:grid-cols-2">
        <Card className="gap-3 p-5">
          <h3 className="text-base font-semibold">{t('cx.re_dev_form')}</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5"><Label>{t('cx.re_f_devcode')}</Label><Input value={dev.dev_code} onChange={(e) => setDev({ ...dev, dev_code: e.target.value })} placeholder="RED-…" /></div>
            <div className="grid gap-1.5"><Label>{t('cx.re_f_devname')}</Label><Input value={dev.name} onChange={(e) => setDev({ ...dev, name: e.target.value })} /></div>
            <div className="grid gap-1.5"><Label>{t('cx.re_f_devloc')}</Label><Input value={dev.location} onChange={(e) => setDev({ ...dev, location: e.target.value })} /></div>
          </div>
          <div><Button onClick={() => createDev.mutate()} disabled={!dev.dev_code || !dev.name || createDev.isPending}><Plus className="size-4" /> {t('cx.re_btn_devcreate')}</Button></div>
        </Card>
        <Card className="flex flex-wrap items-end gap-3 p-5">
          <div className="grid gap-1.5"><Label>{t('cx.re_open')}</Label><DocSelect className="w-64" value={devCode} onValueChange={(v) => { setDevCode(v); if (v) setActive(v.trim()); }} options={devOptions} placeholder={t('common.doc_select_ph')} emptyText={t('common.doc_none')} allowManual manualPlaceholder="RED-…" /></div>
          <Button variant="outline" onClick={() => setActive(devCode.trim())} disabled={!devCode.trim()}><Search className="size-4" /> {t('cx.re_btn_open')}</Button>
        </Card>
      </div>

      {active && (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-4">
            <StatCard label={t('cx.re_stat_total')} value={u?.summary?.total ?? '—'} />
            <StatCard label={t('cx.re_stat_available')} value={u?.summary?.available ?? '—'} />
            <StatCard label={t('cx.re_stat_reserved')} value={u?.summary?.reserved ?? '—'} />
            <StatCard label={t('cx.re_stat_contracted')} value={u?.summary?.contracted ?? '—'} />
          </div>

          <Card className="mb-5 gap-3 p-5">
            <h3 className="text-base font-semibold">{t('cx.re_unit_form', { code: active })}</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="grid gap-1.5"><Label>{t('cx.re_f_unitno')}</Label><Input value={unit.unit_no} onChange={(e) => setUnit({ ...unit, unit_no: e.target.value })} placeholder="U-101" /></div>
              <div className="grid gap-1.5"><Label>{t('cx.re_f_unittype')}</Label><Input value={unit.unit_type} onChange={(e) => setUnit({ ...unit, unit_type: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('cx.re_f_area')}</Label><Input type="number" min="0" value={unit.area_sqm} onChange={(e) => setUnit({ ...unit, area_sqm: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('cx.re_f_list')}</Label><Input type="number" min="0" value={unit.list_price} onChange={(e) => setUnit({ ...unit, list_price: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>{t('cx.re_f_cost')}</Label><Input type="number" min="0" value={unit.cost} onChange={(e) => setUnit({ ...unit, cost: e.target.value })} /></div>
            </div>
            <div><Button onClick={() => addUnit.mutate()} disabled={!unit.unit_no || !unit.list_price || addUnit.isPending}><Plus className="size-4" /> {t('cx.re_btn_addunit')}</Button></div>
          </Card>

          <StateView q={units}>{u && (
            <DataTable
              rows={u.units ?? []}
              rowKey={(r: any) => r.unit_no}
              columns={[
                { key: 'unit_no', label: t('cx.re_col_unit') },
                { key: 'unit_type', label: t('cx.re_col_type') },
                { key: 'area_sqm', label: t('cx.re_col_area'), align: 'right' },
                { key: 'list_price', label: t('cx.re_col_list'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.list_price)}</span> },
                { key: 'status', label: t('cx.col_status'), render: (r: any) => <Badge variant={unitTone[r.status] ?? 'secondary'}>{r.status}</Badge> },
                { key: 'actions', label: '', align: 'right', render: (r: any) => (
                  <div className="flex justify-end gap-1.5">
                    {r.status === 'available' && <Button size="sm" variant="outline" onClick={() => { const dep = prompt(t('cx.re_prompt_deposit')); if (dep) book.mutate({ unit_no: r.unit_no, deposit: Number(dep) }); }}><KeyRound className="size-3.5" /> {t('cx.re_btn_book')}</Button>}
                    {(r.status === 'available' || r.status === 'reserved') && <Button size="sm" onClick={() => { const discount = Number(prompt(t('cx.re_prompt_discount'), '0') || 0); const down = Number(prompt(t('cx.re_prompt_down'), '0') || 0); const inst = Number(prompt(t('cx.re_prompt_inst'), '12') || 0); contractM.mutate({ unit_no: r.unit_no, discount, down, inst }); }}><FileSignature className="size-3.5" /> {t('cx.re_btn_contract')}</Button>}
                  </div>
                ) },
              ]}
            />
          )}</StateView>

          <Card className="mt-5 gap-3 p-5">
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1.5"><Label>{t('cx.re_contract_view')}</Label><DocSelect className="w-72" value={contractNo} onValueChange={setContractNo} options={contractOptions} placeholder={t('common.doc_select_ph')} emptyText={t('common.doc_none')} allowManual manualPlaceholder="REC-…" /></div>
            </div>
            {c && (
              <div className="grid gap-3">
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <span>{t('cx.re_lbl_price')} <b className="tabular">{baht(c.price)}</b></span>
                  <span>{t('cx.re_lbl_down')} <b className="tabular">{baht(c.down_payment)}</b></span>
                  <span>{t('cx.re_lbl_paid')} <b className="tabular">{baht(c.installments_paid)}</b></span>
                  <span>{t('cx.re_lbl_outstanding')} <b className="tabular">{baht(c.outstanding)}</b></span>
                  <Badge variant={c.status === 'active' ? 'default' : 'secondary'}>{c.status}</Badge>
                  {c.status === 'draft' && <Button size="sm" onClick={() => approve.mutate(c.contract_no)}><CheckCircle2 className="size-3.5" /> {t('cx.re_btn_approve')}</Button>}
                  {c.status === 'active' && c.outstanding <= 0 && <Button size="sm" onClick={() => transfer.mutate(c.contract_no)}><BadgeCheck className="size-3.5" /> {t('cx.re_btn_transfer')}</Button>}
                </div>
                {(c.installments ?? []).length > 0 && (
                  <DataTable
                    rows={c.installments}
                    rowKey={(r: any) => r.id}
                    columns={[
                      { key: 'seq', label: t('cx.re_col_seq'), align: 'right' },
                      { key: 'due_date', label: t('cx.re_col_due') },
                      { key: 'amount', label: t('cx.re_col_amount'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
                      { key: 'status', label: t('cx.col_status'), render: (r: any) => <Badge variant={r.status === 'paid' ? 'default' : 'secondary'}>{r.status}</Badge> },
                      { key: 'actions', label: '', align: 'right', render: (r: any) => r.status === 'pending' ? <Button size="sm" variant="outline" onClick={() => pay.mutate({ id: r.id, amount: r.amount })}><HandCoins className="size-3.5" /> {t('cx.re_btn_pay')}</Button> : null },
                    ]}
                  />
                )}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
