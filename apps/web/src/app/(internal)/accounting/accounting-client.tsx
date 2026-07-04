'use client';

import { Fragment, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronUp, ClipboardPaste, Info, Pencil, Plus, Power, Save, Scale, ShieldCheck, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { baht, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { jeFormError, jeLineError } from '@/lib/journal-validation';
import { useMe, hasPerm } from '@/lib/auth';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { FormField } from '@/components/form-field';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

type Account = { code: string; name: string; type: string };
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export default function AccountingWorkspace({ initialTb }: { initialTb?: unknown }) {
  const { t } = useLang();
  const me = useMe();
  // SoD R05/GL-05: JE preparer (gl_post) ≠ JE approver (approvals/gl_close).
  // The "รออนุมัติ (JE)" tab is only shown to users who hold the approval duty.
  const canApproveJE = hasPerm(me.data, 'approvals', 'gl_close', 'exec');

  const tabs = [
    { key: 'tb', label: t('acct.tab_tb'), content: <TrialBalance initialData={initialTb} /> },
    { key: 'gldetail', label: t('acct.tab_gldetail'), content: <GLDetail /> },
    { key: 'tieout', label: t('acct.tab_tieout'), content: <SubledgerTieout /> },
    { key: 'coa', label: t('acct.tab_coa'), content: <ChartOfAccounts /> },
    { key: 'journal', label: t('acct.tab_journal'), content: <Journal /> },
    ...(canApproveJE ? [{ key: 'approve', label: t('acct.tab_approve'), content: <PendingJournal /> }] : []),
    { key: 'pl', label: t('acct.tab_pl'), content: <IncomeStatement /> },
    { key: 'bs', label: t('acct.tab_bs'), content: <BalanceSheet /> },
    { key: 'cf', label: t('acct.tab_cf'), content: <CashFlow /> },
    { key: 'opening', label: t('acct.tab_opening'), content: <OpeningBalances /> },
  ];

  return (
    <div>
      <PageHeader
        title={t('acct.title')}
        description={t('acct.subtitle')}
      />
      <Tabs tabs={tabs} />
    </div>
  );
}

// ───────────────────────── ผังบัญชี (Chart of Accounts) ─────────────────────────
// Shows the tenant's industry-curated chart by default; the toggle reveals the full canonical universe
// (?all=true) for unusual postings. Account names follow the industry template set at company creation.
//
// GL-11 curation (a `gl_coa` holder only): rename (EN/TH), set group label, toggle active, and re-order —
// each PATCHes the per-tenant overlay (`/api/ledger/accounts/:code/overlay`) and refetches the ['coa']
// query. This edits ONLY the presentation overlay, never the canonical master universe: creating or
// recoding a master account is HQ-only (`COA_ADMIN_ONLY`), surfaced as a hint + a tailored toast. Curation
// applies to the industry-scoped chart only (`source === 'overlay'`); the "all accounts" view is read-only.
type CoaAccount = Account & { name_th?: string | null; group_label?: string | null; active?: boolean; sort_order?: number };
function ChartOfAccounts() {
  const { t } = useLang();
  const me = useMe();
  const qc = useQueryClient();
  const canEdit = hasPerm(me.data, 'gl_coa');
  const [showAll, setShowAll] = useState(false);
  // A gl_coa manager also loads curated-off rows so they can be re-activated; everyone else gets the
  // default active-only presentation.
  const params = showAll ? '?all=true' : canEdit ? '?include_inactive=true' : '';
  const q = useQuery<{ accounts: CoaAccount[]; count: number; source?: string; industry_scoped?: boolean }>({
    queryKey: ['coa', showAll, canEdit],
    queryFn: () => api(`/api/ledger/accounts${params}`),
  });
  const rows = q.data?.accounts ?? [];
  const editable = canEdit && !showAll && q.data?.source === 'overlay';

  const [edit, setEdit] = useState<CoaAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // code currently mutating → disables its row controls

  const refresh = () => { qc.invalidateQueries({ queryKey: ['coa'] }); qc.invalidateQueries({ queryKey: ['accounts'] }); };
  // Map the backend's machine code to a friendly toast; COA_ADMIN_ONLY = a master-code change was attempted.
  const onErr = (e: any) =>
    e?.code === 'COA_ADMIN_ONLY'
      ? notifyError(t('acct.coa_admin_only_title'), t('acct.coa_admin_only_desc'))
      : notifyError(e?.message ?? t('acct.error_generic'));

  const patchOverlay = (code: string, body: Record<string, unknown>) =>
    api(`/api/ledger/accounts/${code}/overlay`, { method: 'PATCH', body: JSON.stringify(body) });

  const toggleActive = async (a: CoaAccount) => {
    const next = !(a.active !== false);
    setBusy(a.code);
    try { await patchOverlay(a.code, { active: next }); notifySuccess(next ? t('acct.coa_activated', { code: a.code }) : t('acct.coa_deactivated', { code: a.code })); refresh(); }
    catch (e) { onErr(e); }
    finally { setBusy(null); }
  };

  // Re-order by swapping this row's sort_order with its neighbour (each a PATCH). Rows arrive pre-sorted by
  // sort_order, so the two writes are enough; equal orders (rare) nudge past the neighbour.
  const move = async (a: CoaAccount, dir: 'up' | 'down') => {
    const i = rows.findIndex((r) => r.code === a.code);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= rows.length) return;
    const b = rows[j];
    const aOrder = a.sort_order ?? 0, bOrder = b.sort_order ?? 0;
    const newA = aOrder === bOrder ? (dir === 'up' ? bOrder - 1 : bOrder + 1) : bOrder;
    setBusy(a.code);
    try { await Promise.all([patchOverlay(a.code, { sort_order: newA }), patchOverlay(b.code, { sort_order: aOrder })]); refresh(); }
    catch (e) { onErr(e); }
    finally { setBusy(null); }
  };

  const columns = [
    { key: 'code', label: t('acct.col_code'), sortable: !editable },
    {
      key: 'name', label: t('acct.col_account_name'), sortable: !editable,
      render: (r: CoaAccount) => (
        <span className="inline-flex items-center gap-2">
          <span className={r.active === false ? 'text-muted-foreground line-through' : ''}>{r.name}</span>
          {r.active === false && <Badge variant="secondary">{t('acct.inactive')}</Badge>}
        </span>
      ),
    },
    { key: 'name_th', label: t('acct.col_name_th'), sortable: !editable, render: (r: CoaAccount) => r.name_th || <span className="text-muted-foreground">—</span> },
    { key: 'group_label', label: t('acct.col_group'), sortable: !editable, render: (r: CoaAccount) => r.group_label || <span className="text-muted-foreground">—</span> },
    { key: 'type', label: t('acct.col_type'), sortable: !editable },
    ...(editable
      ? [{
          key: 'actions', label: '', sortable: false, align: 'right' as const,
          render: (r: CoaAccount) => {
            const i = rows.findIndex((x) => x.code === r.code);
            const rowBusy = busy === r.code;
            return (
              <div className="flex items-center justify-end gap-0.5">
                <Button variant="ghost" size="icon" title={t('acct.move_up')} disabled={rowBusy || i <= 0} onClick={() => move(r, 'up')}><ChevronUp className="size-4" /></Button>
                <Button variant="ghost" size="icon" title={t('acct.move_down')} disabled={rowBusy || i >= rows.length - 1} onClick={() => move(r, 'down')}><ChevronDown className="size-4" /></Button>
                <Button variant="ghost" size="icon" title={t('acct.edit_name_group')} disabled={rowBusy} onClick={() => setEdit(r)}><Pencil className="size-4" /></Button>
                <Button variant="ghost" size="icon" title={r.active === false ? t('acct.activate') : t('acct.deactivate')} disabled={rowBusy} onClick={() => toggleActive(r)}>
                  <Power className={`size-4 ${r.active === false ? 'text-muted-foreground' : 'text-emerald-600'}`} />
                </Button>
              </div>
            );
          },
        }]
      : []),
  ];

  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {q.data.industry_scoped && !showAll ? (
                <Badge variant="success">{t('acct.coa_industry_scoped')}</Badge>
              ) : (
                <Badge variant="secondary">{t('acct.coa_full')}</Badge>
              )}
              <span>{t('acct.coa_count', { count: q.data.count })}</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowAll((v) => !v)}>
              {showAll ? t('acct.show_industry_only') : t('acct.show_all')}
            </Button>
          </div>
          {editable && (
            <Card className="flex-row flex-wrap items-center gap-2 p-3 text-sm text-muted-foreground">
              <Info className="size-4 shrink-0" />
              <span>
                {t('acct.coa_curation_1')}<strong>{t('acct.coa_curation_strong1')}</strong>{t('acct.coa_curation_2')}<strong>{t('acct.coa_curation_strong2')}</strong>{t('acct.coa_curation_3')}
              </span>
            </Card>
          )}
          <DataTable
            rows={rows}
            pageSize={editable ? 0 : 50}
            rowKey={(r: CoaAccount) => r.code}
            emptyState={{ icon: Scale, title: t('acct.coa_empty_title'), description: t('acct.coa_empty_desc') }}
            columns={columns}
          />
        </div>
      )}
      {edit && <EditAccountDialog account={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh(); }} onError={onErr} />}
    </StateView>
  );
}

// GL-11 rename/re-group dialog — writes display_name (EN), display_name_th (TH), and group_label to the
// per-tenant overlay for one account. Clearing a field resets it to the canonical default.
function EditAccountDialog({ account, onClose, onSaved, onError }: {
  account: CoaAccount; onClose: () => void; onSaved: () => void; onError: (e: unknown) => void;
}) {
  const { t } = useLang();
  const [nameEn, setNameEn] = useState(account.name ?? '');
  const [nameTh, setNameTh] = useState(account.name_th ?? '');
  const [group, setGroup] = useState(account.group_label ?? '');
  const save = useMutation({
    mutationFn: () =>
      api(`/api/ledger/accounts/${account.code}/overlay`, {
        method: 'PATCH',
        body: JSON.stringify({ display_name: nameEn, display_name_th: nameTh, group_label: group }),
      }),
    onSuccess: () => { notifySuccess(t('acct.coa_saved', { code: account.code })); onSaved(); },
    onError,
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('acct.edit_title', { code: account.code })}</DialogTitle>
          <DialogDescription>{t('acct.edit_desc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('acct.f_name_en')} htmlFor="coa-name-en" hint={t('acct.f_name_hint')}>
            <Input id="coa-name-en" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </FormField>
          <FormField label={t('acct.f_name_th')} htmlFor="coa-name-th">
            <Input id="coa-name-th" value={nameTh} onChange={(e) => setNameTh(e.target.value)} />
          </FormField>
          <FormField label={t('acct.f_group')} htmlFor="coa-group" hint={t('acct.f_group_hint')}>
            <Input id="coa-group" value={group} onChange={(e) => setGroup(e.target.value)} />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>{t('fin.cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            <Save className="size-4" /> {save.isPending ? t('acct.saving') : t('fin.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── งบทดลอง ─────────────────────────
function TrialBalance({ initialData }: { initialData?: unknown }) {
  const { t } = useLang();
  // Server-prefetched payload (see page.tsx) renders instantly; react-query still owns the cache and
  // refetches on invalidation exactly as before. A null/undefined prefetch = the old client-only path.
  const q = useQuery<any>({ queryKey: ['tb'], queryFn: () => api('/api/ledger/trial-balance'), initialData: initialData ?? undefined });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t('acct.total_debit')} value={baht(q.data.totals.debit)} tone="primary" />
            <StatCard label={t('acct.total_credit')} value={baht(q.data.totals.credit)} tone="primary" />
            <StatCard
              label={t('fin.col_status')}
              value={<Badge variant={q.data.totals.balanced ? 'success' : 'destructive'}>{q.data.totals.balanced ? t('acct.balanced') : t('acct.unbalanced')}</Badge>}
            />
          </div>
          <DataTable
            rows={q.data.rows}
            emptyState={{ icon: Scale, title: t('acct.tb_empty_title'), description: t('acct.tb_empty_desc') }}
            columns={[
              { key: 'account_code', label: t('acct.col_code') },
              { key: 'account_name', label: t('acct.col_account_name') },
              { key: 'account_type', label: t('acct.col_type') },
              { key: 'debit', label: t('acct.col_debit'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.debit)}</span> },
              { key: 'credit', label: t('acct.col_credit'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.credit)}</span> },
              { key: 'balance', label: t('acct.col_balance'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.balance)}</span> },
            ]}
          />
        </div>
      )}
    </StateView>
  );
}

// ───────────────────────── สมุดรายวัน + ลงรายการ ─────────────────────────
type Line = { account_code: string; debit: string; credit: string };
const emptyLine = (): Line => ({ account_code: '', debit: '', credit: '' });

function Journal() {
  const { t } = useLang();
  const qc = useQueryClient();
  const accounts = useQuery<{ accounts: Account[] }>({ queryKey: ['accounts'], queryFn: () => api('/api/ledger/accounts') });
  const journal = useQuery<any>({ queryKey: ['journal'], queryFn: () => api('/api/ledger/journal?limit=30') });

  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [showErrors, setShowErrors] = useState(false);

  const sumDebit = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0);
  const sumCredit = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(sumDebit - sumCredit) < 0.005 && sumDebit > 0;
  const formErr = jeFormError(lines);

  const post = useMutation({
    mutationFn: () =>
      api<{ entry_no: string }>('/api/ledger/journal', {
        method: 'POST',
        body: JSON.stringify({
          source: 'Manual',
          memo: memo || undefined,
          lines: lines
            .filter((l) => l.account_code && (Number(l.debit) || Number(l.credit)))
            .map((l) => ({ account_code: l.account_code, debit: Number(l.debit) || undefined, credit: Number(l.credit) || undefined })),
        }),
      }),
    onSuccess: (r) => {
      notifySuccess(t('acct.je_draft_saved', { no: r.entry_no }));
      setMemo(''); setLines([emptyLine(), emptyLine()]); setShowErrors(false);
      qc.invalidateQueries({ queryKey: ['journal'] });
      qc.invalidateQueries({ queryKey: ['je-pending'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const submit = () => { setShowErrors(true); if (formErr || lines.some((l) => jeLineError(l))) { notifyError(t('acct.je_fix_before_save')); return; } post.mutate(); };

  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('acct.je_heading')}</h3>
        <Input placeholder={t('acct.je_memo_ph')} value={memo} onChange={(e) => setMemo(e.target.value)} />
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-2 font-medium">{t('acct.col_account')}</th>
              <th className="w-[130px] pb-2 font-medium">{t('acct.col_debit')}</th>
              <th className="w-[130px] pb-2 font-medium">{t('acct.col_credit')}</th>
              <th className="w-10 pb-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const err = showErrors ? jeLineError(l) : null;
              return (
              <Fragment key={i}>
              <tr>
                <td className="py-1 pr-2">
                  <select className={selectCls} aria-invalid={!!err} value={l.account_code} onChange={(e) => setLine(i, { account_code: e.target.value })}>
                    <option value="">{t('acct.select_account')}</option>
                    {accounts.data?.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                  </select>
                </td>
                <td className="py-1 pr-2"><Input type="number" min="0" aria-invalid={!!err} value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: '' })} /></td>
                <td className="py-1 pr-2"><Input type="number" min="0" aria-invalid={!!err} value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: '' })} /></td>
                <td className="py-1">{lines.length > 2 && <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><X className="size-4" /></Button>}</td>
              </tr>
              {err && <tr><td colSpan={4} className="pb-1 text-xs text-destructive" role="alert">{err}</td></tr>}
              </Fragment>
              );
            })}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
            <Plus className="size-4" /> {t('acct.add_line')}
          </Button>
          <span className="text-sm">
            {t('acct.col_debit')} <strong className="tabular">{baht(sumDebit)}</strong> · {t('acct.col_credit')} <strong className="tabular">{baht(sumCredit)}</strong>{' '}
            <Badge variant={balanced ? 'success' : 'warning'}>{balanced ? t('acct.balanced') : t('acct.not_balanced_yet')}</Badge>
          </span>
          <Button disabled={post.isPending} onClick={submit}>
            <Save className="size-4" /> {post.isPending ? t('acct.saving') : t('acct.post_entry')}
          </Button>
        </div>
        {showErrors && formErr && <p className="text-sm text-destructive" role="alert">{formErr}</p>}
      </Card>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('acct.recent_entries')}</h3>
        <StateView q={journal}>
          {journal.data && (
            <div className="grid gap-3">
              {journal.data.entries.length === 0 && <Card className="gap-0 p-5"><span className="text-sm text-muted-foreground">{t('acct.no_entries')}</span></Card>}
              {journal.data.entries.map((e: any) => (
                <Card key={e.entry_no} className="gap-2 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong>{e.entry_no}</strong>
                    <span className="flex items-center gap-1 text-sm text-muted-foreground">
                      {thaiDate(e.entry_date)} · {e.source}{e.source_ref ? ` · ${e.source_ref}` : ''} · <Badge variant={statusVariant(e.status)}>{e.status}</Badge>
                    </span>
                  </div>
                  {e.memo && <div className="text-sm text-muted-foreground">{e.memo}</div>}
                  <table className="w-full text-sm">
                    <tbody>
                      {e.lines.map((l: any, j: number) => (
                        <tr key={j}>
                          <td className="py-0.5">{l.account_code}</td>
                          <td className="py-0.5 text-right tabular">{l.debit ? baht(l.debit) : ''}</td>
                          <td className="py-0.5 text-right tabular">{l.credit ? baht(l.credit) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              ))}
            </div>
          )}
        </StateView>
      </div>
    </div>
  );
}

// ─────────────── รออนุมัติ JE (GL-05 maker-checker) ───────────────
function PendingJournal() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['je-pending'], queryFn: () => api('/api/ledger/journal/pending?limit=50') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['je-pending'] }); qc.invalidateQueries({ queryKey: ['journal'] }); qc.invalidateQueries({ queryKey: ['tb'] }); };
  const approve = useMutation({ mutationFn: (no: string) => api(`/api/ledger/journal/${no}/approve`, { method: 'POST' }), onSuccess: (r: any) => { notifySuccess(t('acct.je_approved', { no: r.entry_no })); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const reject = useMutation({ mutationFn: (no: string) => { const reason = prompt(t('acct.reject_reason_prompt')) ?? undefined; return api(`/api/ledger/journal/${no}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); }, onSuccess: (r: any) => { notifySuccess(t('acct.je_rejected', { no: r.entry_no })); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const entries = q.data?.entries ?? [];
  return (
    <div className="space-y-4">
      <Card className="flex-row flex-wrap items-center gap-2 p-4 text-sm">
        <ShieldCheck className="size-4 text-muted-foreground" />
        {t('acct.je_sod_1')}<strong>{t('acct.je_sod_not')}</strong>{t('acct.je_sod_2')}
      </Card>
      <StateView q={q}>
        {entries.length === 0 ? (
          <Card className="gap-0 p-5"><span className="text-sm text-muted-foreground">{t('acct.no_pending')}</span></Card>
        ) : (
          <div className="grid gap-3">
            {entries.map((e: any) => (
              <Card key={e.entry_no} className="gap-2 p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>{e.entry_no}</strong>
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    {thaiDate(e.entry_date)} · {t('acct.recorded_by')} <Badge variant="outline">{e.created_by}</Badge> · <Badge variant={statusVariant(e.status)}>{e.status}</Badge>
                  </span>
                </div>
                {e.memo && <div className="text-sm text-muted-foreground">{e.memo}</div>}
                <table className="w-full text-sm">
                  <tbody>
                    {e.lines.map((l: any, j: number) => (
                      <tr key={j}><td className="py-0.5">{l.account_code}</td><td className="py-0.5 text-right tabular">{l.debit ? baht(l.debit) : ''}</td><td className="py-0.5 text-right tabular">{l.credit ? baht(l.credit) : ''}</td></tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex gap-2">
                  <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate(e.entry_no)}><Check className="size-4" /> {t('fin.approve')}</Button>
                  <Button size="sm" variant="destructive" disabled={reject.isPending} onClick={() => reject.mutate(e.entry_no)}><X className="size-4" /> {t('acct.reject')}</Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── งบกำไรขาดทุน ─────────────────────────
function IncomeStatement() {
  const { t } = useLang();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const q = useQuery<any>({ queryKey: ['pl', from, to], queryFn: () => api(`/api/ledger/income-statement?from=${from}&to=${to}`) });
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="pl-from">{t('acct.from')}</Label>
          <Input id="pl-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pl-to">{t('acct.to')}</Label>
          <Input id="pl-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <StateView q={q}>
        {q.data && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t('acct.revenue')} value={baht(q.data.revenue)} tone="primary" />
            <StatCard label={t('acct.expense')} value={baht(q.data.expense)} tone="danger" />
            <StatCard label={t('acct.net_income')} value={baht(q.data.net_income)} tone={q.data.net_income >= 0 ? 'success' : 'danger'} />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── ยอดยกมา (Opening balances) ─────────────────────────
type ObLine = { account_code: string; debit: string; credit: string };
const emptyObLine = (): ObLine => ({ account_code: '', debit: '', credit: '' });

// Parse rows pasted from Excel/Google Sheets/CSV into opening-balance lines. Resilient to the common
// shapes of an exported trial balance: an optional header row; an account-name column between the code
// and the amounts; thousands separators; a debit AND credit column (blanks kept so the column position
// isn't lost); or a single signed-amount column (positive ⇒ debit, negative ⇒ credit).
// A cell is numeric only if it actually contains a digit (an account name reads as NaN, not 0).
const num = (s: string) => {
  const t = String(s).replace(/,/g, '').trim();
  if (t === '' || !/\d/.test(t)) return NaN;
  const v = Number(t.replace(/[^\d.-]/g, ''));
  return Number.isFinite(v) ? v : NaN;
};
function parseObPaste(text: string): ObLine[] {
  const out: ObLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    // Pick ONE delimiter — a spreadsheet paste is tab-delimited, so splitting on comma too would shred a
    // "50,000" thousands separator. Prefer tab, then semicolon, then comma (plain CSV).
    const sep = raw.includes('\t') ? '\t' : raw.includes(';') ? ';' : ',';
    const cells = raw.split(sep).map((c) => c.trim());
    const code = cells[0];
    if (!code) continue;
    // Collect the trailing amount cells (numeric or blank), stopping at the first text cell (the account
    // name / the code). Blanks are retained so a debit-vs-credit column position is preserved.
    const amounts: string[] = [];
    for (let i = cells.length - 1; i >= 1; i--) {
      const cell = cells[i];
      if (cell === '' || !Number.isNaN(num(cell))) amounts.unshift(cell);
      else break;
    }
    let debit = '', credit = '';
    if (amounts.length >= 2) {
      const d = num(amounts[0]!), c = num(amounts[1]!);
      if (!Number.isNaN(d) && d !== 0) debit = String(d);
      if (!Number.isNaN(c) && c !== 0) credit = String(c);
    } else if (amounts.length === 1) {
      const v = num(amounts[0]!);
      if (!Number.isNaN(v) && v !== 0) { if (v < 0) credit = String(-v); else debit = String(v); }
    }
    if (!debit && !credit) continue; // header / blank / a zero-only line — nothing to post
    out.push({ account_code: code, debit, credit });
  }
  return out;
}

function OpeningBalances() {
  const { t } = useLang();
  const qc = useQueryClient();
  const accounts = useQuery<{ accounts: Account[] }>({ queryKey: ['accounts'], queryFn: () => api('/api/ledger/accounts') });

  const [batchRef, setBatchRef] = useState('');
  const [lines, setLines] = useState<ObLine[]>([emptyObLine(), emptyObLine()]);
  const [errs, setErrs] = useState<{ row: number; error: string }[]>([]);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const applyPaste = () => {
    const parsed = parseObPaste(pasteText);
    if (!parsed.length) { notifyError(t('acct.ob_paste_none')); return; }
    // Append onto any rows the user already keyed; drop the two blank starter rows.
    setLines((ls) => { const kept = ls.filter((l) => l.account_code || l.debit || l.credit); return [...kept, ...parsed]; });
    setPasteText(''); setPasteOpen(false);
    notifySuccess(t('acct.ob_imported', { n: parsed.length }));
  };

  const sumDebit = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0);
  const sumCredit = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);
  // net imbalance auto-posts to account 3000 (Opening Balance Equity)
  const diff = sumDebit - sumCredit;
  const equityDebit = diff < 0 ? -diff : 0;
  const equityCredit = diff > 0 ? diff : 0;

  const setLine = (i: number, patch: Partial<ObLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const post = useMutation({
    mutationFn: () =>
      api<{ batch_ref?: string; entry_no?: string; balanced?: boolean; lines_posted?: number; row_errors?: { row: number; error: string }[]; already?: boolean }>(
        '/api/ledger/opening-balances',
        {
          method: 'POST',
          body: JSON.stringify({
            batch_ref: batchRef || undefined,
            rows: lines
              .filter((l) => l.account_code && (Number(l.debit) || Number(l.credit)))
              .map((l) => ({ account_code: l.account_code, debit: Number(l.debit) || undefined, credit: Number(l.credit) || undefined })),
          }),
        },
      ),
    onSuccess: (r) => {
      setErrs(r.row_errors ?? []);
      if (r.already) {
        notifyError(t('acct.ob_batch_used'));
        return;
      }
      notifySuccess(t('acct.ob_posted', { no: r.entry_no ?? '', n: r.lines_posted ?? 0 }));
      setBatchRef(''); setLines([emptyObLine(), emptyObLine()]);
      qc.invalidateQueries({ queryKey: ['tb'] });
      qc.invalidateQueries({ queryKey: ['journal'] });
    },
    onError: (e: any) => { setErrs([]); notifyError(e.message); },
  });

  const hasRows = lines.some((l) => l.account_code && (Number(l.debit) || Number(l.credit)));

  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('acct.ob_heading')}</h3>
        <p className="text-sm text-muted-foreground">{t('acct.ob_note')}</p>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="grid max-w-sm gap-1.5">
            <Label htmlFor="ob-batch">{t('acct.ob_batch_label')}</Label>
            <Input id="ob-batch" placeholder={t('acct.ob_batch_ph')} value={batchRef} onChange={(e) => setBatchRef(e.target.value)} />
          </div>
          <Button variant="outline" size="sm" onClick={() => setPasteOpen((v) => !v)}>
            <ClipboardPaste className="size-4" /> {t('acct.ob_paste_btn')}
          </Button>
        </div>
        {pasteOpen && (
          <div className="grid gap-2 rounded-md border bg-muted/30 p-3">
            <p className="text-sm text-muted-foreground">
              {t('acct.ob_paste_help_1')}<strong>{t('acct.account_code_word')}</strong> ·{' '}
              <strong>{t('acct.col_debit')}</strong> · <strong>{t('acct.col_credit')}</strong>{t('acct.ob_paste_help_2')}
            </p>
            <textarea
              className="min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              placeholder={t('acct.ob_paste_example')}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setPasteText(''); setPasteOpen(false); }}>{t('fin.cancel')}</Button>
              <Button size="sm" disabled={!pasteText.trim()} onClick={applyPaste}>{t('acct.ob_import_btn')}</Button>
            </div>
          </div>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-2 font-medium">{t('acct.col_account')}</th>
              <th className="w-[130px] pb-2 text-right font-medium">{t('acct.col_debit')}</th>
              <th className="w-[130px] pb-2 text-right font-medium">{t('acct.col_credit')}</th>
              <th className="w-10 pb-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="py-1 pr-2">
                  <select className={selectCls} value={l.account_code} onChange={(e) => setLine(i, { account_code: e.target.value })}>
                    <option value="">{t('acct.select_account')}</option>
                    {accounts.data?.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                  </select>
                </td>
                <td className="py-1 pr-2"><Input className="text-right tabular" type="number" min="0" value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: '' })} /></td>
                <td className="py-1 pr-2"><Input className="text-right tabular" type="number" min="0" value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: '' })} /></td>
                <td className="py-1">{lines.length > 1 && <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><X className="size-4" /></Button>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t text-muted-foreground">
              <td className="py-1.5">{t('acct.ob_equity_row')}</td>
              <td className="py-1.5 text-right tabular">{equityDebit ? baht(equityDebit) : ''}</td>
              <td className="py-1.5 text-right tabular">{equityCredit ? baht(equityCredit) : ''}</td>
              <td />
            </tr>
            <tr className="border-t font-medium">
              <td className="py-1.5 text-right">{t('acct.total_row')}</td>
              <td className="py-1.5 text-right tabular">{baht(sumDebit + equityDebit)}</td>
              <td className="py-1.5 text-right tabular">{baht(sumCredit + equityCredit)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, emptyObLine()])}>
            <Plus className="size-4" /> {t('acct.add_line')}
          </Button>
          <span className="text-sm">
            {t('acct.col_debit')} <strong className="tabular">{baht(sumDebit)}</strong> · {t('acct.col_credit')} <strong className="tabular">{baht(sumCredit)}</strong>{' '}
            <Badge variant={Math.abs(diff) < 0.005 ? 'success' : 'warning'}>
              {Math.abs(diff) < 0.005 ? t('acct.balanced') : t('acct.ob_to_3000', { amount: baht(Math.abs(diff)) })}
            </Badge>
          </span>
          <Button disabled={!hasRows || post.isPending} onClick={() => { setErrs([]); post.mutate(); }}>
            <Save className="size-4" /> {post.isPending ? t('acct.ob_posting') : t('acct.ob_post_btn')}
          </Button>
        </div>
        {errs.length > 0 && (
          <div className="grid gap-1 text-sm text-destructive">
            {errs.map((e, j) => <div key={j}>{t('acct.row_label', { row: e.row })}: {e.error}</div>)}
          </div>
        )}
      </Card>
    </div>
  );
}

// ───────────────────────── งบดุล ─────────────────────────
function BalanceSheet() {
  const { t } = useLang();
  const [asOf, setAsOf] = useState(today());
  const q = useQuery<any>({ queryKey: ['bs', asOf], queryFn: () => api(`/api/ledger/balance-sheet?as_of=${asOf}`) });
  return (
    <div className="space-y-5">
      <div className="grid max-w-[200px] gap-1.5">
        <Label htmlFor="bs-asof">{t('acct.as_of')}</Label>
        <Input id="bs-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
      </div>
      <StateView q={q}>
        {q.data && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('acct.assets')} value={baht(q.data.assets)} tone="primary" />
              <StatCard label={t('acct.liabilities')} value={baht(q.data.liabilities)} tone="danger" />
              <StatCard label={t('acct.equity')} value={baht(q.data.equity)} />
              <StatCard label={t('acct.retained_earnings')} value={baht(q.data.net_income)} />
            </div>
            <Card className="flex-row flex-wrap items-center gap-2 p-5 text-sm">
              <ShieldCheck className="size-4 text-muted-foreground" />
              {t('acct.assets')} <span className="tabular">{baht(q.data.assets)}</span> = {t('acct.liab_plus_equity')} <span className="tabular">{baht(q.data.liabilities_plus_equity)}</span>{' '}
              <Badge variant={q.data.balanced ? 'success' : 'destructive'}>{q.data.balanced ? t('acct.balanced') : t('acct.unbalanced')}</Badge>
            </Card>
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── งบกระแสเงินสด (Statement of Cash Flows, indirect) ─────────────────────────
function CashFlow() {
  const { t } = useLang();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const q = useQuery<any>({ queryKey: ['cf', from, to], queryFn: () => api(`/api/ledger/cash-flow?from=${from}&to=${to}`) });
  const d = q.data;
  // Render a labelled cash-flow line; positive = cash in (green), negative = cash out (red).
  const flowRow = (label: string, amount: number, i: number) => (
    <tr key={i}>
      <td className="py-0.5 pr-3">{label}</td>
      <td className={`py-0.5 text-right tabular ${amount < 0 ? 'text-red-600' : ''}`}>{baht(amount)}</td>
    </tr>
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="cf-from">{t('acct.from')}</Label>
          <Input id="cf-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cf-to">{t('acct.to')}</Label>
          <Input id="cf-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <StateView q={q}>
        {d && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label={t('acct.cf_operating')} value={baht(d.operating?.net)} tone={d.operating?.net >= 0 ? 'success' : 'danger'} />
              <StatCard label={t('acct.cf_investing')} value={baht(d.investing?.net)} />
              <StatCard label={t('acct.cf_financing')} value={baht(d.financing?.net)} />
            </div>
            <Card className="gap-2 p-5">
              <table className="w-full text-sm">
                <tbody>
                  <tr className="text-muted-foreground"><td className="pb-1 font-medium">{t('acct.cf_operating_activities')}</td><td /></tr>
                  {flowRow(t('acct.cf_net_income'), d.operating?.net_income ?? 0, -1)}
                  {(d.operating?.adjustments ?? []).map((a: any, i: number) => flowRow(`+ ${a.label ?? a.account_name}`, a.amount, i))}
                  {(d.operating?.working_capital ?? []).map((a: any, i: number) => flowRow(`Δ ${a.label ?? a.account_name}`, a.amount, 1000 + i))}
                  <tr className="border-t font-medium"><td className="py-1">{t('acct.cf_net_operating')}</td><td className="py-1 text-right tabular">{baht(d.operating?.net)}</td></tr>
                  {(d.investing?.lines ?? []).length > 0 && <tr className="text-muted-foreground"><td className="pt-3 pb-1 font-medium">{t('acct.cf_investing_activities')}</td><td /></tr>}
                  {(d.investing?.lines ?? []).map((a: any, i: number) => flowRow(a.label ?? a.account_name, a.amount, 2000 + i))}
                  {(d.financing?.lines ?? []).length > 0 && <tr className="text-muted-foreground"><td className="pt-3 pb-1 font-medium">{t('acct.cf_financing_activities')}</td><td /></tr>}
                  {(d.financing?.lines ?? []).map((a: any, i: number) => flowRow(a.label ?? a.account_name, a.amount, 3000 + i))}
                  <tr className="border-t font-semibold"><td className="py-1.5">{t('acct.cf_net_change')}</td><td className="py-1.5 text-right tabular">{baht(d.net_change_in_cash)}</td></tr>
                  <tr><td className="py-0.5 pr-3 text-muted-foreground">{t('acct.cf_beginning')}</td><td className="py-0.5 text-right tabular">{baht(d.cash_beginning)}</td></tr>
                  <tr><td className="py-0.5 pr-3 text-muted-foreground">{t('acct.cf_ending')}</td><td className="py-0.5 text-right tabular">{baht(d.cash_ending)}</td></tr>
                </tbody>
              </table>
            </Card>
            <Card className="flex-row flex-wrap items-center gap-2 p-5 text-sm">
              <ShieldCheck className="size-4 text-muted-foreground" />
              {t('acct.cf_note')}{' '}
              <Badge variant={d.reconciled ? 'success' : 'destructive'}>{d.reconciled ? t('acct.cf_reconciled') : t('acct.cf_not_reconciled')}</Badge>
            </Card>
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────── แยกประเภทรายบัญชี (GL detail / account ledger) ─────────────────────
// Every posted line for ONE account over a date range, with a running balance struck from the opening
// balance — the classic GL-detail drill-down behind the trial balance (GET /api/ledger/account-ledger).
function GLDetail() {
  const { t } = useLang();
  const accountsQ = useQuery<{ accounts: Account[] }>({ queryKey: ['accounts'], queryFn: () => api('/api/ledger/accounts') });
  const [account, setAccount] = useState('');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const q = useQuery<any>({ queryKey: ['gldetail', account, from, to], queryFn: () => api(`/api/ledger/account-ledger?account=${account}&from=${from}&to=${to}`), enabled: !!account });
  const d = q.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="gl-acct">{t('acct.col_account')}</Label>
          <select id="gl-acct" className={`${selectCls} min-w-[260px]`} value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">{t('acct.select_account')}</option>
            {accountsQ.data?.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
        </div>
        <div className="grid gap-1.5"><Label htmlFor="gl-from">{t('acct.from')}</Label><Input id="gl-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="grid gap-1.5"><Label htmlFor="gl-to">{t('acct.to')}</Label><Input id="gl-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      {!account ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">{t('acct.gl_select_prompt')}</Card>
      ) : (
        <StateView q={q}>
          {d && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard label={t('acct.opening_balance')} value={baht(d.opening_balance)} />
                <StatCard label={t('acct.gl_total_debit')} value={baht(d.total_debit)} tone="primary" />
                <StatCard label={t('acct.gl_total_credit')} value={baht(d.total_credit)} tone="primary" />
                <StatCard label={t('acct.col_balance')} value={baht(d.closing_balance)} tone="success" />
              </div>
              <Card className="gap-2 p-5">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="pb-2 font-medium">{t('acct.col_date')}</th>
                        <th className="pb-2 font-medium">{t('acct.col_entry_no')}</th>
                        <th className="pb-2 font-medium">{t('acct.col_source')}</th>
                        <th className="pb-2 font-medium">{t('acct.col_memo')}</th>
                        <th className="pb-2 text-right font-medium">{t('acct.col_debit')}</th>
                        <th className="pb-2 text-right font-medium">{t('acct.col_credit')}</th>
                        <th className="pb-2 text-right font-medium">{t('acct.col_running_balance')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t text-muted-foreground"><td className="py-1.5" colSpan={6}>{t('acct.gl_opening_row')}</td><td className="py-1.5 text-right tabular">{baht(d.opening_balance)}</td></tr>
                      {d.lines.map((l: any, i: number) => (
                        <tr key={i} className="border-t">
                          <td className="py-1.5 tabular">{thaiDate(l.date)}</td>
                          <td className="py-1.5 tabular">{l.entry_no}</td>
                          <td className="py-1.5">{l.source}{l.source_ref ? ` · ${l.source_ref}` : ''}</td>
                          <td className="py-1.5">{l.memo || <span className="text-muted-foreground">—</span>}</td>
                          <td className="py-1.5 text-right tabular">{l.debit ? baht(l.debit) : ''}</td>
                          <td className="py-1.5 text-right tabular">{l.credit ? baht(l.credit) : ''}</td>
                          <td className="py-1.5 text-right tabular font-medium">{baht(l.balance)}</td>
                        </tr>
                      ))}
                      {d.lines.length === 0 && <tr className="border-t"><td colSpan={7} className="py-4 text-center text-muted-foreground">{t('acct.gl_no_lines')}</td></tr>}
                      <tr className="border-t-2 font-semibold"><td className="py-1.5" colSpan={4}>{t('acct.gl_closing_row')}</td><td className="py-1.5 text-right tabular">{baht(d.total_debit)}</td><td className="py-1.5 text-right tabular">{baht(d.total_credit)}</td><td className="py-1.5 text-right tabular">{baht(d.closing_balance)}</td></tr>
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          )}
        </StateView>
      )}
    </div>
  );
}

// ───────────────────── กระทบยอดบัญชีย่อย (Subledger tie-out, GL-14) ─────────────────────
// Run reconciles a control account's GL balance vs its sub-ledger detail (AR/AP/INV/FA); certify is
// maker-checker (certifier ≠ runner). Backend: GET/POST /api/ledger/tie-out{,/run,/:id/certify}.
function SubledgerTieout() {
  const { t } = useLang();
  const me = useMe();
  const canRun = hasPerm(me.data, 'gl_close', 'gl_post', 'exec');
  const canCertify = hasPerm(me.data, 'gl_close', 'exec');
  const qc = useQueryClient();
  const [subledger, setSubledger] = useState<'AR' | 'AP' | 'INV' | 'FA'>('AR');
  const q = useQuery<any>({ queryKey: ['tieout'], queryFn: () => api('/api/ledger/tie-out') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['tieout'] });
  const run = useMutation({ mutationFn: () => api('/api/ledger/tie-out/run', { method: 'POST', body: JSON.stringify({ subledger }) }), onSuccess: () => { notifySuccess(t('acct.tie_run_ok', { sub: subledger })); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const certify = useMutation({ mutationFn: (id: number) => { const note = prompt(t('acct.tie_certify_prompt')) ?? undefined; return api(`/api/ledger/tie-out/${id}/certify`, { method: 'POST', body: JSON.stringify({ note }) }); }, onSuccess: () => { notifySuccess(t('acct.tie_certified')); refresh(); }, onError: (e: any) => notifyError(e.message) });
  const runs: any[] = q.data?.runs ?? [];
  const KNOWN_SUBS = ['AR', 'AP', 'INV', 'FA'];
  const subLabel = (k: string) => (KNOWN_SUBS.includes(k) ? t('acct.sub_' + k) : k);
  return (
    <div className="space-y-5">
      <Card className="flex-row flex-wrap items-center gap-2 p-4 text-sm">
        <ShieldCheck className="size-4 text-muted-foreground" />
        {t('acct.tie_sod_note')}
      </Card>
      {canRun && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="tie-sub">{t('acct.tie_subledger_label')}</Label>
            <select id="tie-sub" className={`${selectCls} min-w-[200px]`} value={subledger} onChange={(e) => setSubledger(e.target.value as 'AR' | 'AP' | 'INV' | 'FA')}>
              {(['AR', 'AP', 'INV', 'FA'] as const).map((s) => <option key={s} value={s}>{subLabel(s)}</option>)}
            </select>
          </div>
          <Button disabled={run.isPending} onClick={() => run.mutate()}><Scale className="size-4" /> {run.isPending ? t('acct.tie_running') : t('acct.tie_run_btn')}</Button>
        </div>
      )}
      <StateView q={q}>
        {runs.length === 0 ? (
          <Card className="gap-0 p-5"><span className="text-sm text-muted-foreground">{t('acct.tie_empty')}</span></Card>
        ) : (
          <DataTable
            rows={runs}
            rowKey={(r: any) => r.id}
            columns={[
              { key: 'subledger', label: t('acct.col_subledger'), render: (r: any) => subLabel(r.subledger) },
              { key: 'control_account', label: t('acct.col_control') },
              { key: 'as_of_date', label: t('acct.as_of'), render: (r: any) => thaiDate(r.as_of_date) },
              { key: 'glBalance', label: t('acct.col_gl_balance'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.glBalance)}</span> },
              { key: 'subledgerBalance', label: t('acct.col_subledger_balance'), align: 'right', render: (r: any) => <span className="tabular">{baht(r.subledgerBalance)}</span> },
              { key: 'variance', label: t('acct.col_variance'), align: 'right', render: (r: any) => <span className={`tabular ${Math.abs(r.variance) >= 0.01 ? 'text-destructive' : ''}`}>{baht(r.variance)}</span> },
              { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              { key: 'run_by', label: t('acct.col_run_by') },
              { key: 'certified_by', label: t('acct.col_certified_by'), render: (r: any) => r.certified_by || <span className="text-muted-foreground">—</span> },
              { key: 'act', label: '', sortable: false, render: (r: any) => (canCertify && r.status !== 'Certified' && r.run_by !== me.data?.username) ? <Button size="sm" variant="outline" disabled={certify.isPending} onClick={() => certify.mutate(r.id)}><Check className="size-4" /> {t('acct.certify')}</Button> : null },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}
