'use client';

// Shared running-balance statement panel for the AR (customer) and AP (vendor) cards. The parent owns the
// fetch (customer keys by tenant_id, vendor by name) and the date-range state; this renders the summary
// (opening / charges / payments / closing) + the dated line table with a running balance, and CSV export.
import { Download } from 'lucide-react';

import { baht, thaiDate } from '@/lib/format';
import { StateView } from '@/components/state-view';
import { StatCard } from '@/components/stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const TYPE_TH: Record<string, string> = { invoice: 'ใบแจ้งหนี้', receipt: 'รับชำระ', bill: 'ตั้งหนี้ (ใบวางบิล)', payment: 'จ่ายชำระ' };

export interface StatementData {
  party?: string;
  reporting_currency?: string;
  opening_balance: number;
  total_charges: number;
  total_payments: number;
  closing_balance: number;
  lines: Array<{ date: string; type: string; ref: string; doc_currency?: string; charge: number; payment: number; balance: number }>;
}

export function AccountStatement({
  title,
  side,
  query,
  from,
  to,
  setFrom,
  setTo,
  filename,
  empty,
}: {
  title: string;
  /** 'ar' → charges are ใบแจ้งหนี้ (debit), payments are รับชำระ; 'ap' → charges are bills, payments are จ่าย. */
  side: 'ar' | 'ap';
  query: { data?: StatementData; isLoading: boolean; error: unknown };
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
  filename: string;
  /** Shown when no party is selected yet (query disabled). */
  empty?: boolean;
}) {
  const d = query.data;
  const chargeLabel = side === 'ar' ? 'เดบิต (ใบแจ้งหนี้)' : 'ตั้งหนี้';
  const payLabel = side === 'ar' ? 'รับชำระ' : 'จ่ายชำระ';

  const exportCsv = () => {
    if (!d) return;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['date', 'type', 'ref', 'currency', 'charge', 'payment', 'balance'];
    const rows = [
      header.join(','),
      ...d.lines.map((l) => [l.date, TYPE_TH[l.type] ?? l.type, l.ref, l.doc_currency ?? '', l.charge, l.payment, l.balance].map(esc).join(',')),
    ];
    const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (empty) {
    return (
      <Card className="grid min-h-[300px] place-items-center p-8 text-center text-sm text-muted-foreground">
        เลือก{side === 'ar' ? 'ลูกหนี้' : 'เจ้าหนี้'}จากรายการเพื่อดูการ์ดบัญชี (statement)
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">การ์ดบัญชี — ยอดยกมา + รายการเคลื่อนไหว + ยอดคงเหลือสะสม</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="st-from">ตั้งแต่</Label>
            <Input id="st-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="st-to">ถึง</Label>
            <Input id="st-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px]" />
          </div>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!d}>
            <Download className="size-4" /> CSV
          </Button>
        </div>
      </div>

      <StateView q={query}>
        {d && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="ยอดยกมา" value={baht(d.opening_balance)} />
              <StatCard label={chargeLabel} value={baht(d.total_charges)} tone="primary" />
              <StatCard label={payLabel} value={baht(d.total_payments)} tone="success" />
              <StatCard label="ยอดคงเหลือ" value={baht(d.closing_balance)} tone={d.closing_balance > 0.005 ? 'danger' : 'default'} />
            </div>
            <Card className="gap-2 p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-muted-foreground">รายการเคลื่อนไหว</h3>
                {d.reporting_currency && d.reporting_currency !== 'THB' && <Badge variant="secondary">{d.reporting_currency}</Badge>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="pb-2 font-medium">วันที่</th>
                      <th className="pb-2 font-medium">ประเภท</th>
                      <th className="pb-2 font-medium">เอกสาร</th>
                      <th className="pb-2 text-right font-medium">{chargeLabel}</th>
                      <th className="pb-2 text-right font-medium">{payLabel}</th>
                      <th className="pb-2 text-right font-medium">คงเหลือ</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t text-muted-foreground">
                      <td className="py-1.5" colSpan={5}>ยอดยกมา (opening)</td>
                      <td className="py-1.5 text-right tabular">{baht(d.opening_balance)}</td>
                    </tr>
                    {d.lines.map((l, i) => (
                      <tr key={`${l.ref}-${i}`} className="border-t">
                        <td className="py-1.5 tabular">{thaiDate(l.date)}</td>
                        <td className="py-1.5">
                          <Badge variant={l.payment > 0 ? 'success' : 'secondary'}>{TYPE_TH[l.type] ?? l.type}</Badge>
                        </td>
                        <td className="py-1.5 tabular">{l.ref}</td>
                        <td className="py-1.5 text-right tabular">{l.charge ? baht(l.charge) : '—'}</td>
                        <td className="py-1.5 text-right tabular">{l.payment ? baht(l.payment) : '—'}</td>
                        <td className="py-1.5 text-right tabular font-medium">{baht(l.balance)}</td>
                      </tr>
                    ))}
                    {d.lines.length === 0 && (
                      <tr className="border-t">
                        <td colSpan={6} className="py-4 text-center text-muted-foreground">ไม่มีรายการในช่วงเวลานี้</td>
                      </tr>
                    )}
                    <tr className="border-t-2 font-semibold">
                      <td className="py-1.5" colSpan={3}>ยอดคงเหลือปลายงวด (closing)</td>
                      <td className="py-1.5 text-right tabular">{baht(d.total_charges)}</td>
                      <td className="py-1.5 text-right tabular">{baht(d.total_payments)}</td>
                      <td className="py-1.5 text-right tabular">{baht(d.closing_balance)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}
      </StateView>
    </div>
  );
}
