'use client';

// Phase F1 — segment-builder UI over the saved_segments API. The rule catalog (fields/operators/match
// modes) is fetched from the server whitelist — this page adds NO field/op logic of its own, so the safe-by-
// construction contract (whitelisted columns, bound values) stays entirely server-side.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Filter, Plus, Trash2, Pencil, Users, Eye, Megaphone, X } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const selectCls = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

// Cosmetic labels — keys not in these maps render as-is, so a new server field never breaks the page.
const FIELD_LABEL_KEYS: Record<string, string> = {
  balance: 'ly.seg_f_balance', lifetime: 'ly.seg_f_lifetime', tier: 'ly.seg_f_tier', marketing_opt_in: 'ly.seg_f_optin',
  segment: 'ly.seg_f_segment', total_orders: 'ly.seg_f_orders', total_spend: 'ly.seg_f_spend', recency: 'ly.seg_f_recency',
  frequency: 'ly.seg_f_frequency', monetary: 'ly.seg_f_monetary', preferred_channel: 'ly.seg_f_channel',
  visit_count: 'ly.seg_f_visits', avg_order_value: 'ly.seg_f_aov',
};
const OP_SYMBOL: Record<string, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' };
const OPS_BY_KIND: Record<string, string[]> = { num: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'], text: ['eq', 'ne', 'contains'], bool: ['eq', 'ne'] };

interface Rule { field: string; op: string; value: any }
interface Segment { id: number; name: string; match_mode: string; rules: Rule[]; updated_at: string | null; created_by: string | null }
interface Catalog { fields: { key: string; kind: string }[]; operators: string[]; match_modes: string[] }

export default function SavedSegmentsPage() {
  const { t } = useLang();
  const fieldLabel = (k: string) => (FIELD_LABEL_KEYS[k] ? t(FIELD_LABEL_KEYS[k]) : k);
  const opLabel = (op: string) => (op === 'contains' ? t('ly.seg_op_contains') : OP_SYMBOL[op] ?? op);
  const qc = useQueryClient();
  const catalog = useQuery<Catalog>({ queryKey: ['seg-catalog'], queryFn: () => api('/api/loyalty/saved-segments/catalog'), staleTime: 300_000 });
  const list = useQuery<{ segments: Segment[] }>({ queryKey: ['saved-segments'], queryFn: () => api('/api/loyalty/saved-segments') });

  const kindOf = (field: string) => catalog.data?.fields.find((f) => f.key === field)?.kind ?? 'text';
  const firstField = catalog.data?.fields[0]?.key ?? 'segment';

  const [editId, setEditId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [matchMode, setMatchMode] = useState('all');
  const [rules, setRules] = useState<Rule[]>([]);
  const setRule = (i: number, p: Partial<Rule>) => setRules((rs) => rs.map((r, ix) => {
    if (ix !== i) return r;
    const next = { ...r, ...p };
    // Changing the field re-baselines the op to one valid for its kind (and clears the stale value).
    if (p.field && p.field !== r.field) { next.op = OPS_BY_KIND[kindOf(p.field)][0]; next.value = ''; }
    return next;
  }));
  const reset = () => { setEditId(null); setName(''); setMatchMode('all'); setRules([]); };
  const loadForEdit = (s: Segment) => { setEditId(s.id); setName(s.name); setMatchMode(s.match_mode); setRules(s.rules.map((r) => ({ ...r }))); };

  const coerced = () => rules.map((r) => ({
    ...r,
    value: kindOf(r.field) === 'num' ? Number(r.value) : kindOf(r.field) === 'bool' ? (r.value === true || r.value === 'true') : String(r.value ?? ''),
  }));
  const save = useMutation({
    mutationFn: () => api(editId ? `/api/loyalty/saved-segments/${editId}` : '/api/loyalty/saved-segments', {
      method: editId ? 'PUT' : 'POST', body: JSON.stringify({ name, match_mode: matchMode, rules: coerced() }),
    }),
    onSuccess: () => { notifySuccess(editId ? t('ly.seg_updated') : t('ly.seg_created')); reset(); qc.invalidateQueries({ queryKey: ['saved-segments'] }); },
    onError: (e: Error) => notifyError(e.message),
  });
  const remove = useMutation({
    mutationFn: (s: Segment) => api(`/api/loyalty/saved-segments/${s.id}`, { method: 'DELETE' }),
    onSuccess: () => { notifySuccess(t('ly.seg_deleted')); qc.invalidateQueries({ queryKey: ['saved-segments'] }); },
    onError: (e: Error) => notifyError(e.message),
  });

  // Live preview — resolve a saved segment to its matching members (count + a small sample).
  const [previewId, setPreviewId] = useState<number | null>(null);
  const preview = useQuery<{ name: string; total: number; members: { id: number; member_code: string; name: string | null; tier: string | null; rfm_segment: string | null }[] }>({
    queryKey: ['seg-preview', previewId],
    queryFn: () => api(`/api/loyalty/saved-segments/${previewId}/members?limit=5`),
    enabled: previewId != null,
  });

  const ruleText = (r: Rule) => `${FIELD_TH[r.field] ?? r.field} ${OP_TH[r.op] ?? r.op} ${String(r.value)}`;

  return (
    <div>
      <PageHeader title="เซกเมนต์ลูกค้า (Saved Segments)" description="สร้างกลุ่มเป้าหมายจากเงื่อนไข (แต้ม/ระดับ/RFM/พฤติกรรม) เก็บไว้ใช้ซ้ำในแคมเปญและการส่งข้อความ" actions={<Link href="/loyalty/campaigns"><Button variant="outline"><Megaphone className="size-4" /> แคมเปญ</Button></Link>} />

      <div className="space-y-6">
        <Card className="gap-4">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="size-4" /> {editId ? `แก้ไขเซกเมนต์ #${editId}` : 'สร้างเซกเมนต์'}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5 sm:col-span-2"><Label>ชื่อเซกเมนต์</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น ลูกค้าประจำแต้มสูง" /></div>
              <div className="grid gap-1.5"><Label>เงื่อนไขต้องเข้า</Label><select className={selectCls} value={matchMode} onChange={(e) => setMatchMode(e.target.value)}><option value="all">ทุกข้อ (AND)</option><option value="any">ข้อใดข้อหนึ่ง (OR)</option></select></div>
            </div>
            <div className="space-y-2">
              <Label>เงื่อนไข (ว่าง = สมาชิกที่ใช้งานทั้งหมด)</Label>
              {rules.map((r, i) => {
                const kind = kindOf(r.field);
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <select className={selectCls} value={r.field} onChange={(e) => setRule(i, { field: e.target.value })} aria-label={`ฟิลด์ ข้อที่ ${i + 1}`}>
                      {(catalog.data?.fields ?? []).map((f) => <option key={f.key} value={f.key}>{FIELD_TH[f.key] ?? f.key}</option>)}
                    </select>
                    <select className={selectCls} value={r.op} onChange={(e) => setRule(i, { op: e.target.value })} aria-label={`ตัวดำเนินการ ข้อที่ ${i + 1}`}>
                      {OPS_BY_KIND[kind].map((op) => <option key={op} value={op}>{OP_TH[op] ?? op}</option>)}
                    </select>
                    {kind === 'bool' ? (
                      <select className={selectCls} value={String(r.value)} onChange={(e) => setRule(i, { value: e.target.value })} aria-label={`ค่า ข้อที่ ${i + 1}`}><option value="true">ใช่</option><option value="false">ไม่ใช่</option></select>
                    ) : (
                      <Input className="w-40" type={kind === 'num' ? 'number' : 'text'} value={r.value ?? ''} onChange={(e) => setRule(i, { value: e.target.value })} placeholder={kind === 'num' ? '0' : 'เช่น Champions'} aria-label={`ค่า ข้อที่ ${i + 1}`} />
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setRules((rs) => rs.filter((_, ix) => ix !== i))} aria-label={`ลบเงื่อนไข ข้อที่ ${i + 1}`}><X className="size-3.5" /></Button>
                  </div>
                );
              })}
              <Button size="sm" variant="outline" disabled={!catalog.data} onClick={() => setRules((rs) => [...rs, { field: firstField, op: OPS_BY_KIND[kindOf(firstField)][0], value: '' }])}><Plus className="size-3.5" /> เพิ่มเงื่อนไข</Button>
            </div>
            <div className="flex items-center gap-3">
              <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>{save.isPending ? 'กำลังบันทึก…' : editId ? 'บันทึกการแก้ไข' : 'สร้างเซกเมนต์'}</Button>
              {editId != null && <Button variant="ghost" onClick={reset}>ยกเลิก</Button>}
            </div>
          </CardContent>
        </Card>

        {previewId != null && (
          <Card className="gap-3">
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Eye className="size-4" /> ตัวอย่างสมาชิกในเซกเมนต์ {preview.data ? `«${preview.data.name}»` : ''}{preview.data && <Badge variant="info">{num(preview.data.total)} คน</Badge>}<Button size="sm" variant="ghost" className="ml-auto" onClick={() => setPreviewId(null)}><X className="size-3.5" /></Button></CardTitle></CardHeader>
            <CardContent>
              {preview.isLoading ? <p className="text-sm text-muted-foreground">กำลังโหลด…</p> : (
                <ul className="space-y-1 text-sm">
                  {(preview.data?.members ?? []).map((m) => <li key={m.id} className="flex items-center gap-2"><Users className="size-3.5 text-muted-foreground" /><span className="font-mono text-xs">{m.member_code}</span>{m.name ?? '—'}{m.tier && <Badge variant="muted">{m.tier}</Badge>}{m.rfm_segment && <Badge variant="info">{m.rfm_segment}</Badge>}</li>)}
                  {preview.data && preview.data.members.length === 0 && <li className="text-muted-foreground">ยังไม่มีสมาชิกเข้าเงื่อนไขนี้</li>}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        <StateView q={list}>
          {list.data && (
            <DataTable
              rows={list.data.segments}
              rowKey={(s) => s.id}
              emptyState={{ icon: Filter, title: 'ยังไม่มีเซกเมนต์', description: 'สร้างเซกเมนต์แรกจากแบบฟอร์มด้านบน แล้วนำไปใช้เป็นกลุ่มเป้าหมายของแคมเปญ' }}
              columns={[
                { key: 'name', label: 'ชื่อ', render: (s) => <span className="inline-flex items-center gap-1.5"><Filter className="size-3.5 text-muted-foreground" />{s.name}</span> },
                { key: 'match_mode', label: 'โหมด', render: (s) => <Badge variant="muted">{s.match_mode === 'any' ? 'OR' : 'AND'}</Badge> },
                { key: 'rules', label: 'เงื่อนไข', render: (s) => <span className="text-xs text-muted-foreground">{s.rules.length ? s.rules.map(ruleText).join(' · ') : 'สมาชิกทั้งหมด'}</span> },
                { key: 'act', label: '', align: 'right', render: (s) => (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="outline" onClick={() => setPreviewId(s.id)}><Eye className="size-3.5" /> ดูสมาชิก</Button>
                    <Button size="sm" variant="ghost" onClick={() => loadForEdit(s)} aria-label={`แก้ไข ${s.name}`}><Pencil className="size-3.5" /></Button>
                    <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(s)} aria-label={`ลบ ${s.name}`}><Trash2 className="size-3.5" /></Button>
                  </div>
                ) },
              ]}
            />
          )}
        </StateView>
      </div>
    </div>
  );
}
