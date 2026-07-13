'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Users, ShieldAlert, ShieldCheck, ShieldQuestion, History } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { statusVariant } from '@/components/ui';

// GET /api/crm/audience-export/preview → CrmService.exportForCustomerMatch (crm.controller.ts)
interface PreviewMember { member_id: number; hashed_email?: string; hashed_phone?: string; hashed_phone_plus?: string }
interface PreviewResp {
  hash_alg: string; consent_basis: string; total_active: number; consented: number; count: number;
  members: PreviewMember[];
  error?: { code: string; message: string; messageTh?: string };
}

// GET /api/crm/audience-export/register → CrmService.audienceExportRegister
interface RegisterRow {
  id: number; purpose: string | null; consent_basis: string | null; target: string; hash_alg: string;
  members_considered: number; members_consented: number; rows_pushed: number; rows_removed: number;
  status: 'success' | 'failed' | 'blocked'; error: string | null; ropa_activity_id: number | null;
  created_by: string | null; created_at: string;
}
interface RegisterResp { exports: RegisterRow[]; count: number }

// GET /api/pdpa/ropa?active=1 → PdpaService.listRopa. Gated `users` (DPO/access-admin duty) — a marketing
// user without that permission gets a 403 here; the ROPA banner degrades to "can't verify" rather than
// erroring the whole page (matches the audience_export_sync job's own fail-closed-but-never-crash posture).
interface RopaActivity { id: number; name: string; legal_basis: string; active: boolean }
interface RopaResp { activities: RopaActivity[]; count: number }

function RopaBanner() {
  const { t } = useLang();
  const q = useQuery<RopaResp, Error & { status?: number }>({
    queryKey: ['aud-ropa'],
    queryFn: () => api('/api/pdpa/ropa?active=1'),
    retry: false,
  });

  if (q.isLoading) return null;
  if (q.isError) {
    if (q.error?.status === 403) {
      return (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground dark:text-warning">
          <ShieldQuestion className="size-4 shrink-0" /> {t('crm.aud_ropa_unknown')}
        </div>
      );
    }
    return null;
  }
  const hasRopa = (q.data?.activities ?? []).some((a) => a.name === 'audience_export' && a.legal_basis === 'consent' && a.active);
  return hasRopa ? (
    <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 p-3 text-sm text-success">
      <ShieldCheck className="size-4 shrink-0" /> {t('crm.aud_ropa_ok')}
    </div>
  ) : (
    <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      <ShieldAlert className="size-4 shrink-0" /> {t('crm.aud_ropa_missing')}
    </div>
  );
}

function Preview() {
  const { t } = useLang();
  const q = useQuery<PreviewResp>({ queryKey: ['aud-preview'], queryFn: () => api('/api/crm/audience-export/preview?limit=20') });
  const d = q.data && !q.data.error ? q.data : null;
  return (
    <Card className="gap-4">
      <CardHeader><CardTitle className="text-base">{t('crm.aud_preview_title')}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <StateView q={q}>
          {d && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <StatCard label={t('crm.aud_consented')} value={num(d.consented)} icon={Users} tone="success" />
                <StatCard label={t('crm.aud_total_active')} value={num(d.total_active)} />
                <StatCard label={t('crm.aud_hash_alg')} value={d.hash_alg.toUpperCase()} />
              </div>
              <DataTable
                rows={d.members}
                rowKey={(r) => r.member_id}
                emptyState={{ icon: Users, title: t('crm.aud_no_consented') }}
                columns={[
                  { key: 'hashed_email', label: t('crm.aud_col_hashed_email'), render: (r) => r.hashed_email ? <span className="font-mono text-xs">{r.hashed_email.slice(0, 16)}…</span> : '—' },
                  { key: 'hashed_phone', label: t('crm.aud_col_hashed_phone'), render: (r) => r.hashed_phone ? <span className="font-mono text-xs">{r.hashed_phone.slice(0, 16)}…</span> : '—' },
                ]}
              />
            </div>
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

function Register() {
  const { t } = useLang();
  const q = useQuery<RegisterResp>({ queryKey: ['aud-register'], queryFn: () => api('/api/crm/audience-export/register?limit=50') });
  return (
    <Card className="gap-4">
      <CardHeader><CardTitle className="text-base">{t('crm.aud_register_title')}</CardTitle></CardHeader>
      <CardContent>
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={q.data.exports}
              rowKey={(r) => r.id}
              emptyState={{ icon: History, title: t('crm.aud_no_runs') }}
              columns={[
                { key: 'created_at', label: 'ts', render: (r) => new Date(r.created_at).toLocaleString() },
                { key: 'target', label: t('crm.aud_col_target') },
                { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                { key: 'members_consented', label: t('crm.aud_consented'), align: 'right', render: (r) => num(r.members_consented) },
                { key: 'rows_pushed', label: t('crm.aud_col_pushed'), align: 'right', render: (r) => num(r.rows_pushed) },
                { key: 'rows_removed', label: t('crm.aud_col_removed'), align: 'right', render: (r) => num(r.rows_removed) },
                { key: 'error', label: t('crm.aud_col_error'), render: (r) => r.error ?? '—' },
              ]}
            />
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

export default function AudienceExportPage() {
  const { t } = useLang();
  return (
    <div className="space-y-4">
      <PageHeader
        title={t('crm.aud_title')}
        description={t('crm.aud_subtitle')}
        actions={<Button variant="outline" asChild><Link href="/scheduled-reports">{t('crm.aud_go_scheduled')}</Link></Button>}
      />
      <RopaBanner />
      <p className="text-sm text-muted-foreground">{t('crm.aud_schedule_hint')}</p>
      <Preview />
      <Register />
    </div>
  );
}
