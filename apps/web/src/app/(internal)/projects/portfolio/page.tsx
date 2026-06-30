'use client';

import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Activity, ShieldAlert, ShieldCheck, Users, Wallet, Receipt, Clock, TrendingUp, FolderKanban } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { statusVariant } from '@/components/ui';

const cpiTone = (v: number | null): 'success' | 'warning' | 'danger' | 'default' =>
  v == null ? 'default' : v >= 1 ? 'success' : v >= 0.9 ? 'warning' : 'danger';

export default function PortfolioPage() {
  const router = useRouter();
  const q = useQuery<any>({ queryKey: ['projects', 'portfolio'], queryFn: () => api('/api/projects/portfolio') });
  const d = q.data;
  const f = d?.funnel;
  const funnelMax = Math.max(1, f?.open_count ?? 0, f?.won_count ?? 0, f?.converted_count ?? 0);
  const funnelRows = [
    { label: 'โอกาสเปิดอยู่ (Open)', count: f?.open_count ?? 0, amount: f?.open_amount ?? 0, color: 'var(--chart-2)' },
    { label: 'ชนะแล้ว (Won)', count: f?.won_count ?? 0, amount: f?.won_amount ?? 0, color: 'var(--chart-3)' },
    { label: 'แปลงเป็นโครงการ (Converted)', count: f?.converted_count ?? 0, amount: null as number | null, color: 'var(--primary)' },
  ];

  return (
    <div>
      <PageHeader
        title="พอร์ตโครงการ (Portfolio)"
        description="ภาพรวมผู้บริหารทุกโครงการ · มูลค่าที่ได้รับ (EVM) · สุขภาพโครงการ · กำลังคน · ช่องทางจากดีลสู่โครงการ"
        actions={<Button variant="outline" onClick={() => router.push('/projects')}><FolderKanban className="size-4" /> ทะเบียนโครงการ</Button>}
      />

      <StateView q={q}>
        <div className="space-y-4">
          {/* health band */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="ดัชนีต้นทุนพอร์ต (CPI)" value={d?.totals?.cpi ?? '—'} icon={Activity} tone={cpiTone(d?.totals?.cpi)} hint={`${d?.count ?? 0} โครงการ`} />
            <StatCard label="ตามแผน (On track)" value={d?.health?.on_track ?? 0} icon={ShieldCheck} tone="success" />
            <StatCard label="เสี่ยง (At risk)" value={d?.health?.at_risk ?? 0} icon={ShieldAlert} tone={(d?.health?.at_risk ?? 0) > 0 ? 'danger' : 'default'} hint="CPI หรือ SPI < 0.9" />
            <StatCard label="ทรัพยากรเกินกำลัง" value={d?.capacity?.over_allocated_count ?? 0} icon={Users} tone={(d?.capacity?.over_allocated_count ?? 0) > 0 ? 'warning' : 'default'} hint=">100% allocation" />
          </div>

          {/* financial band */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="มูลค่าสัญญารวม" value={baht(d?.financials?.contract)} icon={Wallet} tone="primary" />
            <StatCard label="วางบิลสะสม" value={baht(d?.financials?.billed)} icon={Receipt} tone="default" />
            <StatCard label="งานระหว่างทำ (WIP)" value={baht(d?.financials?.wip)} icon={Clock} tone="info" />
            <StatCard label="กำไรสะสม" value={baht(d?.financials?.margin)} icon={TrendingUp} tone={(d?.financials?.margin ?? 0) < 0 ? 'danger' : 'success'} />
          </div>

          <div className="grid gap-4 lg:grid-cols-5">
            {/* pipeline → delivery funnel */}
            <Card className="gap-4 p-5 lg:col-span-3">
              <h3 className="text-base font-semibold">ช่องทางจากดีลสู่โครงการ (Pipeline → delivery)</h3>
              <div className="space-y-3">
                {funnelRows.map((r) => (
                  <div key={r.label}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{r.label}</span>
                      <span className="tabular font-medium">{r.count}{r.amount != null ? <span className="ml-2 text-xs text-muted-foreground">{baht(r.amount)}</span> : null}</span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full" style={{ width: `${(r.count / funnelMax) * 100}%`, background: r.color }} />
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            {/* at-risk projects */}
            <Card className="gap-3 p-5 lg:col-span-2">
              <h3 className="text-base font-semibold">โครงการที่ต้องจับตา (At risk)</h3>
              {(d?.at_risk?.length ?? 0) === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center text-sm text-muted-foreground">
                  <ShieldCheck className="size-8 text-success" />
                  ทุกโครงการอยู่ในเกณฑ์ดี
                </div>
              ) : (
                <ul className="space-y-2">
                  {d.at_risk.slice(0, 8).map((r: any) => (
                    <li key={r.project_code}>
                      <button onClick={() => router.push(`/projects/${encodeURIComponent(r.project_code)}`)} className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-left text-sm hover:bg-muted/50">
                        <span className="min-w-0 truncate"><span className="font-medium">{r.project_code}</span> <span className="text-muted-foreground">{r.name}</span></span>
                        <span className="flex shrink-0 gap-1">
                          {r.cpi != null && <Badge variant={r.cpi < 0.9 ? 'destructive' : 'muted'}>CPI {r.cpi}</Badge>}
                          {r.spi != null && <Badge variant={r.spi < 0.9 ? 'destructive' : 'muted'}>SPI {r.spi}</Badge>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* project health table */}
          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">สุขภาพรายโครงการ</h3>
            <DataTable
              rows={d?.projects ?? []}
              rowKey={(r: any) => r.project_code}
              onRowClick={(r: any) => router.push(`/projects/${encodeURIComponent(r.project_code)}`)}
              columns={[
                { key: 'project_code', label: 'รหัส' },
                { key: 'name', label: 'โครงการ', render: (r: any) => `${r.name}${r.customer_name ? ` · ${r.customer_name}` : ''}` },
                { key: 'cpi', label: 'CPI', align: 'right', render: (r: any) => <span className={`tabular ${r.cpi != null && r.cpi < 0.9 ? 'font-medium text-destructive' : r.cpi != null && r.cpi >= 1 ? 'text-success' : ''}`}>{r.cpi ?? '—'}</span> },
                { key: 'spi', label: 'SPI', align: 'right', render: (r: any) => <span className={`tabular ${r.spi != null && r.spi < 0.9 ? 'font-medium text-destructive' : r.spi != null && r.spi >= 1 ? 'text-success' : ''}`}>{r.spi ?? '—'}</span> },
                { key: 'wip', label: 'WIP', align: 'right', render: (r: any) => <span className="tabular">{baht(r.wip)}</span> },
                { key: 'margin', label: 'กำไร', align: 'right', render: (r: any) => <span className={`tabular ${r.margin < 0 ? 'text-destructive' : ''}`}>{baht(r.margin)}</span> },
                { key: 'on_track', label: 'สุขภาพ', render: (r: any) => r.on_track ? <Badge variant="success">on track</Badge> : (r.cpi == null && r.spi == null) ? <Badge variant="muted">no data</Badge> : <Badge variant="destructive">at risk</Badge> },
                { key: 'status', label: 'สถานะ', render: (r: any) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
              ]}
              emptyState={{ icon: FolderKanban, title: 'ยังไม่มีโครงการ', description: 'สร้างโครงการเพื่อดูภาพรวมพอร์ต' }}
            />
          </div>
        </div>
      </StateView>
    </div>
  );
}
