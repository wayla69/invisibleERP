'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle, Clock, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
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

// rule_type → i18n key (label + statutory law reference). Rendered via t(); falls back to raw rule_type.
const RULE_LABEL_KEY: Record<string, string> = {
  REGULAR_OT: 'hx.ot.lbl.regular_ot',
  HOLIDAY: 'hx.ot.lbl.holiday',
  HOLIDAY_OT: 'hx.ot.lbl.holiday_ot',
  NIGHT: 'hx.ot.lbl.night',
};
const RULE_LAW_KEY: Record<string, string> = {
  REGULAR_OT: 'hx.ot.law.regular_ot',
  HOLIDAY: 'hx.ot.law.holiday',
  HOLIDAY_OT: 'hx.ot.law.holiday_ot',
  NIGHT: 'hx.ot.law.night',
};

export default function OtRulesPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const ruleLabel = (rt: string) => (RULE_LABEL_KEY[rt] ? t(RULE_LABEL_KEY[rt]) : rt);
  const ruleLaw = (rt: string) => (RULE_LAW_KEY[rt] ? t(RULE_LAW_KEY[rt]) : '');
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
      notifySuccess(t('hx.ot.saved'));
      setEditRule(null);
      qc.invalidateQueries({ queryKey: ['ot-rules'] });
    },
    onError: (e: any) => notifyError(e?.message ?? t('hx.ot.save_failed')),
  });

  const resolveAlert = useMutation({
    mutationFn: (id: number) => api(`/api/pos/labor/alerts/${id}/resolve`, { method: 'POST' }),
    onSuccess: () => {
      notifySuccess(t('hx.labor.alert_resolved'));
      qc.invalidateQueries({ queryKey: ['labor-alerts-all'] });
    },
    onError: (e: any) => notifyError(e?.message ?? t('hx.labor.resolve_failed')),
  });

  const cap = rules.data?.weekly_cap_hours ?? 48;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('hx.ot.title')}
        description={t('hx.ot.desc')}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard
          label={t('hx.ot.stat_rules')}
          value={num(rules.data?.rules?.length ?? 0)}
          icon={Clock}
          tone="primary"
          hint={t('hx.ot.cap_hint', { cap })}
        />
        <StatCard
          label={t('hx.labor.pending_alerts')}
          value={num(alerts.data?.count ?? 0)}
          icon={AlertTriangle}
          tone={(alerts.data?.count ?? 0) > 0 ? 'danger' : 'default'}
          hint={t('hx.labor.pct_exceeded_hint')}
        />
      </div>

      {/* OT Rules table */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">{t('hx.ot.rates_title')}</CardTitle>
            <Badge variant="muted" className="font-normal">{t('hx.ot.cap_badge', { cap })}</Badge>
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
                        <p className="text-sm font-medium">{ruleLabel(r.rule_type)}</p>
                        {r.source === 'override' ? (
                          <Badge variant="warning" className="text-[10px]">{t('hx.ot.override')}</Badge>
                        ) : (
                          <Badge variant="muted" className="text-[10px]">{t('hx.ot.statutory')}</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{ruleLaw(r.rule_type)}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('hx.ot.trigger_daily', { h: r.daily_trigger_hours })}
                        {r.weekly_trigger_hours ? t('hx.ot.trigger_weekly', { h: r.weekly_trigger_hours }) : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {editRule?.rule_type === r.rule_type ? (
                        <div className="flex items-center gap-2">
                          <div>
                            <Label className="text-xs">{t('hx.ot.multiplier')}</Label>
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
                            <Button size="sm" disabled={upsertRule.isPending} onClick={() => upsertRule.mutate()}>{t('fin.save')}</Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditRule(null)}>{t('fin.cancel')}</Button>
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
                            {t('hx.common.edit')}
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
        <CardHeader><CardTitle className="text-sm">{t('hx.labor.alerts_title')}</CardTitle></CardHeader>
        <CardContent>
          <StateView q={alerts}>
            <DataTable
              rows={alerts.data?.alerts ?? []}
              rowKey={(r) => String(r.id)}
              columns={[
                {
                  key: 'alert_type',
                  label: t('hx.labor.col_type'),
                  render: (r) => (
                    <div className="flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                      <span className="text-xs">{r.alert_type === 'LABOR_PCT_EXCEEDED' ? t('hx.labor.type_exceeded') : r.alert_type}</span>
                    </div>
                  ),
                },
                { key: 'period_from', label: t('hx.labor.col_period'), render: (r) => <span className="text-xs tabular">{r.period_from} – {r.period_to}</span> },
                {
                  key: 'actual_pct',
                  label: t('hx.labor.col_actual_pct'),
                  align: 'right',
                  render: (r) => (
                    <span className="tabular text-destructive font-medium">{num(r.actual_pct)}%</span>
                  ),
                },
                {
                  key: 'threshold_pct',
                  label: t('hx.labor.col_target'),
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
                      {t('hx.common.close')}
                    </Button>
                  ),
                },
              ]}
              emptyState={{
                icon: ShieldCheck,
                title: t('hx.labor.empty_title'),
                description: t('hx.labor.empty_desc'),
              }}
            />
          </StateView>
        </CardContent>
      </Card>
    </div>
  );
}
