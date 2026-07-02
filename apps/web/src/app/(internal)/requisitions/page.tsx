'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PrForm } from '@/components/procurement-forms';

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

      <LineLinkCard />
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
