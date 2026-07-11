'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Truck, Plus, Trash2, Calculator, ShieldCheck, Coins, Ship } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

type Basis = 'value' | 'qty' | 'weight';
interface Line { item_id: string; qty: string; weight: string; base_value: string }
interface VoucherHeader {
  voucher_no: string; voucher_date: string; basis: Basis; status: string; total_charges: number;
  capitalized_total: number; variance_total: number; prepared_by?: string; posted_by?: string; gl_entry_no?: string;
}
interface Allocation { item_id: string; gr_no?: string; location_id: string; qty: number; base_value: number; alloc_amount: number; capitalized_amount: number; variance_amount: number }

const emptyLine = (): Line => ({ item_id: '', qty: '', weight: '', base_value: '' });

export function LandedCostClient({ initialList }: { initialList?: unknown }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);

  const list = useQuery<{ vouchers: VoucherHeader[] }>({
    queryKey: ['landed-cost-list'],
    queryFn: () => api('/api/costing/landed-cost'),
    initialData: initialList as { vouchers: VoucherHeader[] } | undefined,
  });
  const vouchers = list.data?.vouchers ?? [];
  const posted = vouchers.filter((v) => v.status === 'Posted');

  return (
    <div className="space-y-5">
      <PageHeader title={t('lc.title')} description={t('lc.desc')} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t('lc.stat_vouchers')} value={num(vouchers.length)} icon={Truck} tone="primary" />
        <StatCard label={t('lc.stat_posted')} value={num(posted.length)} icon={ShieldCheck} tone="success" />
        <StatCard label={t('lc.stat_capitalized')} value={baht(posted.reduce((a, v) => a + v.capitalized_total, 0))} icon={Coins} tone="info" />
        <StatCard label={t('lc.stat_variance')} value={baht(posted.reduce((a, v) => a + v.variance_total, 0))} icon={Calculator} tone="warning" />
      </div>

      <VoucherForm onCreated={(no) => { qc.invalidateQueries({ queryKey: ['landed-cost-list'] }); setSelected(no); }} />

      {selected && <VoucherDetail voucherNo={selected} onChanged={() => qc.invalidateQueries({ queryKey: ['landed-cost-list'] })} />}

      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('lc.list_title')}</h3>
        <StateView q={list}>
          {list.data && (
            <DataTable
              rows={vouchers}
              rowKey={(r) => r.voucher_no}
              onRowClick={(r: VoucherHeader) => setSelected(r.voucher_no)}
              emptyState={{ icon: Truck, title: t('lc.list_title'), description: t('lc.empty') }}
              columns={[
                { key: 'voucher_no', label: t('lc.col_no'), render: (r: VoucherHeader) => <span className="font-medium">{r.voucher_no}</span> },
                { key: 'voucher_date', label: t('lc.col_date') },
                { key: 'basis', label: t('lc.col_basis'), render: (r: VoucherHeader) => <Badge variant="secondary">{t(`lc.basis_${r.basis}`)}</Badge> },
                { key: 'total_charges', label: t('lc.col_total'), align: 'right', render: (r: VoucherHeader) => <span className="tabular">{baht(r.total_charges)}</span> },
                { key: 'capitalized_total', label: t('lc.col_capitalized'), align: 'right', render: (r: VoucherHeader) => <span className="tabular">{baht(r.capitalized_total)}</span> },
                { key: 'status', label: t('lc.col_status'), render: (r: VoucherHeader) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}

// ───────────────────────── Create voucher ─────────────────────────
function VoucherForm({ onCreated }: { onCreated: (no: string) => void }) {
  const { t } = useLang();
  const [basis, setBasis] = useState<Basis>('value');
  const [freight, setFreight] = useState('');
  const [duty, setDuty] = useState('');
  const [insurance, setInsurance] = useState('');
  const [broker, setBroker] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);

  const total = useMemo(() => (Number(freight) || 0) + (Number(duty) || 0) + (Number(insurance) || 0) + (Number(broker) || 0), [freight, duty, insurance, broker]);

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const create = useMutation({
    mutationFn: () => api<{ voucher: VoucherHeader }>('/api/costing/landed-cost', {
      method: 'POST',
      body: JSON.stringify({
        basis, memo: memo || undefined,
        charges: { freight: Number(freight) || 0, duty: Number(duty) || 0, insurance: Number(insurance) || 0, broker: Number(broker) || 0 },
        lines: lines.filter((l) => l.item_id.trim() && Number(l.qty) > 0).map((l) => ({
          item_id: l.item_id.trim(), qty: Number(l.qty),
          weight: l.weight !== '' ? Number(l.weight) : undefined,
          base_value: l.base_value !== '' ? Number(l.base_value) : undefined,
        })),
      }),
    }),
    onSuccess: (r) => {
      notifySuccess(t('lc.created', { no: r.voucher.voucher_no }));
      setFreight(''); setDuty(''); setInsurance(''); setBroker(''); setMemo(''); setLines([emptyLine()]);
      onCreated(r.voucher.voucher_no);
    },
    onError: (e: any) => notifyError(e.message),
  });

  const validLines = lines.filter((l) => l.item_id.trim() && Number(l.qty) > 0).length;
  const canSubmit = total > 0 && validLines > 0 && !create.isPending;

  return (
    <Card className="gap-4">
      <CardHeader><CardTitle className="text-base">{t('lc.form_title')}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('lc.form_hint')}</p>
        <div className="grid gap-3 sm:grid-cols-5">
          <div className="grid gap-2">
            <Label htmlFor="lc-basis">{t('lc.col_basis')}</Label>
            <select id="lc-basis" className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={basis} onChange={(e) => setBasis(e.target.value as Basis)}>
              <option value="value">{t('lc.basis_value')}</option>
              <option value="qty">{t('lc.basis_qty')}</option>
              <option value="weight">{t('lc.basis_weight')}</option>
            </select>
          </div>
          <ChargeInput id="lc-freight" label={t('lc.charge_freight')} value={freight} onChange={setFreight} />
          <ChargeInput id="lc-duty" label={t('lc.charge_duty')} value={duty} onChange={setDuty} />
          <ChargeInput id="lc-insurance" label={t('lc.charge_insurance')} value={insurance} onChange={setInsurance} />
          <ChargeInput id="lc-broker" label={t('lc.charge_broker')} value={broker} onChange={setBroker} />
        </div>

        <div className="space-y-2">
          <Label>{t('lc.lines_title')}</Label>
          {lines.map((l, i) => (
            <div key={i} className="grid items-end gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]">
              <Input aria-label={t('lc.line_item')} value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value })} placeholder={t('lc.line_item')} />
              <Input aria-label={t('lc.line_qty')} type="number" min="0" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} placeholder={t('lc.line_qty')} />
              <Input aria-label={t('lc.line_weight')} type="number" min="0" value={l.weight} onChange={(e) => setLine(i, { weight: e.target.value })} placeholder={t('lc.line_weight')} disabled={basis !== 'weight'} />
              <Input aria-label={t('lc.line_base_value')} type="number" min="0" value={l.base_value} onChange={(e) => setLine(i, { base_value: e.target.value })} placeholder={t('lc.line_base_value')} />
              <Button variant="ghost" size="icon" aria-label={t('lc.line_remove')} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}><Trash2 className="size-4" /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}><Plus className="size-4" /> {t('lc.line_add')}</Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <span className="text-sm text-muted-foreground">{t('lc.total_charges')}: <span className="tabular font-medium text-foreground">{baht(total)}</span></span>
          <Button disabled={!canSubmit} onClick={() => create.mutate()}><Ship className="size-4" /> {create.isPending ? t('lc.creating') : t('lc.create_btn')}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ChargeInput({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min="0" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0.00" />
    </div>
  );
}

// ───────────────────────── Voucher detail: preview + post ─────────────────────────
function VoucherDetail({ voucherNo, onChanged }: { voucherNo: string; onChanged: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ voucher: VoucherHeader; allocations: Allocation[] }>({
    queryKey: ['landed-cost', voucherNo],
    queryFn: () => api(`/api/costing/landed-cost/${voucherNo}`),
  });
  const v = q.data?.voucher;
  const allocations = q.data?.allocations ?? [];

  const allocate = useMutation({
    mutationFn: () => api(`/api/costing/landed-cost/${voucherNo}/allocate`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('lc.previewed')); qc.invalidateQueries({ queryKey: ['landed-cost', voucherNo] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const post = useMutation({
    mutationFn: () => api(`/api/costing/landed-cost/${voucherNo}/post`, { method: 'POST' }),
    onSuccess: () => { notifySuccess(t('lc.posted', { no: voucherNo })); qc.invalidateQueries({ queryKey: ['landed-cost', voucherNo] }); onChanged(); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {t('lc.detail_title')} · {voucherNo}
          {v && <Badge variant={statusVariant(v.status)}>{v.status}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <StateView q={q}>
          {v && (
            <>
              <DataTable
                rows={allocations}
                rowKey={(r) => `${r.item_id}-${r.location_id}`}
                emptyState={{ icon: Calculator, title: t('lc.detail_title'), description: t('lc.empty') }}
                columns={[
                  { key: 'item_id', label: t('lc.line_item'), render: (r: Allocation) => <span className="font-medium">{r.item_id}</span> },
                  { key: 'base_value', label: t('lc.line_base_value'), align: 'right', render: (r: Allocation) => <span className="tabular">{baht(r.base_value)}</span> },
                  { key: 'qty', label: t('lc.line_qty'), align: 'right', render: (r: Allocation) => <span className="tabular">{num(r.qty)}</span> },
                  { key: 'alloc_amount', label: t('lc.col_alloc'), align: 'right', render: (r: Allocation) => <span className="tabular">{baht(r.alloc_amount)}</span> },
                  { key: 'capitalized_amount', label: t('lc.col_capitalized'), align: 'right', render: (r: Allocation) => <span className="tabular">{baht(r.capitalized_amount)}</span> },
                  { key: 'variance_amount', label: t('lc.col_variance'), align: 'right', render: (r: Allocation) => <span className="tabular">{baht(r.variance_amount)}</span> },
                ]}
              />
              <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <span className="text-sm text-muted-foreground">
                  {t('lc.total_charges')}: <span className="tabular font-medium text-foreground">{baht(v.total_charges)}</span>
                  {v.status === 'Posted' && v.gl_entry_no && <> · {t('lc.gl_entry')}: <span className="font-medium">{v.gl_entry_no}</span></>}
                </span>
                {v.status === 'Draft' && (
                  <div className="flex gap-2">
                    <Button variant="outline" disabled={allocate.isPending} onClick={() => allocate.mutate()}><Calculator className="size-4" /> {t('lc.allocate_btn')}</Button>
                    <Button disabled={post.isPending} onClick={() => post.mutate()}><ShieldCheck className="size-4" /> {post.isPending ? t('lc.posting') : t('lc.post_btn')}</Button>
                  </div>
                )}
              </div>
              {v.status === 'Draft' && <p className="text-xs text-muted-foreground">{t('lc.maker_checker_note')}</p>}
            </>
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}
