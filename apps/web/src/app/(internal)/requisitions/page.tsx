'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PrForm } from '@/components/procurement-forms';

type PrLine = { item_id: string; request_qty: number; uom: string | null; reason: string | null };
type Pr = { pr_no: string; pr_date: string | null; requested_by: string | null; status: string; priority: string | null; approved_by: string | null; lines: PrLine[] };
type ItemMatch = { item_id: string; item_description: string | null; uom: string | null; unit_price: number; last_price: number | null };
type VendorMatch = { id: number; name: string; vendor_code: string | null };

// Company-wide requisition surface (perm: pr_raise) — anyone in the company can raise a purchase
// requisition. A PR is only a request: it is routed to Procurement for approval and conversion to a PO.
// Buying (PO) and receiving (GR) live on their own pages owned by Procurement / Warehouse (SoD R03/R04).
export default function RequisitionsPage() {
  return (
    <div>
      <PageHeader title="คำขอซื้อ (Purchase Requisition)" description="แจ้งความต้องการซื้อสินค้า/บริการ — ทุกคนในองค์กรสร้างได้ ทีมจัดซื้อจะพิจารณาอนุมัติและออกใบสั่งซื้อ (PO) ต่อไป" />

      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="text-base">สร้างคำขอซื้อ (PR)</CardTitle>
        </CardHeader>
        <CardContent>
          <PrForm />
          <p className="mt-4 text-xs text-muted-foreground">
            คำขอซื้อจะถูกส่งเข้าสู่ขั้นตอนอนุมัติของทีมจัดซื้อโดยอัตโนมัติ — ติดตามสถานะการอนุมัติได้ที่หน้า “รายการรออนุมัติ / อนุมัติงาน”
          </p>
        </CardContent>
      </Card>

      <PrListCard />
      <LineLinkCard />
    </div>
  );
}

// The requisition register — every PR (raised on this page OR from LINE chat) with its status and lines.
// Procurement/planner/exec see all PRs and can approve/reject a Pending one (maker-checker: the engine
// still blocks self-approval); a plain requester sees their own and can cancel a still-Pending PR.
const STATUS_BADGE: Record<string, { th: string; variant: 'success' | 'info' | 'muted' | 'destructive' }> = {
  Approved: { th: 'อนุมัติแล้ว', variant: 'success' },
  Converted: { th: 'ออก PO แล้ว', variant: 'success' },
  Pending: { th: 'รออนุมัติ', variant: 'info' },
  Rejected: { th: 'ไม่อนุมัติ', variant: 'destructive' },
  Cancelled: { th: 'ยกเลิกแล้ว', variant: 'muted' },
  Draft: { th: 'ฉบับร่าง', variant: 'muted' },
};

function PrListCard() {
  const qc = useQueryClient();
  const [converting, setConverting] = useState<Pr | null>(null);
  const q = useQuery<{ prs: Pr[]; can_approve: boolean }>({
    queryKey: ['prs'], queryFn: () => api('/api/procurement/prs?limit=50'), refetchInterval: 20_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['prs'] });
  const decide = useMutation({
    mutationFn: ({ prNo, approve }: { prNo: string; approve: boolean }) => api(`/api/procurement/prs/${prNo}/approve`, { method: 'PATCH', body: JSON.stringify({ approve }) }),
    onSuccess: (_r, v) => { notifySuccess(v.approve ? 'อนุมัติแล้ว' : 'ปฏิเสธแล้ว'); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const cancel = useMutation({
    mutationFn: (prNo: string) => api(`/api/procurement/prs/${prNo}/cancel`, { method: 'PATCH' }),
    onSuccess: () => { notifySuccess('ยกเลิกแล้ว'); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const prs = q.data?.prs ?? [];
  return (
    <Card className="mt-4 gap-4">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">คำขอซื้อล่าสุด</CardTitle>
        <Button variant="ghost" size="sm" className="gap-1" onClick={refresh} disabled={q.isFetching}>
          <RefreshCw className={`size-4 ${q.isFetching ? 'animate-spin' : ''}`} /> รีเฟรช
        </Button>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">กำลังโหลด…</p>
        ) : prs.length === 0 ? (
          <p className="text-sm text-muted-foreground">ยังไม่มีคำขอซื้อ — สร้างจากฟอร์มด้านบน หรือพิมพ์ <code className="rounded bg-muted px-1">pr &lt;ชื่อสินค้า&gt; &lt;จำนวน&gt;</code> ในแชท LINE</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3">เลขที่ / วันที่</th>
                  <th className="py-2 pr-3">รายการ</th>
                  <th className="py-2 pr-3">ผู้ขอ</th>
                  <th className="py-2 pr-3">สถานะ</th>
                  <th className="py-2 pr-3 text-right">จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {prs.map((pr) => {
                  const badge = STATUS_BADGE[pr.status] ?? { th: pr.status, variant: 'muted' as const };
                  const isPending = pr.status === 'Pending';
                  return (
                    <tr key={pr.pr_no} className="border-b align-top">
                      <td className="py-2 pr-3 whitespace-nowrap font-medium">{pr.pr_no}<div className="text-xs font-normal text-muted-foreground">{pr.pr_date ?? ''}</div></td>
                      <td className="py-2 pr-3">
                        <ul className="space-y-0.5">
                          {pr.lines.map((l, i) => (
                            <li key={i}>{l.item_id} × {l.request_qty}{l.uom ? ` ${l.uom}` : ''}{l.reason ? <span className="text-xs text-muted-foreground"> — {l.reason}</span> : null}</li>
                          ))}
                        </ul>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">{pr.requested_by ?? '-'}</td>
                      <td className="py-2 pr-3"><Badge variant={badge.variant} className="text-[10px]">{badge.th}</Badge>{pr.approved_by ? <div className="text-xs text-muted-foreground">โดย {pr.approved_by}</div> : null}</td>
                      <td className="py-2 pr-3">
                        <div className="flex justify-end gap-2">
                          {q.data?.can_approve && isPending && (
                            <>
                              <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ prNo: pr.pr_no, approve: true })}>อนุมัติ</Button>
                              <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ prNo: pr.pr_no, approve: false })}>ปฏิเสธ</Button>
                            </>
                          )}
                          {q.data?.can_approve && pr.status === 'Approved' && (
                            <Button size="sm" onClick={() => setConverting(pr)}>➡️ สร้าง PO</Button>
                          )}
                          {!q.data?.can_approve && isPending && (
                            <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(pr.pr_no)}>ยกเลิก</Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {converting && <PrToPoForm pr={converting} onDone={() => { setConverting(null); refresh(); }} onCancel={() => setConverting(null)} />}
      </CardContent>
    </Card>
  );
}

// PR → PO conversion. Each PR line (a free-text name from chat) is reconciled to a real item: search the
// master and pick a match, OR tick "สินค้าใหม่" to open a new code. Procurement adds vendor + unit prices,
// then submits — the API raises the PO through the normal path and links/closes the PR.
type ConvLine = { name: string; item_id: string; item_description: string; create_item: boolean; order_qty: number; unit_price: number; uom: string; matches: ItemMatch[]; searching: boolean; searched: boolean };

function PrToPoForm({ pr, onDone, onCancel }: { pr: Pr; onDone: () => void; onCancel: () => void }) {
  const [vendor, setVendor] = useState('');
  const [vendorId, setVendorId] = useState<number | null>(null);
  const [vendorMatches, setVendorMatches] = useState<VendorMatch[]>([]);
  const [vendorSearching, setVendorSearching] = useState(false);
  const searchVendor = async () => {
    if (!vendor.trim()) return;
    setVendorSearching(true);
    try { const r = await api<{ vendors: VendorMatch[] }>(`/api/procurement/vendors/search?q=${encodeURIComponent(vendor)}`); setVendorMatches(r.vendors); }
    catch (e: any) { notifyError(e.message); } finally { setVendorSearching(false); }
  };
  const [lines, setLines] = useState<ConvLine[]>(() => pr.lines.map((l) => ({
    name: l.item_id, item_id: l.item_id, item_description: '', create_item: false,
    order_qty: l.request_qty, unit_price: 0, uom: l.uom ?? '', matches: [], searching: false, searched: false,
  })));
  const setLine = (i: number, patch: Partial<ConvLine>) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const search = async (i: number) => {
    setLine(i, { searching: true });
    try {
      const r = await api<{ items: ItemMatch[] }>(`/api/procurement/items/search?q=${encodeURIComponent(lines[i]!.item_id || lines[i]!.name)}`);
      setLine(i, { matches: r.items, searched: true });
    } catch (e: any) { notifyError(e.message); } finally { setLine(i, { searching: false }); }
  };
  const submit = useMutation({
    mutationFn: () => api<{ po_no: string; created_items: string[] }>(`/api/procurement/prs/${pr.pr_no}/to-po`, {
      method: 'POST',
      body: JSON.stringify({
        vendor_id: vendorId ?? undefined,
        vendor_name: vendor.trim() || undefined,
        lines: lines.map((l) => ({ item_id: l.item_id.trim(), item_description: l.item_description.trim() || undefined, create_item: l.create_item, order_qty: Number(l.order_qty), unit_price: Number(l.unit_price) || 0, uom: l.uom.trim() || undefined })),
      }),
    }),
    onSuccess: (r) => { notifySuccess(`สร้าง PO ${r.po_no} แล้ว${r.created_items?.length ? ` · เปิดรหัสใหม่ ${r.created_items.length} รายการ` : ''}`); onDone(); },
    onError: (e: any) => notifyError(e.message),
  });
  const canSubmit = lines.every((l) => l.item_id.trim() && Number(l.order_qty) > 0);

  return (
    <div className="mt-4 rounded-lg border border-primary/40 bg-primary/5 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-semibold">สร้าง PO จาก {pr.pr_no}</div>
        <Button variant="ghost" size="sm" onClick={onCancel}>ปิด</Button>
      </div>
      <div className="mb-3 max-w-lg space-y-1">
        <Label className="text-xs">ผู้ขาย (Vendor){vendorId ? ' ✓ เลือกจากทะเบียนแล้ว' : ''}</Label>
        <div className="flex gap-2">
          <Input value={vendor} onChange={(e) => { setVendor(e.target.value); setVendorId(null); setVendorMatches([]); }} placeholder="ชื่อผู้ขาย / ซัพพลายเออร์" />
          <Button type="button" variant="outline" size="sm" disabled={vendorSearching || !vendor.trim()} onClick={searchVendor}>{vendorSearching ? '…' : 'ค้นหาผู้ขาย'}</Button>
        </div>
        {vendorMatches.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            <span className="text-xs text-muted-foreground">เลือก:</span>
            {vendorMatches.map((v) => (
              <button key={v.id} type="button" onClick={() => { setVendor(v.name); setVendorId(v.id); setVendorMatches([]); }}
                className="rounded border bg-muted px-2 py-0.5 text-xs hover:bg-accent">{v.name}{v.vendor_code ? ` (${v.vendor_code})` : ''}</button>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">เลือกจากทะเบียนเพื่อผูกการคัดกรอง/สกอร์การ์ด หรือพิมพ์ชื่อใหม่ก็ได้</p>
      </div>
      <div className="space-y-3">
        {lines.map((l, i) => (
          <div key={i} className="rounded-md border bg-card p-3">
            <div className="mb-2 text-xs text-muted-foreground">จากคำขอ: <span className="font-medium text-foreground">{l.name}</span></div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <div className="space-y-1">
                <Label className="text-xs">รหัสสินค้า {l.create_item ? '(เปิดใหม่)' : '(เทียบทะเบียน)'}</Label>
                <div className="flex gap-2">
                  <Input value={l.item_id} onChange={(e) => setLine(i, { item_id: e.target.value, searched: false, matches: [] })} placeholder="รหัสสินค้า" />
                  <Button type="button" variant="outline" size="sm" disabled={l.searching} onClick={() => search(i)}>{l.searching ? '…' : 'ค้นหา/เทียบ'}</Button>
                </div>
                {l.matches.length > 0 && !l.create_item && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    <span className="text-xs text-muted-foreground">เลือกรหัสที่ตรง:</span>
                    {l.matches.map((m) => (
                      <button key={m.item_id} type="button" onClick={() => setLine(i, { item_id: m.item_id, uom: m.uom ?? l.uom, unit_price: (m.last_price ?? m.unit_price) || l.unit_price, matches: [], searched: false })}
                        className="rounded border bg-muted px-2 py-0.5 text-xs hover:bg-accent">
                        {m.item_id}{m.item_description ? ` — ${m.item_description}` : ''}{m.last_price ? ` · ล่าสุด ฿${m.last_price}` : ''}
                      </button>
                    ))}
                  </div>
                )}
                {l.searched && l.matches.length === 0 && !l.create_item && (
                  <p className="pt-1 text-xs text-warning">
                    ไม่พบ &quot;{l.item_id}&quot; ในทะเบียนสินค้า — ติ๊ก &quot;เปิดเป็นสินค้าใหม่&quot; ด้านล่างเพื่อเปิดรหัสนี้เป็นสินค้าใหม่ หรือแก้ชื่อแล้วค้นหาอีกครั้ง
                  </p>
                )}
                <label className="flex items-center gap-1 pt-1 text-xs text-muted-foreground">
                  <input type="checkbox" checked={l.create_item} onChange={(e) => setLine(i, { create_item: e.target.checked })} />
                  เปิดเป็นสินค้าใหม่ (ไม่มีในทะเบียน)
                </label>
                {l.create_item && (
                  <Input className="mt-1" value={l.item_description} onChange={(e) => setLine(i, { item_description: e.target.value })} placeholder="ชื่อ/รายละเอียดสินค้าใหม่" />
                )}
              </div>
              <div className="flex items-end gap-2">
                <div className="w-20 space-y-1"><Label className="text-xs">จำนวน</Label><Input type="number" value={l.order_qty} onChange={(e) => setLine(i, { order_qty: Number(e.target.value) })} /></div>
                <div className="w-20 space-y-1"><Label className="text-xs">หน่วย</Label><Input value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} /></div>
                <div className="w-24 space-y-1"><Label className="text-xs">ราคา/หน่วย</Label><Input type="number" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: Number(e.target.value) })} /></div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>{submit.isPending ? 'กำลังสร้าง…' : 'สร้างใบสั่งซื้อ (PO)'}</Button>
        <span className="text-xs text-muted-foreground">ระบบจะเปิดรหัสใหม่ (ถ้าติ๊ก) · สร้าง PO · เชื่อมกลับ PR ให้อัตโนมัติ</span>
      </div>
    </div>
  );
}

// LINE chat → PR: link the caller's LINE account to their ERP identity with a short-lived one-time code
// (typed into the shop's LINE OA chat as `link <code>`). Once linked, `pr <item> <qty>` in the OA chat
// raises a PR under the linked identity — it enters the same approval workflow as a PR raised here.
function LineLinkCard() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['line-link'], queryFn: () => api<{ linked: boolean }>('/api/line/link') });
  const issue = useMutation({
    mutationFn: () => api<{ code: string; expires_at: string; linked: boolean }>('/api/line/link-code', { method: 'POST' }),
  });
  const unlink = useMutation({
    mutationFn: () => api<{ linked: boolean }>('/api/line/link', { method: 'DELETE' }),
    onSuccess: () => { issue.reset(); qc.invalidateQueries({ queryKey: ['line-link'] }); },
  });

  return (
    <Card className="mt-4 gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageCircle className="size-4" /> สร้างคำขอซื้อผ่านแชท LINE
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {status.data?.linked ? (
          <>
            <p className="text-sm">
              บัญชี LINE ของคุณเชื่อมต่อแล้ว ✔ — พิมพ์ <code className="rounded bg-muted px-1">pr &lt;รหัสสินค้า&gt; &lt;จำนวน&gt;</code>{' '}
              ในแชท LINE OA ของร้านเพื่อสร้างคำขอซื้อ และ <code className="rounded bg-muted px-1">status &lt;เลขที่ PR&gt;</code> เพื่อเช็คสถานะ
            </p>
            <Button variant="outline" size="sm" onClick={() => unlink.mutate()} disabled={unlink.isPending}>
              ยกเลิกการเชื่อมต่อ LINE
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              เชื่อมบัญชี LINE เพื่อสร้างคำขอซื้อจากแชทของ LINE OA ร้าน: กดสร้างรหัส แล้วพิมพ์{' '}
              <code className="rounded bg-muted px-1">link &lt;รหัส&gt;</code> ในแชท (รหัสมีอายุ 10 นาที)
            </p>
            {issue.data && (
              <p className="text-sm">
                รหัสเชื่อมของคุณ: <code className="rounded bg-muted px-2 py-1 text-base font-semibold tracking-widest">{issue.data.code}</code>{' '}
                <span className="text-xs text-muted-foreground">
                  — พิมพ์ <code>link {issue.data.code}</code> ในแชท LINE OA ภายใน 10 นาที
                </span>
              </p>
            )}
            <Button size="sm" onClick={() => issue.mutate()} disabled={issue.isPending}>
              {issue.data ? 'สร้างรหัสใหม่' : 'สร้างรหัสเชื่อม LINE'}
            </Button>
            {issue.isError && <p className="text-sm text-destructive">{(issue.error as Error)?.message ?? 'สร้างรหัสไม่สำเร็จ'}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
