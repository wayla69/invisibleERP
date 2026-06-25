'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Landmark, Scale, Wallet, RefreshCw, X, CheckCircle2, FileText } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function BankPage() {
  const [selected, setSelected] = useState<number | null>(null);
  const q = useQuery<any>({ queryKey: ['bank-accounts'], queryFn: () => api('/api/bank/accounts') });

  return (
    <ModulePage
      title="ธนาคาร (Bank)"
      description="บัญชีธนาคาร นำเข้า statement และกระทบยอดกับบัญชี GL"
      query={q}
      statsClassName="xl:grid-cols-3"
      stats={
        q.data && (
          <>
            <StatCard label="จำนวนบัญชีธนาคาร" value={num(q.data.count)} icon={Landmark} tone="primary" />
            <StatCard
              label="ยอดยกมารวม"
              value={baht((q.data.accounts ?? []).reduce((a: number, b: any) => a + Number(b.opening_balance ?? 0), 0))}
              icon={Wallet}
            />
          </>
        )
      }
    >
      {q.data && (
        <>
          <DataTable
            rows={q.data.accounts}
            onRowClick={(r: any) => setSelected(r.id)}
            columns={[
              { key: 'bank_name', label: 'ธนาคาร' },
              { key: 'account_no', label: 'เลขที่บัญชี' },
              { key: 'gl_account_code', label: 'บัญชี GL' },
              { key: 'currency', label: 'สกุลเงิน' },
              { key: 'opening_balance', label: 'ยอดยกมา', align: 'right', render: (r: any) => <span className="tabular">{baht(r.opening_balance)}</span> },
            ]}
            emptyState={{
              icon: Landmark,
              title: 'ยังไม่มีบัญชีธนาคาร',
              description: 'เพิ่มบัญชีธนาคารและผูกกับบัญชี GL เพื่อเริ่มนำเข้า statement และกระทบยอด',
            }}
          />
          {selected != null && <Reconciliation bankAccountId={selected} onClose={() => setSelected(null)} />}
        </>
      )}
    </ModulePage>
  );
}

// ───────────────────────── per-account reconciliation + auto-match ─────────────────────────
function Reconciliation({ bankAccountId, onClose }: { bankAccountId: number; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['bank-recon', bankAccountId], queryFn: () => api(`/api/bank/accounts/${bankAccountId}/reconciliation`) });

  const autoMatch = useMutation({
    mutationFn: () => api<any>(`/api/bank/accounts/${bankAccountId}/auto-match`, { method: 'POST' }),
    onSuccess: (r) => {
      notifySuccess(`จับคู่อัตโนมัติ ${num(r.matched)} รายการ`);
      qc.invalidateQueries({ queryKey: ['bank-recon', bankAccountId] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <Card className="gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Scale className="size-4 text-muted-foreground" /> กระทบยอด · บัญชี #{bankAccountId}
        </h3>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="ยอดตามบัญชี GL" value={baht(q.data.gl_balance)} tone="primary" />
              <StatCard label="ยอดตาม statement" value={baht(q.data.statement_balance)} />
              <StatCard label="จับคู่แล้ว" value={baht(q.data.matched_total)} tone="success" />
              <StatCard
                label="ผลต่าง"
                value={baht(q.data.difference)}
                tone={Math.abs(Number(q.data.difference)) < 0.01 ? 'success' : 'danger'}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={autoMatch.isPending} onClick={() => autoMatch.mutate()}>
                <RefreshCw className="size-4" /> {autoMatch.isPending ? 'กำลังจับคู่…' : 'จับคู่อัตโนมัติ'}
              </Button>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <h4 className="mb-3 text-sm font-semibold text-muted-foreground">รายการ statement ที่ยังไม่กระทบยอด</h4>
                <DataTable
                  rows={q.data.unmatched_statement}
                  columns={[
                    { key: 'date', label: 'วันที่', render: (r: any) => thaiDate(r.date) },
                    { key: 'description', label: 'รายละเอียด', render: (r: any) => r.description ?? '—' },
                    { key: 'amount', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
                  ]}
                  emptyState={{
                    icon: CheckCircle2,
                    title: 'ไม่มีรายการ statement ค้าง',
                    description: 'รายการจาก statement ถูกกระทบยอดครบแล้ว',
                  }}
                  dense
                />
              </div>
              <div>
                <h4 className="mb-3 text-sm font-semibold text-muted-foreground">รายการบัญชี GL ที่ยังไม่กระทบยอด</h4>
                <DataTable
                  rows={q.data.unmatched_book}
                  columns={[
                    { key: 'entry_no', label: 'เลขที่บัญชี' },
                    { key: 'entry_date', label: 'วันที่', render: (r: any) => thaiDate(r.entry_date) },
                    { key: 'amount', label: 'จำนวน', align: 'right', render: (r: any) => <span className="tabular">{baht(r.amount)}</span> },
                  ]}
                  emptyState={{
                    icon: FileText,
                    title: 'ไม่มีรายการบัญชี GL ค้าง',
                    description: 'รายการในบัญชี GL ถูกกระทบยอดครบแล้ว',
                  }}
                  dense
                />
              </div>
            </div>
          </div>
        )}
      </StateView>
    </Card>
  );
}
