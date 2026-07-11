'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Check, X, FileText, SlidersHorizontal, Printer, Mail } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { statusVariant } from '@/components/ui';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

// GET /api/cpq/quotes → { quotes: [...], count }
interface Quote { id: number; quote_no: string; customer_name: string; status: string; issued_date: string | null; expires_date: string | null; subtotal: number; discount_total: number; total: number; discount_pct: number; margin_pct: number | null; requires_approval: boolean; approved_by: string | null; created_by: string | null }
// GET /api/cpq/configs → { configs: [...], count }
interface Config { id: number; code: string; name: string; base_price: number; currency: string | null; description: string | null }

// Quote lifecycle (cpq.service.ts): Draft → Sent → Accepted | Rejected. CPQ-01 (SVC-1): a quote breaching the
// margin floor / max discount parks in PendingApproval on send and needs a different approver.
const QUOTE_STATUS_KEYS: Record<string, string> = {
  Draft: 'crm.status_draft', Sent: 'crm.status_sent', PendingApproval: 'crm.status_pending_approval', Accepted: 'crm.status_accepted', Rejected: 'crm.status_rejected',
};
const pct = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}%`);
const quoteStatusLabel = (t: (key: string) => string, s: string) => (QUOTE_STATUS_KEYS[s] ? t(QUOTE_STATUS_KEYS[s]) : s);

export default function CpqPage() {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('crm.cpq_title')} description={t('crm.cpq_subtitle')} />
      <Tabs
        tabs={[
          { key: 'quotes', label: t('crm.tab_quotes'), content: <Quotes /> },
          { key: 'configs', label: t('crm.tab_configs'), content: <Configs /> },
        ]}
      />
    </div>
  );
}

function Quotes() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<{ quotes: Quote[]; count: number }>({ queryKey: ['cpq-quotes'], queryFn: () => api('/api/cpq/quotes') });

  const action = useMutation({
    mutationFn: (v: { id: number; verb: 'send' | 'accept' | 'reject' | 'approve' }) =>
      api(`/api/cpq/quotes/${v.id}/${v.verb}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cpq-quotes'] }),
    onError: (e: any) => notifyError(e.message),
  });

  // Email the quotation PDF to the customer (prompts for the recipient address).
  const email = useMutation({
    mutationFn: (v: { id: number; to_email: string }) =>
      api<{ to: string }>(`/api/cpq/quotes/${v.id}/send-email`, { method: 'POST', body: JSON.stringify({ to_email: v.to_email }) }),
    onSuccess: (r) => { notifySuccess(t('doc.email_sent', { to: r.to })); qc.invalidateQueries({ queryKey: ['cpq-quotes'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const promptEmail = (id: number) => { const to = window.prompt(t('doc.email_prompt')); if (to) email.mutate({ id, to_email: to }); };

  return (
    <div className="space-y-4">
      <StateView q={q}>
        {q.data && (
          <DataTable
            rows={q.data.quotes}
            emptyState={{ icon: FileText, title: t('crm.no_quotes_title'), description: t('crm.no_quotes_desc') }}
            columns={[
              { key: 'quote_no', label: t('dash.col_no') },
              { key: 'customer_name', label: t('fin.col_customer') },
              { key: 'issued_date', label: t('crm.issued_date'), render: (r: Quote) => thaiDate(r.issued_date) },
              { key: 'expires_date', label: t('crm.expires_date'), render: (r: Quote) => thaiDate(r.expires_date) },
              { key: 'subtotal', label: t('crm.subtotal'), align: 'right', render: (r: Quote) => <span className="tabular">{baht(r.subtotal)}</span> },
              { key: 'total', label: t('crm.total'), align: 'right', render: (r: Quote) => <span className="tabular">{baht(r.total)}</span> },
              { key: 'discount_pct', label: t('crm.discount_pct'), align: 'right', render: (r: Quote) => <span className="tabular">{pct(r.discount_pct)}</span> },
              { key: 'margin_pct', label: t('crm.margin_pct'), align: 'right', render: (r: Quote) => <span className="tabular">{pct(r.margin_pct)}</span> },
              { key: 'status', label: t('fin.col_status'), render: (r: Quote) => <Badge variant={statusVariant(r.status)}>{quoteStatusLabel(t, r.status)}</Badge> },
              {
                key: 'actions',
                label: t('crm.actions'),
                sortable: false,
                render: (r: Quote) => (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button variant="ghost" size="sm" asChild title={t('doc.print_pdf')}>
                      <a href={`${BASE}/api/cpq/quotes/${r.id}/pdf`} target="_blank" rel="noopener noreferrer"><Printer className="size-3.5" /></a>
                    </Button>
                    <Button variant="ghost" size="sm" disabled={email.isPending} title={t('doc.email')} onClick={() => promptEmail(r.id)}>
                      <Mail className="size-3.5" />
                    </Button>
                    {r.status === 'Draft' && (
                      <Button variant="outline" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: r.id, verb: 'send' })}>
                        <Send className="size-3.5" /> {t('crm.send')}
                      </Button>
                    )}
                    {r.status === 'PendingApproval' && (
                      <Button variant="default" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: r.id, verb: 'approve' })}>
                        <Check className="size-3.5" /> {t('crm.approve')}
                      </Button>
                    )}
                    {r.status === 'Sent' && (
                      <Button variant="default" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: r.id, verb: 'accept' })}>
                        <Check className="size-3.5" /> {t('crm.accept')}
                      </Button>
                    )}
                    {(r.status === 'Sent' || r.status === 'Draft' || r.status === 'PendingApproval') && (
                      <Button variant="destructive" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: r.id, verb: 'reject' })}>
                        <X className="size-3.5" /> {t('crm.reject')}
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
      </StateView>
    </div>
  );
}

function Configs() {
  const { t } = useLang();
  const q = useQuery<{ configs: Config[]; count: number }>({ queryKey: ['cpq-configs'], queryFn: () => api('/api/cpq/configs') });
  return (
    <StateView q={q}>
      {q.data && (
        <DataTable
          rows={q.data.configs}
          emptyState={{ icon: SlidersHorizontal, title: t('crm.no_configs_title'), description: t('crm.no_configs_desc') }}
          columns={[
            { key: 'code', label: t('crm.col_code') },
            { key: 'name', label: t('crm.col_name') },
            { key: 'description', label: t('crm.description'), render: (r: Config) => r.description ?? '—' },
            { key: 'base_price', label: t('crm.base_price'), align: 'right', render: (r: Config) => <span className="tabular">{baht(r.base_price)}</span> },
          ]}
        />
      )}
    </StateView>
  );
}
