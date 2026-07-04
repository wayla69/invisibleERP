'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PieChart, Plus, TrendingUp, TrendingDown, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const startOfYear = () => `${new Date().getFullYear()}-01-01`;
const today = () => new Date().toISOString().slice(0, 10);

const CC_TYPES = [
  { value: 'department', labelKey: 'fnx.cc.type_department' },
  { value: 'branch', labelKey: 'fnx.cc.type_branch' },
  { value: 'project', labelKey: 'fnx.cc.type_project' },
] as const;

// ศูนย์ต้นทุน / มิติบัญชี — master (create/list) + per-cost-centre dimensional P&L over the GL.
export default function CostCentersPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader
        title={t('fnx.cc.title')}
        description={t('fnx.cc.description')}
      />
      <Tabs
        urlParam="tab"
        tabs={[
          { key: 'master', label: t('fnx.cc.tab_master'), content: <Master /> },
          { key: 'pl', label: t('fnx.cc.tab_pl'), content: <DimensionalPL /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── cost-centre master: create + list ─────────────────────────
function Master() {
  const { t } = useLang();
  const typeLabel = (tp: string) => {
    const found = CC_TYPES.find((x) => x.value === tp);
    return found ? t(found.labelKey) : tp;
  };
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['cost-centers'], queryFn: () => api('/api/ledger/cost-centers') });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('department');
  const [parentCode, setParentCode] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api<any>('/api/ledger/cost-centers', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim(), name: name.trim(), type, ...(parentCode.trim() ? { parent_code: parentCode.trim() } : {}) }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('fnx.cc.added', { code: r.code, name: r.name }));
      setCode('');
      setName('');
      setParentCode('');
      qc.invalidateQueries({ queryKey: ['cost-centers'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div className="space-y-5">
      <Card className="max-w-3xl gap-4 p-5">
        <h3 className="text-base font-semibold">{t('fnx.cc.add_title')}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="cc-code">{t('fnx.cc.code')}</Label>
            <Input id="cc-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('fnx.cc.code_placeholder')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cc-name">{t('fnx.cc.name')}</Label>
            <Input id="cc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('fnx.cc.name_placeholder')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cc-type">{t('fnx.cc.type')}</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="cc-type" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CC_TYPES.map((ct) => <SelectItem key={ct.value} value={ct.value}>{t(ct.labelKey)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cc-parent">{t('fnx.cc.parent_code')}</Label>
            <Input id="cc-parent" value={parentCode} onChange={(e) => setParentCode(e.target.value)} placeholder={t('fnx.cc.parent_placeholder')} />
          </div>
        </div>
        <div>
          <Button disabled={create.isPending || !code.trim() || !name.trim()} onClick={() => create.mutate()}>
            <Plus className="size-4" /> {create.isPending ? t('fnx.cc.saving') : t('fnx.cc.add_button')}
          </Button>
        </div>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <StatCard label={t('fnx.cc.stat_count')} value={q.data.count ?? 0} icon={PieChart} tone="primary" className="max-w-xs" />
            <DataTable
              rows={q.data.cost_centers ?? []}
              rowKey={(r: any) => r.id}
              columns={[
                { key: 'code', label: t('fnx.cc.code') },
                { key: 'name', label: t('fnx.cc.name') },
                { key: 'type', label: t('fnx.cc.type'), render: (r: any) => typeLabel(r.type) },
                { key: 'parent_code', label: t('fnx.cc.parent'), render: (r: any) => r.parent_code ?? '—' },
                { key: 'active', label: t('fin.col_status'), render: (r: any) => <Badge variant={r.active === false ? 'destructive' : 'success'}>{r.active === false ? t('fnx.cc.inactive') : t('fnx.cc.active')}</Badge> },
              ]}
              emptyState={{
                icon: PieChart,
                title: t('fnx.cc.empty_title'),
                description: t('fnx.cc.empty_desc'),
              }}
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── dimensional P&L (pick cost centre + date range) ─────────────────────────
function DimensionalPL() {
  const { t } = useLang();
  const centers = useQuery<any>({ queryKey: ['cost-centers'], queryFn: () => api('/api/ledger/cost-centers') });

  const [code, setCode] = useState('');
  const [from, setFrom] = useState(startOfYear());
  const [to, setTo] = useState(today());

  const pl = useQuery<any>({
    queryKey: ['cost-center-pl', code, from, to],
    queryFn: () => api(`/api/ledger/cost-centers/${encodeURIComponent(code)}/pl?from=${from}&to=${to}`),
    enabled: !!code && !!from && !!to,
  });

  const list = centers.data?.cost_centers ?? [];

  return (
    <div className="space-y-5">
      <Card className="gap-4 p-5">
        <h3 className="text-base font-semibold">{t('fnx.cc.pick_title')}</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="pl-cc">{t('fnx.cc.cost_center')}</Label>
            <Select value={code} onValueChange={setCode}>
              <SelectTrigger id="pl-cc" className="w-full">
                <SelectValue placeholder={list.length ? t('fnx.cc.select_cc') : t('fnx.cc.no_cc')} />
              </SelectTrigger>
              <SelectContent>
                {list.map((c: any) => <SelectItem key={c.id} value={c.code}>{c.code} — {c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pl-from">{t('fnx.cc.from_date')}</Label>
            <Input id="pl-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pl-to">{t('fnx.cc.to_date')}</Label>
            <Input id="pl-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      </Card>

      {!code ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {t('fnx.cc.pick_prompt')}
        </Card>
      ) : (
        <StateView q={pl}>
          {pl.data && (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-3">
                <StatCard label={t('fnx.cc.revenue')} value={baht(pl.data.revenue)} icon={TrendingUp} tone="success" />
                <StatCard label={t('fnx.cc.expense')} value={baht(pl.data.expense)} icon={TrendingDown} tone="danger" />
                <StatCard label={t('fnx.cc.net_income')} value={baht(pl.data.net_income)} icon={Wallet} tone={Number(pl.data.net_income) >= 0 ? 'primary' : 'danger'} />
              </div>
              <DataTable
                rows={pl.data.lines ?? []}
                rowKey={(r: any) => r.account_code}
                columns={[
                  { key: 'account_code', label: t('fnx.cc.account_code') },
                  { key: 'account_name', label: t('fnx.cc.account_name'), render: (r: any) => r.account_name ?? '—' },
                  { key: 'account_type', label: t('fnx.cc.type'), render: (r: any) => <Badge variant={r.account_type === 'Revenue' ? 'success' : 'warning'}>{r.account_type === 'Revenue' ? t('fnx.cc.revenue') : t('fnx.cc.expense')}</Badge> },
                  { key: 'debit', label: t('fnx.cc.debit'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.debit)}</span> },
                  { key: 'credit', label: t('fnx.cc.credit'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.credit)}</span> },
                  {
                    key: 'net', label: t('fnx.cc.net'), align: 'right', sortable: false,
                    render: (r: any) => {
                      const net = r.account_type === 'Revenue' ? Number(r.credit) - Number(r.debit) : Number(r.debit) - Number(r.credit);
                      return <span className="tabular">{baht(net)}</span>;
                    },
                  },
                ]}
                emptyState={{
                  icon: PieChart,
                  title: t('fnx.cc.pl_empty_title'),
                  description: t('fnx.cc.pl_empty_desc'),
                }}
              />
            </div>
          )}
        </StateView>
      )}
    </div>
  );
}
