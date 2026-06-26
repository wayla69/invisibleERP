'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle, Clock, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StateView } from '@/components/state-view';
import { notifySuccess, notifyError } from '@/lib/notify';

interface OtRule {
  rule_type: string;
  multiplier: number;
  daily_trigger_hours: number;
  weekly_trigger_hours: number | null;
  source: 'override' | 'statutory_default';
}
interface LaborAlert {
  id: number;
  branch_id: number | null;
  period_from: string;
  period_to: string;
  alert_type: string;
  threshold_pct: number;
  actual_pct: number;
  resolved_at: string | null;
}

const RULE_LABEL: Record<string, string> = {
  REGULAR_OT: 'OT ปกติ (Regular OT)',
  HOLIDAY: 'วันหยุด (Holiday)',
  HOLIDAY_OT: 'OT วันหยุด (Holiday OT)',
  NIGHT: 'กะกลางคืน 22:00–06:00 (Night)',
};
const RULE_LAW: Record<string, string> = {
  REGULAR_OT: 'พ.ร.บ. คุ้มครองแรงงาน ม.61 — หลังเกิน 8 ชม./วัน → 1.5×',
  HOLIDAY: 'ม.64 — วันหยุดนักขัตฤกษ์ → 2×',
  HOLIDAY_OT: 'ม.63 — OT ในวันหยุด → 3×',
  NIGHT: 'ม.23 — กะกลางคืน — ติดตาม แต่ไม่เพิ่มเบี้ย (1×)',
};

export default function OtRulesPage() {
  const qc = useQueryClient();
  const [editRule, setEditRule] = useState<{ rule_type: string; multiplier: string } | null>(null);

  const rules = useQuery<{ rules: OtRule[]; weekly_cap_hours: number }>({
    queryKey: ['ot-rules'],
    queryFn: () => api('/api/pos/labor/ot-rules'),
  });

  const alerts = useQuery<{ alerts: LaborAlert[]; count: number }>({
    queryKey: ['labor-alerts-all'],
    queryFn: () => api('/api/pos/labor/alerts?resolved=false'),
  });

  const upsertRule = useMutation({
    mutationFn: () => api('/api/pos/labor/ot-rules', {
      method: 'PUT',
      body: JSON.stringify({
        rule_type: editRule!.rule_type,
        multiplier: parseFloat(editRule!.multiplier),
      }),
    }),
    onSuccess: () => {
      notifySuccess('บันทึกกฎ OT แล้ว');
      setEditRule(null);
      qc.invalidateQueries({ queryKey: ['ot-rules'] });
    },
    onError: (e: any) => notifyError(e?.message ?? 'บันทึกไม่สำเร็จ'),
  });

  const resolveAlert = useMutation({
    mutationFn: (id: number) => api(`/api/pos/labor/alerts/${id}/resolve`, { method: 'POST' }),
    onSuccess: () => {
      notifySuccess('ปิดการแจ้งเตือนแล้ว');
      qc.invalidateQueries({ queryKey: ['labor-alerts-all'] });
    },
    onError: (e: any) => notifyError(e?.message ?? 'ปิดไม่สำเร็จ'),
  });

  const cap = rules.data?.weekly_cap_hours ?? 48;

  return (
    <div className="space-y-6">
      <PageHeader
        title="กฎ OT & การแจ้งเตือนแรงงาน"
        description="กำหนดอัตราค่าล่วงเวลาตามพ.ร.บ.คุ้มครองแรงงาน (เกณฑ์กฎหมาย 1.5×/2×/3×) และดูการแจ้งเตือนแรงงาน %"
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard
          label="กฎ OT ที่กำหนด"
          value={num(rules.data?.rules?.length ?? 0)}
          icon={Clock}
          tone="primary"
          hint={`วงเงินสูงสุดต่อสัปดาห์ ${cap} ชม.`}
        />
        <StatCard
          label="การแจ้งเตือนที่รอดำเนินการ"
          value={num(alerts.data?.count ?? 0)}
          icon={AlertTriangle}
          tone={(alerts.data?.count ?? 0) > 0 ? 'danger' : 'default'}
          hint="แรงงาน % เกินเป้า"
        />
      </div>

      {/* OT Rules table */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">อัตราค่าล่วงเวลา (Thai LPA)</CardTitle>
            <Badge variant="muted" className="font-normal">วงเงิน OT สูงสุด {cap} ชม./สัปดาห์</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <StateView q={rules}>
            <div className="space-y-2">
              {(rules.data?.rules ?? []).map((r) => (
                <div key={r.rule_type} className="rounded-lg border bg-background px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{RULE_LABEL[r.rule_type] ?? r.rule_type}</p>
                        {r.source === 'override' ? (
                          <Badge variant="warning" className="text-[10px]">ปรับแต่ง</Badge>
                        ) : (
                          <Badge variant="muted" className="text-[10px]">ค่าตามกฎหมาย</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{RULE_LAW[r.rule_type]}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        เกิน {r.daily_trigger_hours} ชม./วัน
                        {r.weekly_trigger_hours ? ` หรือ ${r.weekly_trigger_hours} ชม./สัปดาห์` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {editRule?.rule_type === r.rule_type ? (
                        <div className="flex items-center gap-2">
                          <div>
                            <Label className="text-xs">ตัวคูณ</Label>
                            <Input
                              type="number"
                              step="0.1"
                              min="1"
                              max="5"
                              className="w-20"
                              value={editRule.multiplier}
                              onChange={(e) => setEditRule((ev) => ev ? { ...ev, multiplier: e.target.value } : null)}
                            />
                          </div>
                          <div className="flex gap-1 mt-4">
                            <Button size="sm" disabled={upsertRule.isPending} onClick={() => upsertRule.mutate()}>บันทึก</Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditRule(null)}>ยกเลิก</Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <span className="text-lg font-bold tabular-nums">{r.multiplier}×</span>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditRule({ rule_type: r.rule_type, multiplier: String(r.multiplier) })}
                          >
                            แก้ไข
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </StateView>
        </CardContent>
      </Card>

      {/* Labor alerts */}
      <Card>
        <CardHeader><CardTitle className="text-sm">การแจ้งเตือนแรงงาน % (ที่รอดำเนินการ)</CardTitle></CardHeader>
        <CardContent>
          <StateView q={alerts}>
            <DataTable
              rows={alerts.data?.alerts ?? []}
              rowKey={(r) => String(r.id)}
              columns={[
                {
                  key: 'alert_type',
                  label: 'ประเภท',
                  render: (r) => (
                    <div className="flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                      <span className="text-xs">{r.alert_type === 'LABOR_PCT_EXCEEDED' ? 'แรงงาน % เกินเป้า' : r.alert_type}</span>
                    </div>
                  ),
                },
                { key: 'period_from', label: 'ช่วงเวลา', render: (r) => <span className="text-xs tabular">{r.period_from} – {r.period_to}</span> },
                {
                  key: 'actual_pct',
                  label: 'แรงงาน % จริง',
                  align: 'right',
                  render: (r) => (
                    <span className="tabular text-destructive font-medium">{num(r.actual_pct)}%</span>
                  ),
                },
                {
                  key: 'threshold_pct',
                  label: 'เป้าหมาย',
                  align: 'right',
                  render: (r) => <span className="tabular text-muted-foreground">{num(r.threshold_pct)}%</span>,
                },
                {
                  key: 'actions',
                  label: '',
                  render: (r) => (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={resolveAlert.isPending}
                      onClick={() => resolveAlert.mutate(r.id)}
                    >
                      <CheckCircle className="mr-1 h-3.5 w-3.5" />
                      ปิด
                    </Button>
                  ),
                },
              ]}
              emptyState={{
                icon: ShieldCheck,
                title: 'ไม่มีการแจ้งเตือนที่รอดำเนินการ',
                description: 'ตรวจแรงงาน % ได้จากหน้า จัดตารางเวร',
              }}
            />
          </StateView>
        </CardContent>
      </Card>
    </div>
  );
}
