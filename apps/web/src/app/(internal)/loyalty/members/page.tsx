'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Search, SearchX, Users, Coins, Wallet, Settings } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { statusVariant } from '@/components/ui';

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';
const SEGMENTS = ['', 'Champions', 'Loyal', 'At Risk', 'Lost', 'New'];

interface MemberRow { id: number; member_code: string; name: string | null; phone: string | null; card_no: string | null; tier: string | null; balance: number; lifetime: number; active: boolean; marketing_opt_in: boolean; segment: string | null }
interface ListResp { limit: number; offset: number; count: number; members: MemberRow[] }
interface Liability { control_account: string; fair_value_per_point: number; outstanding_points: number; active_members: number; liability_value: number; posted_liability: number; unposted_value: number; movements: { earned_points: number; redeemed_points: number; redeemed_value: number; adjusted_points: number } }

export default function MembersPage() {
  const { t } = useLang();
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  const [segment, setSegment] = useState('');

  const liab = useQuery<Liability>({ queryKey: ['loy-liability'], queryFn: () => api('/api/loyalty/liability') });
  const list = useQuery<ListResp>({
    queryKey: ['loy-members', q, segment],
    queryFn: () => api(`/api/loyalty/members?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}${segment ? `&segment=${encodeURIComponent(segment)}` : ''}`),
  });

  return (
    <div>
      <PageHeader
        title={t('ly.mb_title')}
        description={t('ly.mb_desc')}
        actions={<Link href="/loyalty"><Button variant="outline"><Settings className="size-4" /> {t('ly.mb_settings_btn')}</Button></Link>}
      />

      <div className="space-y-6">
        <StateView q={liab}>
          {liab.data && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label={t('ly.mb_active_members')} value={num(liab.data.active_members)} icon={Users} tone="primary" />
              <StatCard label={t('ly.mb_outstanding')} value={num(liab.data.outstanding_points)} icon={Coins} tone="info" hint={t('ly.mb_value_per_point', { rate: liab.data.fair_value_per_point })} />
              <StatCard label={t('ly.mb_liability', { acct: liab.data.control_account })} value={baht(liab.data.liability_value)} icon={Wallet} tone="warning" hint={`${t('ly.mb_posted', { posted: baht(liab.data.posted_liability) })}${liab.data.unposted_value ? t('ly.mb_unposted', { unposted: baht(liab.data.unposted_value) }) : ''}`} />
              <StatCard label={t('ly.mb_redeemed')} value={num(liab.data.movements.redeemed_points)} hint={t('ly.mb_redeemed_value', { v: baht(liab.data.movements.redeemed_value) })} />
            </div>
          )}
        </StateView>

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); setQ(term.trim()); }}
        >
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="m-search">{t('ly.mb_search_label')}</label>
            <Input id="m-search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder={t('ly.mb_search_ph')} className="w-72" />
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="m-seg">{t('ly.seg_f_segment')}</label>
            <select id="m-seg" className={selectCls} value={segment} onChange={(e) => setSegment(e.target.value)}>
              {SEGMENTS.map((s) => <option key={s} value={s}>{s || t('ly.all')}</option>)}
            </select>
          </div>
          <Button type="submit"><Search className="size-4" /> {t('ly.search')}</Button>
        </form>

        <StateView q={list}>
          {list.data && (
            <DataTable
              rows={list.data.members}
              rowKey={(r) => r.id}
              emptyState={
                q || segment
                  ? {
                      icon: SearchX,
                      title: t('ly.mb_no_match'),
                      description: t('ly.mb_no_match_desc'),
                      action: (
                        <Button variant="outline" size="sm" onClick={() => { setTerm(''); setQ(''); setSegment(''); }}>
                          {t('inv.clear_filter')}
                        </Button>
                      ),
                    }
                  : { icon: Users, title: t('ly.mb_empty'), description: t('ly.mb_empty_desc') }
              }
              columns={[
                { key: 'member_code', label: t('ly.col_code'), render: (r) => <Link className="text-primary underline-offset-2 hover:underline" href={`/loyalty/members/${r.id}`}>{r.member_code}</Link> },
                { key: 'name', label: t('ly.col_name'), render: (r) => r.name ?? '—' },
                { key: 'phone', label: t('ly.mb_col_phone'), render: (r) => r.phone ?? '—' },
                { key: 'segment', label: t('ly.col_group'), render: (r) => r.segment ? <Badge variant={statusVariant(r.segment)}>{r.segment}</Badge> : <span className="text-muted-foreground">—</span> },
                { key: 'tier', label: t('ly.lc_tier'), render: (r) => r.tier ?? '—' },
                { key: 'balance', label: t('ly.seg_f_balance'), align: 'right', render: (r) => <span className="tabular">{num(r.balance)}</span> },
                { key: 'marketing_opt_in', label: t('ly.seg_f_optin'), align: 'center', render: (r) => r.marketing_opt_in ? <Badge variant="success">{t('ly.mb_opted_in')}</Badge> : <Badge variant="muted">{t('ly.mb_opted_out')}</Badge> },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}
