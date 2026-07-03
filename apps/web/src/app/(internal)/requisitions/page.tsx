'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PrForm } from '@/components/procurement-forms';

type PrLine = { item_id: string; request_qty: number; uom: string | null; reason: string | null };
type Pr = { pr_no: string; pr_date: string | null; requested_by: string | null; status: string; priority: string | null; approved_by: string | null; lines: PrLine[] };

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
  Pending: { th: 'รออนุมัติ', variant: 'info' },
  Rejected: { th: 'ไม่อนุมัติ', variant: 'destructive' },
  Cancelled: { th: 'ยกเลิกแล้ว', variant: 'muted' },
  Draft: { th: 'ฉบับร่าง', variant: 'muted' },
};

function PrListCard() {
  const qc = useQueryClient();
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
      </CardContent>
    </Card>
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
