'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, HandCoins, Scale } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

interface IcTxn {
  ic_no: string;
  from_tenant_id: number;
  to_tenant_id: number;
  amount: number;
  settled_amount: number;
  outstanding: number;
  currency: string;
  category: string;
  status: string;
  txn_date: string;
  description: string | null;
}
interface IcListResp { ic_transactions: IcTxn[]; count: number }
interface ReconResp {
  total_due_from: number;
  total_due_to: number;
  eliminates: boolean;
  difference: number;
  by_tenant: { tenant_id: number; due_from: number; due_to: number }[];
  by_pair: { from_tenant_id: number; to_tenant_id: number; gross: number; settled: number; outstanding: number; count: number }[];
}

export default function IntercompanyPage() {
  return (
    <div>
      <PageHeader
        title="ระหว่างบริษัท (Intercompany)"
        description="รายการ Due-From / Due-To ระหว่างกิจการในเครือ พร้อมการตัดรายการระหว่างกัน (HQ ลงทั้งสองขา)"
      />
      <Tabs
        tabs={[
          { key: 'txns', label: 'รายการ', content: <TransactionsTab /> },
          { key: 'recon', label: 'ตัดรายการ (Reconciliation)', content: <ReconciliationTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── รายการระหว่างบริษัท ─────────────────────────
function TransactionsTab() {
  const [status, setStatus] = useState('');
  const q = useQuery<IcListResp>({
    queryKey: ['ic-list', status],
    queryFn: () => api(`/api/intercompany${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  });

  const statuses = ['', 'Open', 'Partial', 'Settled'];
  const d = q.data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {statuses.map((s) => (
          <Button key={s || 'all'} size="sm" variant={status === s ? 'default' : 'outline'} onClick={() => setStatus(s)}>
            {s || 'ทั้งหมด'}
          </Button>
        ))}
      </div>

      <StateView q={q}>
        {d && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="จำนวนรายการ" value={d.count} icon={ArrowLeftRight} tone="primary" />
              <StatCard label="มูลค่ารวม" value={baht(d.ic_transactions.reduce((a, t) => a + t.amount, 0))} icon={HandCoins} />
              <StatCard
                label="คงค้างรวม"
                value={baht(d.ic_transactions.reduce((a, t) => a + t.outstanding, 0))}
                tone="warning"
              />
            </div>
            <DataTable
              rows={d.ic_transactions}
              rowKey={(r) => r.ic_no}
              columns={[
                { key: 'ic_no', label: 'เลขที่', render: (r) => <span className="font-medium">{r.ic_no}</span> },
                { key: 'txn_date', label: 'วันที่', render: (r) => thaiDate(r.txn_date) },
                { key: 'from_tenant_id', label: 'เจ้าหนี้ (From)', align: 'right', render: (r) => <span className="tabular">#{r.from_tenant_id}</span> },
                { key: 'to_tenant_id', label: 'ลูกหนี้ (To)', align: 'right', render: (r) => <span className="tabular">#{r.to_tenant_id}</span> },
                { key: 'category', label: 'ประเภท' },
                { key: 'amount', label: 'มูลค่า', align: 'right', render: (r) => <span className="tabular">{baht(r.amount)}</span> },
                { key: 'settled_amount', label: 'ชำระแล้ว', align: 'right', render: (r) => <span className="tabular">{baht(r.settled_amount)}</span> },
                { key: 'outstanding', label: 'คงค้าง', align: 'right', render: (r) => <span className="tabular">{baht(r.outstanding)}</span> },
                { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                { key: '_act', label: '', sortable: false, render: (r) => <SettleButton txn={r} /> },
              ]}
              emptyText="ยังไม่มีรายการระหว่างบริษัท"
            />
          </div>
        )}
      </StateView>
    </div>
  );
}

// ───────────────────────── ชำระรายการ (settle) ─────────────────────────
function SettleButton({ txn }: { txn: IcTxn }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(txn.outstanding));
  const [msg, setMsg] = useState('');

  const settle = useMutation({
    mutationFn: () =>
      api<{ ic_no: string; settled_amount: number; status: string }>(`/api/intercompany/${encodeURIComponent(txn.ic_no)}/settle`, {
        method: 'POST',
        body: JSON.stringify({ amount: Number(amount) }),
      }),
    onSuccess: (r) => {
      setMsg(`✅ ชำระแล้ว ${baht(r.settled_amount)} · ${r.status}`);
      qc.invalidateQueries({ queryKey: ['ic-list'] });
      qc.invalidateQueries({ queryKey: ['ic-recon'] });
    },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });

  if (txn.status === 'Settled') return <span className="text-xs text-muted-foreground">ชำระครบ</span>;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <HandCoins className="size-4" /> ชำระ
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>ชำระรายการ {txn.ic_no}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="settle-amt">จำนวนเงิน (คงค้าง {baht(txn.outstanding)})</Label>
          <Input
            id="settle-amt"
            type="number"
            min="0"
            max={txn.outstanding}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
        </div>
        <DialogFooter>
          <Button
            disabled={settle.isPending || !(Number(amount) > 0)}
            onClick={() => settle.mutate()}
          >
            {settle.isPending ? 'กำลังชำระ…' : 'ยืนยันการชำระ'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── ตัดรายการระหว่างกัน ─────────────────────────
function ReconciliationTab() {
  const q = useQuery<ReconResp>({ queryKey: ['ic-recon'], queryFn: () => api('/api/intercompany/reconciliation') });
  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="ลูกหนี้ระหว่างกัน (Due-From)" value={baht(q.data.total_due_from)} icon={Scale} tone="primary" />
            <StatCard label="เจ้าหนี้ระหว่างกัน (Due-To)" value={baht(q.data.total_due_to)} icon={Scale} tone="info" />
            <StatCard label="ผลต่าง" value={baht(q.data.difference)} tone={Math.abs(q.data.difference) < 0.01 ? 'success' : 'danger'} />
            <StatCard
              label="ตัดรายการได้"
              value={<Badge variant={q.data.eliminates ? 'success' : 'destructive'}>{q.data.eliminates ? 'สมดุล' : 'ไม่สมดุล'}</Badge>}
            />
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">แยกตามบริษัท</h3>
            <DataTable
              rows={q.data.by_tenant}
              rowKey={(r) => r.tenant_id}
              columns={[
                { key: 'tenant_id', label: 'บริษัท', render: (r) => <span className="font-medium">#{r.tenant_id}</span> },
                { key: 'due_from', label: 'Due-From', align: 'right', render: (r) => <span className="tabular">{baht(r.due_from)}</span> },
                { key: 'due_to', label: 'Due-To', align: 'right', render: (r) => <span className="tabular">{baht(r.due_to)}</span> },
              ]}
              emptyText="ไม่มียอดระหว่างกัน"
            />
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">คงค้างรายคู่บริษัท</h3>
            <DataTable
              rows={q.data.by_pair}
              rowKey={(r) => `${r.from_tenant_id}-${r.to_tenant_id}`}
              columns={[
                { key: 'pair', label: 'คู่บริษัท', render: (r) => <span className="font-medium">#{r.from_tenant_id} → #{r.to_tenant_id}</span> },
                { key: 'count', label: 'จำนวน', align: 'right', render: (r) => <span className="tabular">{r.count}</span> },
                { key: 'gross', label: 'มูลค่ารวม', align: 'right', render: (r) => <span className="tabular">{baht(r.gross)}</span> },
                { key: 'settled', label: 'ชำระแล้ว', align: 'right', render: (r) => <span className="tabular">{baht(r.settled)}</span> },
                { key: 'outstanding', label: 'คงค้าง', align: 'right', render: (r) => <span className="tabular">{baht(r.outstanding)}</span> },
              ]}
              emptyText="ไม่มียอดคงค้างระหว่างกัน"
            />
          </div>
        </div>
      )}
    </StateView>
  );
}
