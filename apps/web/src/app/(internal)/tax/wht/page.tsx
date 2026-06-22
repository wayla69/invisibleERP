'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FileMinus, Coins, Receipt, Plus, ExternalLink, Ban } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { statusVariant } from '@/components/ui';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
const today = () => new Date().toISOString().slice(0, 10);

const PND_TYPES = ['PND3', 'PND53', 'PND1K', 'PND1KS', 'PND2', 'PND2K', 'PND3K'];
// common income types (see wht-rates.ts); rate falls back to the standard for the income type
const INCOME_TYPES: { value: string; label: string }[] = [
  { value: '40(2)', label: '40(2) ค่าจ้าง/ค่านายหน้า' },
  { value: '40(3)', label: '40(3) ค่าสิทธิ' },
  { value: '40(4)', label: '40(4) ดอกเบี้ย/เงินปันผล' },
  { value: '40(5)', label: '40(5) ค่าเช่า' },
  { value: '40(6)', label: '40(6) วิชาชีพอิสระ' },
  { value: '40(7)', label: '40(7) ค่ารับเหมา' },
  { value: '40(8)', label: '40(8) ค่าบริการ/อื่นๆ' },
];

type Cert = {
  doc_no: string;
  pnd_type: string;
  status: string;
  date_paid: string;
  payee: { name: string; tax_id: string; kind: string };
  total_paid: number;
  total_wht: number;
};

export default function WhtPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const q = useQuery<{ certificates: Cert[]; count: number }>({
    queryKey: ['wht-certs', filter],
    queryFn: () => api(`/api/wht/certificates${filter ? `?pnd=${filter}` : ''}`),
  });

  const certs = q.data?.certificates ?? [];
  const totalWht = certs.reduce((a, r) => a + (r.total_wht || 0), 0);
  const totalPaid = certs.reduce((a, r) => a + (r.total_paid || 0), 0);

  // ── ออกหนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) ──
  const [datePaid, setDatePaid] = useState(today());
  const [payeeName, setPayeeName] = useState('');
  const [payeeTaxId, setPayeeTaxId] = useState('');
  const [payeeKind, setPayeeKind] = useState<'person' | 'company'>('company');
  const [incomeType, setIncomeType] = useState('40(2)');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  const [msg, setMsg] = useState('');

  const issue = useMutation({
    mutationFn: () =>
      api<{ doc_no: string }>('/api/wht/certificates', {
        method: 'POST',
        body: JSON.stringify({
          date_paid: datePaid,
          payee: { name: payeeName, tax_id: payeeTaxId, kind: payeeKind },
          lines: [
            {
              income_type: incomeType,
              amount_paid: Number(amount),
              ...(rate ? { rate: Number(rate) } : {}),
            },
          ],
        }),
      }),
    onSuccess: (r) => {
      setMsg(`✅ ออกหนังสือรับรองสำเร็จ: ${r.doc_no}`);
      setPayeeName(''); setPayeeTaxId(''); setAmount(''); setRate('');
      qc.invalidateQueries({ queryKey: ['wht-certs'] });
    },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  const canIssue = !!payeeName && !!payeeTaxId && Number(amount) > 0 && !issue.isPending;

  return (
    <div>
      <PageHeader
        title="ภาษีหัก ณ ที่จ่าย (50 ทวิ)"
        description="หนังสือรับรองการหักภาษี ณ ที่จ่าย — อัตรามาตรฐานตามประเภทเงินได้ (กรอกเองได้)"
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button variant={filter === '' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('')}>
          ทั้งหมด
        </Button>
        {PND_TYPES.map((p) => (
          <Button key={p} variant={filter === p ? 'default' : 'outline'} size="sm" onClick={() => setFilter(p)}>
            {p}
          </Button>
        ))}
      </div>

      <Card className="mb-6 max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plus className="size-4" /> ออกหนังสือรับรอง 50 ทวิ
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="date-paid">วันที่จ่าย</Label>
              <Input id="date-paid" type="date" value={datePaid} onChange={(e) => setDatePaid(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>ประเภทผู้รับเงิน</Label>
              <Select value={payeeKind} onValueChange={(v) => setPayeeKind(v as 'person' | 'company')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="company">นิติบุคคล (company)</SelectItem>
                  <SelectItem value="person">บุคคลธรรมดา (person)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="payee-name">ชื่อผู้ถูกหักภาษี</Label>
            <Input id="payee-name" value={payeeName} onChange={(e) => setPayeeName(e.target.value)} placeholder="ชื่อผู้รับเงิน" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="payee-taxid">เลขประจำตัวผู้เสียภาษี (13 หลัก)</Label>
            <Input id="payee-taxid" value={payeeTaxId} onChange={(e) => setPayeeTaxId(e.target.value)} placeholder="เลข 13 หลัก" />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label>ประเภทเงินได้</Label>
              <Select value={incomeType} onValueChange={setIncomeType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INCOME_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="amount">ฐานภาษี (ไม่รวม VAT)</Label>
              <Input id="amount" type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rate">อัตรา (0–0.3)</Label>
              <Input id="rate" type="number" min="0" max="0.3" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="อัตโนมัติ" />
            </div>
          </div>
          <Button disabled={!canIssue} onClick={() => issue.mutate()}>
            <Receipt className="size-4" /> {issue.isPending ? 'กำลังออก…' : 'ออกหนังสือรับรอง'}
          </Button>
          <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="จำนวนหนังสือรับรอง" value={num(q.data.count)} icon={FileMinus} tone="primary" />
              <StatCard label="ยอดจ่ายรวม" value={baht(totalPaid)} icon={Coins} />
              <StatCard label="ภาษีหัก ณ ที่จ่ายรวม" value={baht(totalWht)} icon={Receipt} tone="info" />
            </div>
            <DataTable
              rows={certs}
              columns={[
                { key: 'doc_no', label: 'เลขที่เอกสาร' },
                { key: 'date_paid', label: 'วันที่จ่าย', render: (r: Cert) => thaiDate(r.date_paid) },
                { key: 'pnd_type', label: 'แบบ ภ.ง.ด.' },
                { key: 'payee', label: 'ผู้ถูกหักภาษี', render: (r: Cert) => r.payee?.name ?? '—' },
                { key: 'payee_tax_id', label: 'เลขผู้เสียภาษี', render: (r: Cert) => r.payee?.tax_id ?? '—' },
                { key: 'total_paid', label: 'ยอดจ่าย', align: 'right', render: (r: Cert) => <span className="tabular">{baht(r.total_paid)}</span> },
                { key: 'total_wht', label: 'ภาษีหัก', align: 'right', render: (r: Cert) => <span className="tabular">{baht(r.total_wht)}</span> },
                { key: 'status', label: 'สถานะ', render: (r: Cert) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                {
                  key: 'pdf',
                  label: 'PDF',
                  sortable: false,
                  render: (r: Cert) => (
                    <Button variant="ghost" size="sm" asChild>
                      <a href={`${BASE}/api/wht/certificates/${r.doc_no}/pdf`} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="size-4" />
                      </a>
                    </Button>
                  ),
                },
              ]}
              emptyText="ยังไม่มีหนังสือรับรองการหักภาษี ณ ที่จ่าย"
            />
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Ban className="size-3.5" /> การยกเลิก (void) จะเปลี่ยนสถานะเป็น Voided โดยไม่ลบเลขที่เอกสาร
            </p>
          </div>
        )}
      </StateView>
    </div>
  );
}
