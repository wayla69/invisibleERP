'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, Kpi, DataTable, Badge, StateView } from '@/components/ui';
import { Tabs, Msg } from '@/components/tabs';
import { baht, thaiDate } from '@/lib/format';

type Account = { code: string; name: string; type: string };
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';

export default function AccountingPage() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>📒 บัญชีแยกประเภท (General Ledger)</h1>
      <p className="label" style={{ marginTop: -8 }}>บัญชีคู่ (double-entry) — ทุกการขายลงบัญชีอัตโนมัติ เดบิตต้องเท่าเครดิตเสมอ</p>
      <Tabs
        tabs={[
          { key: 'tb', label: '⚖️ งบทดลอง', content: <TrialBalance /> },
          { key: 'journal', label: '📝 สมุดรายวัน', content: <Journal /> },
          { key: 'pl', label: '📈 งบกำไรขาดทุน', content: <IncomeStatement /> },
          { key: 'bs', label: '🏦 งบดุล', content: <BalanceSheet /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── งบทดลอง ─────────────────────────
function TrialBalance() {
  const q = useQuery<any>({ queryKey: ['tb'], queryFn: () => api('/api/ledger/trial-balance') });
  return (
    <StateView q={q}>
      {q.data && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <Kpi label="รวมเดบิต" value={baht(q.data.totals.debit)} accent="var(--navy)" />
            <Kpi label="รวมเครดิต" value={baht(q.data.totals.credit)} accent="var(--navy)" />
            <Kpi label="สถานะ" value={<Badge value={q.data.totals.balanced ? 'สมดุล' : 'ไม่สมดุล'} />} />
          </div>
          <DataTable
            rows={q.data.rows}
            columns={[
              { key: 'account_code', label: 'รหัส' },
              { key: 'account_name', label: 'ชื่อบัญชี' },
              { key: 'account_type', label: 'ประเภท' },
              { key: 'debit', label: 'เดบิต', render: (r: any) => baht(r.debit) },
              { key: 'credit', label: 'เครดิต', render: (r: any) => baht(r.credit) },
              { key: 'balance', label: 'ยอดคงเหลือ', render: (r: any) => baht(r.balance) },
            ]}
          />
        </>
      )}
    </StateView>
  );
}

// ───────────────────────── สมุดรายวัน + ลงรายการ ─────────────────────────
type Line = { account_code: string; debit: string; credit: string };
const emptyLine = (): Line => ({ account_code: '', debit: '', credit: '' });

function Journal() {
  const qc = useQueryClient();
  const accounts = useQuery<{ accounts: Account[] }>({ queryKey: ['accounts'], queryFn: () => api('/api/ledger/accounts') });
  const journal = useQuery<any>({ queryKey: ['journal'], queryFn: () => api('/api/ledger/journal?limit=30') });

  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [msg, setMsg] = useState('');

  const sumDebit = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0);
  const sumCredit = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(sumDebit - sumCredit) < 0.005 && sumDebit > 0;

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
      setMsg(`✅ บันทึกสำเร็จ: ${r.entry_no}`);
      setMemo(''); setLines([emptyLine(), emptyLine()]);
      qc.invalidateQueries({ queryKey: ['journal'] });
      qc.invalidateQueries({ queryKey: ['tb'] });
    },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <Card>
        <h3 style={{ marginTop: 0 }}>✍️ ลงรายการบัญชี (Manual Journal)</h3>
        <input className="input" placeholder="คำอธิบาย (memo)" value={memo} onChange={(e) => setMemo(e.target.value)} style={{ marginBottom: 10 }} />
        <table>
          <thead><tr><th>บัญชี</th><th style={{ width: 130 }}>เดบิต</th><th style={{ width: 130 }}>เครดิต</th><th style={{ width: 40 }}></th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select className="input" value={l.account_code} onChange={(e) => setLine(i, { account_code: e.target.value })}>
                    <option value="">— เลือกบัญชี —</option>
                    {accounts.data?.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                  </select>
                </td>
                <td><input className="input" type="number" min="0" value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: '' })} /></td>
                <td><input className="input" type="number" min="0" value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: '' })} /></td>
                <td>{lines.length > 2 && <button className="btn" style={{ padding: '4px 8px' }} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, flexWrap: 'wrap', gap: 8 }}>
          <button className="btn" style={{ background: 'var(--muted)' }} onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ เพิ่มบรรทัด</button>
          <span style={{ fontSize: 14 }}>
            เดบิต <strong>{baht(sumDebit)}</strong> · เครดิต <strong>{baht(sumCredit)}</strong>{' '}
            <Badge value={balanced ? 'สมดุล' : 'ยังไม่สมดุล'} />
          </span>
          <button className="btn" disabled={!balanced || post.isPending} onClick={() => post.mutate()}>
            {post.isPending ? 'กำลังบันทึก…' : '💾 บันทึกรายการ'}
          </button>
        </div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>

      <div>
        <h3>รายการล่าสุด</h3>
        <StateView q={journal}>
          {journal.data && (
            <div style={{ display: 'grid', gap: 10 }}>
              {journal.data.entries.length === 0 && <Card><span className="label">ยังไม่มีรายการ</span></Card>}
              {journal.data.entries.map((e: any) => (
                <Card key={e.entry_no}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    <strong>{e.entry_no}</strong>
                    <span className="label">{thaiDate(e.entry_date)} · {e.source}{e.source_ref ? ` · ${e.source_ref}` : ''} · <Badge value={e.status} /></span>
                  </div>
                  {e.memo && <div className="label" style={{ marginTop: 2 }}>{e.memo}</div>}
                  <table style={{ marginTop: 6 }}>
                    <tbody>
                      {e.lines.map((l: any, j: number) => (
                        <tr key={j}>
                          <td>{l.account_code}</td>
                          <td style={{ textAlign: 'right' }}>{l.debit ? baht(l.debit) : ''}</td>
                          <td style={{ textAlign: 'right' }}>{l.credit ? baht(l.credit) : ''}</td>
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

// ───────────────────────── งบกำไรขาดทุน ─────────────────────────
function IncomeStatement() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const q = useQuery<any>({ queryKey: ['pl', from, to], queryFn: () => api(`/api/ledger/income-statement?from=${from}&to=${to}`) });
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap' }}>
        <label className="label">ตั้งแต่<input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="label">ถึง<input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <StateView q={q}>
        {q.data && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Kpi label="รายได้" value={baht(q.data.revenue)} accent="var(--navy)" />
            <Kpi label="ค่าใช้จ่าย" value={baht(q.data.expense)} accent="var(--ruby)" />
            <Kpi label="กำไรสุทธิ" value={baht(q.data.net_income)} accent={q.data.net_income >= 0 ? '#059669' : 'var(--ruby)'} />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── งบดุล ─────────────────────────
function BalanceSheet() {
  const [asOf, setAsOf] = useState(today());
  const q = useQuery<any>({ queryKey: ['bs', asOf], queryFn: () => api(`/api/ledger/balance-sheet?as_of=${asOf}`) });
  return (
    <div>
      <label className="label" style={{ display: 'block', marginBottom: 16 }}>
        ณ วันที่<input className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ maxWidth: 200 }} />
      </label>
      <StateView q={q}>
        {q.data && (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <Kpi label="สินทรัพย์" value={baht(q.data.assets)} accent="var(--navy)" />
              <Kpi label="หนี้สิน" value={baht(q.data.liabilities)} accent="var(--ruby)" />
              <Kpi label="ส่วนของเจ้าของ" value={baht(q.data.equity)} />
              <Kpi label="กำไรสะสม" value={baht(q.data.net_income)} />
            </div>
            <Card>
              สินทรัพย์ {baht(q.data.assets)} = หนี้สิน+ทุน {baht(q.data.liabilities_plus_equity)}{' '}
              <Badge value={q.data.balanced ? 'สมดุล' : 'ไม่สมดุล'} />
            </Card>
          </>
        )}
      </StateView>
    </div>
  );
}
