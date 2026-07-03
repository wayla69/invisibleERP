'use client';

// รายการบัญชีตั้งเวลา (GL scheduled entries) — the two GL-automation engines that previously had no UI:
//   • รายการตั้งเวลา (Recurring journals, GL-08)  → GET/POST /api/ledger/recurring, /recurring/:id/active, /recurring/run
//   • ค่าใช้จ่ายจ่ายล่วงหน้า (Prepaid amortization, GL-09) → GET/POST /api/ledger/prepaid, /prepaid/run
// A recurring run posts each due template as a DRAFT JE (maker-checker, GL-05); a prepaid run amortizes one
// straight-line slice (Dr expense / Cr 1280). Both runs are idempotent.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Play, Plus, Save, X } from 'lucide-react';

import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useMe, hasPerm } from '@/lib/auth';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

type Account = { code: string; name: string; type: string };
const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export function GlSchedulesClient() {
  return (
    <div>
      <PageHeader
        title="รายการบัญชีตั้งเวลา"
        description="รายการซ้ำตามรอบ (recurring) และการตัดจ่ายค่าใช้จ่ายจ่ายล่วงหน้า (prepaid) — ลงบัญชีอัตโนมัติเมื่อถึงกำหนด"
      />
      <Tabs
        urlParam="tab"
        tabs={[
          { key: 'recurring', label: 'รายการตั้งเวลา (Recurring)', content: <Recurring /> },
          { key: 'prepaid', label: 'ค่าใช้จ่ายจ่ายล่วงหน้า (Prepaid)', content: <Prepaid /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Recurring journals (GL-08) ─────────────────────────
type Line = { account_code: string; debit: string; credit: string };
const emptyLine = (): Line => ({ account_code: '', debit: '', credit: '' });

function Recurring() {
  const me = useMe();
  const canManage = hasPerm(me.data, 'gl_post', 'exec');
  const qc = useQueryClient();
  const accountsQ = useQuery<{ accounts: Account[] }>({ queryKey: ['accounts'], queryFn: () => api('/api/ledger/accounts') });
  const q = useQuery<any>({ queryKey: ['recurring'], queryFn: () => api('/api/ledger/recurring') });

  const [name, setName] = useState('');
  const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>('monthly');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const sumD = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0);
  const sumC = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(sumD - sumC) < 0.005 && sumD > 0;

  const refresh = () => qc.invalidateQueries({ queryKey: ['recurring'] });
  const create = useMutation({
    mutationFn: () => api('/api/ledger/recurring', {
      method: 'POST',
      body: JSON.stringify({
        name, frequency, memo: memo || undefined,
        lines: lines.filter((l) => l.account_code && (Number(l.debit) || Number(l.credit))).map((l) => ({ account_code: l.account_code, debit: Number(l.debit) || undefined, credit: Number(l.credit) || undefined })),
      }),
    }),
    onSuccess: () => { notifySuccess('สร้างรายการตั้งเวลาแล้ว'); setName(''); setMemo(''); setLines([emptyLine(), emptyLine()]); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const toggle = useMutation({ mutationFn: (v: { id: number; active: boolean }) => api(`/api/ledger/recurring/${v.id}/active`, { method: 'POST', body: JSON.stringify({ active: v.active }) }), onSuccess: refresh, onError: (e: any) => notifyError(e.message) });
  const runDue = useMutation({
    mutationFn: () => api<{ posted: number; scanned: number }>('/api/ledger/recurring/run', { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(`ลงรายการที่ถึงกำหนด ${r.posted}/${r.scanned} รายการ (ฉบับร่าง — รออนุมัติ)`); refresh(); qc.invalidateQueries({ queryKey: ['je-pending'] }); qc.invalidateQueries({ queryKey: ['journal'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const rows: any[] = q.data?.recurring ?? [];
  const FREQ_TH: Record<string, string> = { daily: 'รายวัน', weekly: 'รายสัปดาห์', monthly: 'รายเดือน' };

  return (
    <div className="grid gap-5">
      {canManage && (
        <Card className="gap-3 p-5">
          <h3 className="text-base font-semibold">สร้างรายการตั้งเวลา</h3>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5"><Label htmlFor="rc-name">ชื่อรายการ</Label><Input id="rc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น ค่าเช่าสำนักงาน" /></div>
            <div className="grid gap-1.5">
              <Label htmlFor="rc-freq">ความถี่</Label>
              <select id="rc-freq" className={selectCls} value={frequency} onChange={(e) => setFrequency(e.target.value as 'daily' | 'weekly' | 'monthly')}>
                <option value="daily">รายวัน</option>
                <option value="weekly">รายสัปดาห์</option>
                <option value="monthly">รายเดือน</option>
              </select>
            </div>
            <div className="grid flex-1 gap-1.5"><Label htmlFor="rc-memo">คำอธิบาย</Label><Input id="rc-memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="memo (ถ้ามี)" /></div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="pb-2 font-medium">บัญชี</th>
                <th className="w-[130px] pb-2 font-medium">เดบิต</th>
                <th className="w-[130px] pb-2 font-medium">เครดิต</th>
                <th className="w-10 pb-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="py-1 pr-2">
                    <select className={selectCls} value={l.account_code} onChange={(e) => setLine(i, { account_code: e.target.value })}>
                      <option value="">— เลือกบัญชี —</option>
                      {accountsQ.data?.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                    </select>
                  </td>
                  <td className="py-1 pr-2"><Input type="number" min="0" value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: '' })} /></td>
                  <td className="py-1 pr-2"><Input type="number" min="0" value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: '' })} /></td>
                  <td className="py-1">{lines.length > 2 && <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><X className="size-4" /></Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}><Plus className="size-4" /> เพิ่มบรรทัด</Button>
            <span className="text-sm">
              เดบิต <strong className="tabular">{baht(sumD)}</strong> · เครดิต <strong className="tabular">{baht(sumC)}</strong>{' '}
              <Badge variant={balanced ? 'success' : 'warning'}>{balanced ? 'สมดุล' : 'ยังไม่สมดุล'}</Badge>
            </span>
            <Button disabled={!name || !balanced || create.isPending} onClick={() => create.mutate()}><Save className="size-4" /> {create.isPending ? 'กำลังบันทึก…' : 'สร้างรายการ'}</Button>
          </div>
        </Card>
      )}

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground">รายการตั้งเวลาทั้งหมด</h3>
          {canManage && <Button variant="outline" size="sm" disabled={runDue.isPending} onClick={() => runDue.mutate()}><Play className="size-4" /> ลงรายการที่ถึงกำหนด</Button>}
        </div>
        <StateView q={q}>
          <div className="grid gap-3">
            {rows.length === 0 && <Card className="gap-0 p-5"><span className="text-sm text-muted-foreground">ยังไม่มีรายการตั้งเวลา</span></Card>}
            {rows.map((r) => (
              <Card key={r.id} className="gap-2 p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>{r.name}</strong>
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Badge variant="secondary">{FREQ_TH[r.frequency] ?? r.frequency}</Badge>
                    <span className="flex items-center gap-1"><CalendarClock className="size-3.5" /> ครั้งถัดไป {thaiDate(r.next_run_date)}</span>
                    <Badge variant={r.active ? 'success' : 'muted'}>{r.active ? 'ใช้งาน' : 'พัก'}</Badge>
                    {canManage && <Button size="sm" variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: r.id, active: !r.active })}>{r.active ? 'พัก' : 'เปิดใช้'}</Button>}
                  </span>
                </div>
                {r.memo && <div className="text-sm text-muted-foreground">{r.memo}</div>}
                <table className="w-full text-sm">
                  <tbody>
                    {(r.lines ?? []).map((l: any, j: number) => (
                      <tr key={j}><td className="py-0.5">{l.account_code}</td><td className="py-0.5 text-right tabular">{l.debit ? baht(l.debit) : ''}</td><td className="py-0.5 text-right tabular">{l.credit ? baht(l.credit) : ''}</td></tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            ))}
          </div>
        </StateView>
      </div>
    </div>
  );
}

// ───────────────────────── Prepaid amortization (GL-09) ─────────────────────────
function Prepaid() {
  const me = useMe();
  const canManage = hasPerm(me.data, 'gl_post', 'exec');
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['prepaid'], queryFn: () => api('/api/ledger/prepaid') });

  const [name, setName] = useState('');
  const [total, setTotal] = useState('');
  const [months, setMonths] = useState('12');
  const [expenseAccount, setExpenseAccount] = useState('');
  const [capitalize, setCapitalize] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ['prepaid'] });
  const create = useMutation({
    mutationFn: () => api('/api/ledger/prepaid', {
      method: 'POST',
      body: JSON.stringify({ name, total_amount: Number(total), months: Number(months), expense_account: expenseAccount || undefined, capitalize }),
    }),
    onSuccess: () => { notifySuccess('สร้างตารางตัดจ่ายแล้ว'); setName(''); setTotal(''); setMonths('12'); setExpenseAccount(''); setCapitalize(false); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const runDue = useMutation({
    mutationFn: () => api<{ posted?: number; scanned?: number }>('/api/ledger/prepaid/run', { method: 'POST' }),
    onSuccess: (r) => { notifySuccess(`ตัดจ่ายงวดที่ถึงกำหนด ${r.posted ?? 0} รายการ`); refresh(); qc.invalidateQueries({ queryKey: ['journal'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const rows: any[] = q.data?.schedules ?? [];
  const valid = name && Number(total) > 0 && Number.isInteger(Number(months)) && Number(months) >= 1;

  return (
    <div className="grid gap-5">
      {canManage && (
        <Card className="gap-3 p-5">
          <h3 className="text-base font-semibold">สร้างตารางตัดจ่าย (Prepaid)</h3>
          <p className="text-sm text-muted-foreground">ตัดจ่ายแบบเส้นตรง งวดละ {Number(total) > 0 && Number(months) >= 1 ? baht(Number(total) / Number(months)) : '—'} (Dr ค่าใช้จ่าย / Cr 1280)</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5"><Label htmlFor="pp-name">ชื่อรายการ</Label><Input id="pp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น ประกันภัยรายปี" /></div>
            <div className="grid gap-1.5"><Label htmlFor="pp-total">ยอดรวม</Label><Input id="pp-total" type="number" min="0" value={total} onChange={(e) => setTotal(e.target.value)} className="w-[140px]" /></div>
            <div className="grid gap-1.5"><Label htmlFor="pp-months">จำนวนงวด (เดือน)</Label><Input id="pp-months" type="number" min="1" value={months} onChange={(e) => setMonths(e.target.value)} className="w-[120px]" /></div>
            <div className="grid gap-1.5"><Label htmlFor="pp-acct">บัญชีค่าใช้จ่าย</Label><Input id="pp-acct" value={expenseAccount} onChange={(e) => setExpenseAccount(e.target.value)} placeholder="5100" className="w-[120px]" /></div>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" checked={capitalize} onChange={(e) => setCapitalize(e.target.checked)} className="size-4" />
              ตั้งยอดจ่ายล่วงหน้าตอนนี้ (Dr 1280 / Cr 1000)
            </label>
            <Button disabled={!valid || create.isPending} onClick={() => create.mutate()}><Save className="size-4" /> {create.isPending ? 'กำลังบันทึก…' : 'สร้างตาราง'}</Button>
          </div>
        </Card>
      )}

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground">ตารางตัดจ่ายทั้งหมด</h3>
          {canManage && <Button variant="outline" size="sm" disabled={runDue.isPending} onClick={() => runDue.mutate()}><Play className="size-4" /> ตัดจ่ายงวดที่ถึงกำหนด</Button>}
        </div>
        <StateView q={q}>
          <div className="grid gap-3">
            {rows.length === 0 && <Card className="gap-0 p-5"><span className="text-sm text-muted-foreground">ยังไม่มีตารางตัดจ่าย</span></Card>}
            {rows.map((r) => {
              const pct = r.total_amount > 0 ? Math.round((r.amortized_amount / r.total_amount) * 100) : 0;
              return (
                <Card key={r.id} className="gap-2 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong>{r.name} <span className="font-normal text-muted-foreground">· {r.schedule_no}</span></strong>
                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                      งวด {r.periods_posted}/{r.months} · ครั้งถัดไป {thaiDate(r.next_run_date)}
                      <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <StatCard label="ยอดรวม" value={baht(r.total_amount)} />
                    <StatCard label="ตัดจ่ายแล้ว" value={baht(r.amortized_amount)} tone="primary" hint={`${pct}%`} />
                    <StatCard label="คงเหลือ" value={baht(r.remaining)} tone="success" />
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                </Card>
              );
            })}
          </div>
        </StateView>
      </div>
    </div>
  );
}
