'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CircleDollarSign, RefreshCw, ShieldAlert, ShieldOff } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { notifySuccess, notifyError } from '@/lib/notify';

interface CreditPosition {
  tenant_id: number;
  customer: string;
  credit_term: number | null;
  credit_limit: number;
  exposure: number;
  overdue: number;
  max_overdue_days: number;
  available_credit: number | null;
  over_limit: boolean;
  serious_overdue: boolean;
  manual_hold: boolean;
  on_hold: boolean;
}

interface CreditEvent {
  event_type: 'hold' | 'release' | 'limit_change';
  old_limit: number | null;
  new_limit: number | null;
  reason: string | null;
  actioned_by: string;
  created_at: string;
}

export default function CreditHoldPage() {
  const qc = useQueryClient();

  const positions = useQuery<{ positions: CreditPosition[]; count: number; on_hold_count: number; as_of: string }>({
    queryKey: ['credit-positions'],
    queryFn: () => api('/api/finance/ar/credit-positions'),
    refetchInterval: 60000,
  });

  // Hold / release dialog state
  const [holdDialog, setHoldDialog] = useState<{ tenantId: number; customer: string; action: 'hold' | 'release' } | null>(null);
  const [holdReason, setHoldReason] = useState('');

  // Credit limit change dialog state
  const [limitDialog, setLimitDialog] = useState<{ tenantId: number; customer: string; currentLimit: number } | null>(null);
  const [newLimit, setNewLimit] = useState('');
  const [limitReason, setLimitReason] = useState('');

  // Credit events (audit trail) dialog state
  const [eventsTenantId, setEventsTenantId] = useState<number | null>(null);
  const events = useQuery<{ tenant_id: number; count: number; events: CreditEvent[] }>({
    queryKey: ['credit-events', eventsTenantId],
    queryFn: () => api(`/api/finance/ar/credit-events?tenant_id=${eventsTenantId}`),
    enabled: eventsTenantId != null,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['credit-positions'] });

  const placeHold = useMutation<{ customer: string }, Error, { tenant_id: number; reason?: string }>({
    mutationFn: (b) => api('/api/finance/ar/credit-hold', { method: 'POST', body: JSON.stringify(b) }) as Promise<{ customer: string }>,
    onSuccess: (r) => { notifySuccess(`ระงับเครดิต ${r.customer} แล้ว`); setHoldDialog(null); setHoldReason(''); refresh(); },
    onError: (e: any) => notifyError(e?.message ?? 'ระงับเครดิตไม่สำเร็จ'),
  });

  const releaseHold = useMutation<{ customer: string }, Error, { tenant_id: number; reason?: string }>({
    mutationFn: (b) => api('/api/finance/ar/credit-release', { method: 'POST', body: JSON.stringify(b) }) as Promise<{ customer: string }>,
    onSuccess: (r) => { notifySuccess(`ปลดระงับเครดิต ${r.customer} แล้ว`); setHoldDialog(null); setHoldReason(''); refresh(); },
    onError: (e: any) => notifyError(e?.message ?? 'ปลดระงับไม่สำเร็จ — ตรวจสอบ SoD (ผู้ปลดต้องต่างจากผู้ระงับ)'),
  });

  const changeLimit = useMutation<{ customer: string; old_limit: number; new_limit: number }, Error, { tenant_id: number; new_limit: number; reason?: string }>({
    mutationFn: (b) => api('/api/finance/ar/credit-limit', { method: 'POST', body: JSON.stringify(b) }) as Promise<{ customer: string; old_limit: number; new_limit: number }>,
    onSuccess: (r) => {
      notifySuccess(`เปลี่ยนวงเงิน ${r.customer}: ${baht(r.old_limit)} → ${baht(r.new_limit)}`);
      setLimitDialog(null); setNewLimit(''); setLimitReason('');
      refresh();
    },
    onError: (e: any) => notifyError(e?.message ?? 'เปลี่ยนวงเงินไม่สำเร็จ'),
  });

  const data = positions.data;
  const totalExposure = (data?.positions ?? []).reduce((a, p) => a + p.exposure, 0);
  const totalOverdue = (data?.positions ?? []).reduce((a, p) => a + p.overdue, 0);

  const actionPending = placeHold.isPending || releaseHold.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        title="จัดการเครดิต & ระงับบัญชี"
        description="REV-08 / REV-12 — สถานะเครดิตลูกค้าทุกราย, ระงับ/ปลดระงับ (maker-checker SoD), เปลี่ยนวงเงิน, ประวัติ"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="บัญชีถูกระงับ"
          value={data ? String(data.on_hold_count) : '—'}
          icon={ShieldAlert}
          tone="danger"
          hint="ลูกค้าที่ถูกระงับเครดิตอยู่"
        />
        <StatCard
          label="ลูกหนี้รวม (Exposure)"
          value={data ? baht(totalExposure) : '—'}
          icon={CircleDollarSign}
          tone="warning"
          hint="ยอดคงค้างรวมทุกราย"
        />
        <StatCard
          label="ยอดเกินกำหนด"
          value={data ? baht(totalOverdue) : '—'}
          icon={AlertTriangle}
          tone="danger"
          hint="ยอดที่เลยกำหนดชำระ"
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">สถานะเครดิตลูกค้า{data ? ` (${data.count} ราย ณ ${data.as_of})` : ''}</CardTitle>
          <Button variant="outline" size="sm" onClick={refresh} disabled={positions.isFetching}>
            <RefreshCw className={`mr-1 size-4 ${positions.isFetching ? 'animate-spin' : ''}`} />
            รีเฟรช
          </Button>
        </CardHeader>
        <CardContent>
          <StateView q={positions}>
            <DataTable
              rows={data?.positions ?? []}
              rowKey={(r) => String(r.tenant_id)}
              emptyState={{ icon: ShieldOff, title: 'ไม่มีลูกหนี้ค้างชำระ', description: 'ลูกค้าทุกรายชำระตามกำหนด' }}
              columns={[
                { key: 'customer', label: 'ลูกค้า' },
                {
                  key: 'exposure', label: 'คงค้าง', align: 'right',
                  render: (r) => <span className="tabular-nums">{baht(r.exposure)}</span>,
                },
                {
                  key: 'overdue', label: 'เกินกำหนด', align: 'right',
                  render: (r) => <span className={`tabular-nums ${r.overdue > 0 ? 'text-destructive' : ''}`}>{baht(r.overdue)}</span>,
                },
                {
                  key: 'max_overdue_days', label: 'ค้างสูงสุด', align: 'right',
                  render: (r) => <span className={`tabular-nums ${r.max_overdue_days > 90 ? 'text-destructive font-medium' : ''}`}>{r.max_overdue_days}d</span>,
                },
                {
                  key: 'credit_limit', label: 'วงเงิน', align: 'right',
                  render: (r) => <span className="tabular-nums">{r.credit_limit > 0 ? baht(r.credit_limit) : '—'}</span>,
                },
                {
                  key: 'available_credit', label: 'คงเหลือ', align: 'right',
                  render: (r) => (
                    <span className={`tabular-nums ${r.over_limit ? 'text-destructive font-medium' : ''}`}>
                      {r.available_credit != null ? baht(r.available_credit) : '—'}
                    </span>
                  ),
                },
                {
                  key: 'status', label: 'สถานะ', sortable: false,
                  render: (r) => (
                    <div className="flex flex-wrap gap-1">
                      {r.manual_hold && <Badge variant="destructive">ระงับ (ผู้จัดการ)</Badge>}
                      {r.over_limit && <Badge variant="destructive">เกินวงเงิน</Badge>}
                      {r.serious_overdue && <Badge variant="destructive">ค้าง 90+ วัน</Badge>}
                      {!r.on_hold && <Badge variant="success">ปกติ</Badge>}
                    </div>
                  ),
                },
                {
                  key: 'actions', label: '', sortable: false,
                  render: (r) => (
                    <div className="flex gap-1">
                      {!r.manual_hold ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => { setHoldDialog({ tenantId: r.tenant_id, customer: r.customer, action: 'hold' }); setHoldReason(''); }}
                        >
                          <ShieldAlert className="mr-1 size-3.5" />
                          ระงับ
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => { setHoldDialog({ tenantId: r.tenant_id, customer: r.customer, action: 'release' }); setHoldReason(''); }}
                        >
                          <ShieldOff className="mr-1 size-3.5" />
                          ปลดระงับ
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setLimitDialog({ tenantId: r.tenant_id, customer: r.customer, currentLimit: r.credit_limit }); setNewLimit(String(r.credit_limit > 0 ? r.credit_limit : '')); setLimitReason(''); }}
                      >
                        วงเงิน
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEventsTenantId(r.tenant_id)}
                      >
                        ประวัติ
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </StateView>
        </CardContent>
      </Card>

      {/* Place / release hold dialog */}
      <Dialog
        open={holdDialog != null}
        onOpenChange={(o) => { if (!o) { setHoldDialog(null); setHoldReason(''); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {holdDialog?.action === 'hold' ? `ระงับเครดิต — ${holdDialog.customer}` : `ปลดระงับเครดิต — ${holdDialog?.customer}`}
            </DialogTitle>
          </DialogHeader>
          {holdDialog?.action === 'release' && (
            <p className="text-sm text-muted-foreground">SoD: ผู้ปลดระงับต้องต่างจากผู้ที่ระงับ (maker-checker)</p>
          )}
          <div className="grid gap-2">
            <Label>เหตุผล {holdDialog?.action === 'hold' ? '(ไม่บังคับ)' : '(ไม่บังคับ)'}</Label>
            <Input
              value={holdReason}
              onChange={(e) => setHoldReason(e.target.value)}
              placeholder={holdDialog?.action === 'hold' ? 'เช่น ค้างชำระเกิน 3 งวด' : 'เช่น ชำระหนี้ครบแล้ว'}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setHoldDialog(null); setHoldReason(''); }}>ยกเลิก</Button>
            {holdDialog?.action === 'hold' ? (
              <Button
                variant="destructive"
                disabled={actionPending}
                onClick={() => placeHold.mutate({ tenant_id: holdDialog.tenantId, reason: holdReason || undefined })}
              >
                ยืนยันระงับ
              </Button>
            ) : (
              <Button
                disabled={actionPending}
                onClick={() => holdDialog && releaseHold.mutate({ tenant_id: holdDialog.tenantId, reason: holdReason || undefined })}
              >
                ยืนยันปลดระงับ
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Credit limit change dialog */}
      <Dialog
        open={limitDialog != null}
        onOpenChange={(o) => { if (!o) { setLimitDialog(null); setNewLimit(''); setLimitReason(''); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>เปลี่ยนวงเงินเครดิต — {limitDialog?.customer}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label>วงเงินปัจจุบัน</Label>
              <p className="text-sm text-muted-foreground">{limitDialog ? (limitDialog.currentLimit > 0 ? baht(limitDialog.currentLimit) : 'ไม่จำกัด') : '—'}</p>
            </div>
            <div className="grid gap-2">
              <Label>วงเงินใหม่ (บาท, 0 = ไม่จำกัด)</Label>
              <Input
                type="number"
                min="0"
                step="1000"
                value={newLimit}
                onChange={(e) => setNewLimit(e.target.value)}
                placeholder="เช่น 100000"
              />
            </div>
            <div className="grid gap-2">
              <Label>เหตุผล</Label>
              <Input
                value={limitReason}
                onChange={(e) => setLimitReason(e.target.value)}
                placeholder="เช่น ทบทวนรอบปี / ขยายวงเงินตามผลงาน"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLimitDialog(null)}>ยกเลิก</Button>
            <Button
              disabled={changeLimit.isPending || newLimit === '' || Number(newLimit) < 0}
              onClick={() => limitDialog && changeLimit.mutate({ tenant_id: limitDialog.tenantId, new_limit: Number(newLimit), reason: limitReason || undefined })}
            >
              บันทึก
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Credit events audit trail dialog */}
      <Dialog
        open={eventsTenantId != null}
        onOpenChange={(o) => { if (!o) setEventsTenantId(null); }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>ประวัติเครดิต</DialogTitle>
          </DialogHeader>
          <StateView q={events}>
            <DataTable
              rows={events.data?.events ?? []}
              rowKey={(_, i) => String(i)}
              emptyState={{ icon: ShieldOff, title: 'ยังไม่มีประวัติ', description: 'ยังไม่มีการระงับ / ปลดระงับ / เปลี่ยนวงเงิน' }}
              columns={[
                {
                  key: 'event_type', label: 'ประเภท',
                  render: (r) => (
                    <Badge variant={r.event_type === 'hold' ? 'destructive' : r.event_type === 'release' ? 'success' : 'default'}>
                      {r.event_type === 'hold' ? 'ระงับ' : r.event_type === 'release' ? 'ปลดระงับ' : 'เปลี่ยนวงเงิน'}
                    </Badge>
                  ),
                },
                { key: 'reason', label: 'เหตุผล', render: (r) => r.reason ?? '—' },
                { key: 'actioned_by', label: 'ผู้ดำเนินการ' },
                { key: 'created_at', label: 'เวลา', render: (r) => thaiDate(r.created_at) },
              ]}
            />
          </StateView>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEventsTenantId(null)}>ปิด</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
