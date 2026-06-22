'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Layers, PlayCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, thaiDate } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs, Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';

const currentPeriod = () => new Date().toISOString().slice(0, 7);

interface Group {
  id: number;
  name: string;
  base_currency: string;
  fiscal_year: number;
  notes: string | null;
  created_by: string;
  created_at: string | null;
}
interface GroupsResp { groups: Group[]; count: number }
interface Entity { id: number; entity_tenant_id: number; ownership_pct: number; entity_currency: string }
interface EntitiesResp { entities: Entity[] }
interface Run { id: number; period: string; status: string; run_by: string; run_at: string | null }
interface RunsResp { runs: Run[] }
interface RunLine {
  id: number;
  line_type: string;
  entity_tenant_id: number | null;
  account_code: string;
  amount_thb: number;
  notes: string | null;
}
interface RunLinesResp { run_id: number; lines: RunLine[] }

export default function ConsolidationPage() {
  return (
    <div>
      <PageHeader
        title="งบการเงินรวม (Consolidation)"
        description="รวมงบของบริษัทในกลุ่ม แปลงสกุลเงิน ตัดรายการระหว่างกัน และคำนวณส่วนได้เสียที่ไม่มีอำนาจควบคุม (NCI)"
      />
      <Tabs
        tabs={[
          { key: 'groups', label: 'กลุ่มบริษัท', content: <GroupsTab /> },
          { key: 'runs', label: 'การรวมงบ', content: <RunsTab /> },
        ]}
      />
    </div>
  );
}

// ───────────────────────── กลุ่มบริษัท + entities ─────────────────────────
function GroupsTab() {
  const q = useQuery<GroupsResp>({ queryKey: ['consol-groups'], queryFn: () => api('/api/consolidation/groups') });
  const [selected, setSelected] = useState<number | null>(null);

  return (
    <StateView q={q}>
      {q.data && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard label="จำนวนกลุ่ม" value={q.data.count} icon={Layers} tone="primary" />
          </div>
          <DataTable
            rows={q.data.groups}
            rowKey={(r) => r.id}
            onRowClick={(r) => setSelected(r.id)}
            columns={[
              { key: 'name', label: 'ชื่อกลุ่ม', render: (r) => <span className="font-medium">{r.name}</span> },
              { key: 'fiscal_year', label: 'ปีบัญชี', align: 'right', render: (r) => <span className="tabular">{r.fiscal_year}</span> },
              { key: 'base_currency', label: 'สกุลเงินหลัก' },
              { key: 'created_by', label: 'สร้างโดย' },
              { key: 'created_at', label: 'วันที่สร้าง', render: (r) => (r.created_at ? thaiDate(r.created_at) : '—') },
            ]}
            emptyText="ยังไม่มีกลุ่มบริษัท"
          />
          {selected != null && <GroupEntities groupId={selected} />}
        </div>
      )}
    </StateView>
  );
}

function GroupEntities({ groupId }: { groupId: number }) {
  const q = useQuery<EntitiesResp>({ queryKey: ['consol-entities', groupId], queryFn: () => api(`/api/consolidation/groups/${groupId}/entities`) });
  return (
    <Card className="gap-4 p-5">
      <CardHeader className="p-0">
        <CardTitle className="text-base">บริษัทในกลุ่ม #{groupId}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={q.data.entities}
              rowKey={(r) => r.id}
              columns={[
                { key: 'entity_tenant_id', label: 'บริษัท', render: (r) => <span className="font-medium">#{r.entity_tenant_id}</span> },
                { key: 'ownership_pct', label: 'สัดส่วนถือหุ้น', align: 'right', render: (r) => <span className="tabular">{r.ownership_pct}%</span> },
                { key: 'entity_currency', label: 'สกุลเงิน' },
              ]}
              emptyText="ยังไม่มีบริษัทในกลุ่มนี้"
            />
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}

// ───────────────────────── การรวมงบ (runs) ─────────────────────────
function RunsTab() {
  const qc = useQueryClient();
  const groups = useQuery<GroupsResp>({ queryKey: ['consol-groups'], queryFn: () => api('/api/consolidation/groups') });
  const [groupId, setGroupId] = useState<number | null>(null);
  const [period, setPeriod] = useState(currentPeriod());
  const [msg, setMsg] = useState('');
  const [openRun, setOpenRun] = useState<number | null>(null);

  const gid = groupId ?? groups.data?.groups[0]?.id ?? null;

  const runs = useQuery<RunsResp>({
    queryKey: ['consol-runs', gid],
    queryFn: () => api(`/api/consolidation/groups/${gid}/runs`),
    enabled: gid != null,
  });

  const run = useMutation({
    mutationFn: () =>
      api<{ run_id: number; entity_count: number; ic_eliminations: number; status: string }>(`/api/consolidation/groups/${gid}/run`, {
        method: 'POST',
        body: JSON.stringify({ period }),
      }),
    onSuccess: (r) => {
      setMsg(`✅ รวมงบสำเร็จ (run #${r.run_id}) · ${r.entity_count} บริษัท · ตัดรายการ ${r.ic_eliminations} · ${r.status}`);
      qc.invalidateQueries({ queryKey: ['consol-runs', gid] });
    },
    onError: (e: Error) => setMsg(`❌ ${e.message}`),
  });

  const selectCls =
    'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

  return (
    <div className="space-y-5">
      <Card className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="text-base">เดินการรวมงบ (Run Consolidation)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="consol-group">กลุ่มบริษัท</Label>
              <select
                id="consol-group"
                className={selectCls}
                value={gid ?? ''}
                onChange={(e) => setGroupId(Number(e.target.value))}
              >
                {groups.data?.groups.length ? (
                  groups.data.groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name} ({g.fiscal_year})</option>
                  ))
                ) : (
                  <option value="">— ยังไม่มีกลุ่ม —</option>
                )}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="consol-period">งวด (YYYY-MM)</Label>
              <Input id="consol-period" className="max-w-[160px]" placeholder="2026-06" value={period} onChange={(e) => setPeriod(e.target.value)} />
            </div>
            <Button disabled={run.isPending || gid == null || !/^\d{4}-\d{2}$/.test(period)} onClick={() => run.mutate()}>
              <PlayCircle className="size-4" /> {run.isPending ? 'กำลังรวมงบ…' : 'รวมงบ'}
            </Button>
          </div>
          <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
        </CardContent>
      </Card>

      {gid != null && (
        <StateView q={runs}>
          {runs.data && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <StatCard label="จำนวนรอบการรวมงบ" value={runs.data.runs.length} icon={Building2} tone="primary" />
              </div>
              <DataTable
                rows={runs.data.runs}
                rowKey={(r) => r.id}
                onRowClick={(r) => setOpenRun((cur) => (cur === r.id ? null : r.id))}
                columns={[
                  { key: 'id', label: 'Run', render: (r) => <span className="font-medium">#{r.id}</span> },
                  { key: 'period', label: 'งวด' },
                  { key: 'status', label: 'สถานะ', render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                  { key: 'run_by', label: 'โดย' },
                  { key: 'run_at', label: 'เวลา', render: (r) => (r.run_at ? thaiDate(r.run_at) : '—') },
                ]}
                emptyText="ยังไม่มีการรวมงบ"
              />
              {openRun != null && <RunLines runId={openRun} />}
            </div>
          )}
        </StateView>
      )}
    </div>
  );
}

function RunLines({ runId }: { runId: number }) {
  const q = useQuery<RunLinesResp>({ queryKey: ['consol-run-lines', runId], queryFn: () => api(`/api/consolidation/runs/${runId}/lines`) });
  return (
    <Card className="gap-4 p-5">
      <CardHeader className="p-0">
        <CardTitle className="text-base">รายการรวมงบ — Run #{runId}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <StateView q={q}>
          {q.data && (
            <DataTable
              rows={q.data.lines}
              rowKey={(r) => r.id}
              columns={[
                { key: 'line_type', label: 'ประเภท', render: (r) => <Badge variant={statusVariant(r.line_type)}>{r.line_type}</Badge> },
                { key: 'account_code', label: 'รหัสบัญชี' },
                { key: 'entity_tenant_id', label: 'บริษัท', render: (r) => (r.entity_tenant_id != null ? `#${r.entity_tenant_id}` : '—') },
                { key: 'amount_thb', label: 'ยอด (THB)', align: 'right', render: (r) => <span className="tabular">{baht(r.amount_thb)}</span> },
                { key: 'notes', label: 'หมายเหตุ', render: (r) => r.notes ?? '—' },
              ]}
              emptyText="ไม่มีรายการ"
            />
          )}
        </StateView>
      </CardContent>
    </Card>
  );
}
