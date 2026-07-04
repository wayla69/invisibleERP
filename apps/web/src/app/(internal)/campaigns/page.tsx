'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { DataTable } from '@/components/data-table';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const TRIGGER_KEYS = ['lapsed', 'birthday', 'winback', 'all'] as const;
const TRIGGER_LABEL_KEYS: Record<string, string> = {
  lapsed: 'ly.mk_trig_lapsed',
  birthday: 'ly.mk_trig_birthday',
  winback: 'ly.mk_trig_winback',
  all: 'ly.mk_trig_all',
};

export default function CampaignsPage() {
  const { t } = useLang();
  const triggerLabel = (k: string) => (TRIGGER_LABEL_KEYS[k] ? t(TRIGGER_LABEL_KEYS[k]) : k);
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState('lapsed');
  const [discount, setDiscount] = useState(50);
  const [variantB, setVariantB] = useState('');
  const [splitB, setSplitB] = useState(0);
  const [holdout, setHoldout] = useState(0);

  const list = useQuery<any>({ queryKey: ['campaigns'], queryFn: () => api('/api/marketing/automation/campaigns') });
  const run = useMutation({
    mutationFn: () => api<any>('/api/marketing/automation/campaigns', { method: 'POST', body: JSON.stringify({ name: name || t('ly.mk_line_campaign_default'), trigger, channel: 'line', discount_type: 'amount', discount_value: discount, ...(variantB.trim() ? { variant_b_body: variantB.trim(), split_b_pct: splitB } : {}), ...(holdout > 0 ? { holdout_pct: holdout } : {}) }) }),
    onSuccess: (r) => { notifySuccess(t('ly.mk_sent_summary', { targeted: r.targeted, sent: r.sent, skipped: r.skipped, failed: r.failed })); qc.invalidateQueries({ queryKey: ['campaigns'] }); },
    onError: (e: any) => notifyError(e.message),
  });

  return (
    <div>
      <PageHeader title={t('ly.mk_auto_title')} description={t('ly.mk_auto_desc')} />

      <Card className="mb-4 gap-3 p-4">
        <h3 className="text-sm font-semibold text-muted-foreground">{t('ly.mk_new_campaign')}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1"><Label htmlFor="name" className="text-xs">{t('ly.campaign_name')}</Label><Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('ly.mk_name_ph')} className="h-9 w-52" /></div>
          <div className="grid gap-1">
            <Label className="text-xs">{t('ly.mk_target_group')}</Label>
            <Select value={trigger} onValueChange={setTrigger}>
              <SelectTrigger className="h-9 w-60"><SelectValue /></SelectTrigger>
              <SelectContent>{TRIGGER_KEYS.map((it) => <SelectItem key={it} value={it}>{triggerLabel(it)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-1"><Label htmlFor="disc" className="text-xs">{t('ly.mk_discount_baht')}</Label><Input id="disc" type="number" min={0} value={discount} onChange={(e) => setDiscount(Math.max(0, +e.target.value))} className="h-9 w-32" /></div>
          <div className="grid gap-1"><Label htmlFor="vb" className="text-xs">{t('ly.mk_variant_b')}</Label><Input id="vb" value={variantB} onChange={(e) => setVariantB(e.target.value)} placeholder={t('ly.mk_variant_b_ph')} className="h-9 w-64" /></div>
          {variantB.trim() !== '' && <div className="grid gap-1"><Label htmlFor="sb" className="text-xs">{t('ly.mk_split_b')}</Label><Input id="sb" type="number" min={0} max={90} value={splitB} onChange={(e) => setSplitB(Math.min(90, Math.max(0, +e.target.value)))} className="h-9 w-24" /></div>}
          <div className="grid gap-1"><Label htmlFor="ho" className="text-xs">{t('ly.mk_holdout')}</Label><Input id="ho" type="number" min={0} max={50} value={holdout} onChange={(e) => setHoldout(Math.min(50, Math.max(0, +e.target.value)))} className="h-9 w-24" /></div>
          <Button disabled={run.isPending} onClick={() => run.mutate()}><Send className="size-4" /> {run.isPending ? t('ly.mk_sending') : t('ly.mk_send_campaign')}</Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('ly.mk_consent_note')}</p>
      </Card>

      <Card className="gap-3 p-4">
        <h3 className="text-sm font-semibold text-muted-foreground">{t('ly.mk_past_campaigns')}</h3>
        <StateView q={list}>
          {list.data && (
            <DataTable
              rows={list.data.campaigns}
              rowKey={(r: any) => r.id}
              emptyState={{ icon: Megaphone, title: t('ly.mk_no_sent'), description: t('ly.mk_no_sent_desc') }}
              columns={[
                { key: 'name', label: t('ly.mk_col_campaign'), render: (r: any) => <span className="flex items-center gap-1.5"><Megaphone className="size-3.5 text-muted-foreground" />{r.name}</span> },
                { key: 'trigger', label: t('ly.col_group'), render: (r: any) => <Badge variant="muted">{r.trigger}</Badge> },
                { key: 'sent', label: t('ly.mk_col_sent'), align: 'right', render: (r: any) => num(r.sent) },
                { key: 'redeemed', label: t('ly.mk_col_redeemed'), align: 'right', render: (r: any) => num(r.redeemed) },
                { key: 'redemption_rate_pct', label: t('ly.mk_col_redemption'), align: 'right', render: (r: any) => <Badge variant={r.redemption_rate_pct >= 20 ? 'success' : 'muted'}>{r.redemption_rate_pct}%</Badge> },
                { key: 'attributed_revenue', label: t('ly.mk_col_revenue'), align: 'right', render: (r: any) => baht(r.attributed_revenue) },
              ]}
            />
          )}
        </StateView>
      </Card>
    </div>
  );
}
