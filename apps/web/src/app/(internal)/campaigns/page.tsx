'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { DataTable } from '@/components/data-table';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const TRIGGERS = [
  { key: 'lapsed', label: 'ลูกค้าห่างหาย (Lapsed)' },
  { key: 'birthday', label: 'วันเกิดวันนี้ (Birthday)' },
  { key: 'winback', label: 'ดึงกลับ (Win-back: At-Risk/Lost)' },
  { key: 'all', label: 'สมาชิกทั้งหมด' },
];

export default function CampaignsPage() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState('lapsed');
  const [discount, setDiscount] = useState(50);
  const [msg, setMsg] = useState('');

  const list = useQuery<any>({ queryKey: ['campaigns'], queryFn: () => api('/api/marketing/automation/campaigns') });
  const run = useMutation({
    mutationFn: () => api<any>('/api/marketing/automation/campaigns', { method: 'POST', body: JSON.stringify({ name: name || 'แคมเปญ LINE', trigger, channel: 'line', discount_type: 'amount', discount_value: discount }) }),
    onSuccess: (r) => { setMsg(`ส่งแล้ว: เป้าหมาย ${r.targeted} · ส่งสำเร็จ ${r.sent} · ข้าม ${r.skipped} · ล้มเหลว ${r.failed}`); qc.invalidateQueries({ queryKey: ['campaigns'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title="แคมเปญ LINE อัตโนมัติ (Marketing automation)" description="ส่งคูปองตามพฤติกรรมลูกค้าผ่าน LINE → ติดตามการใช้คูปองกลับมาที่การขาย (closed loop)" />

      <Card className="mb-4 gap-3 p-4">
        <h3 className="text-sm font-semibold text-muted-foreground">สร้างแคมเปญใหม่</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1"><Label htmlFor="name" className="text-xs">ชื่อแคมเปญ</Label><Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น คิดถึงคุณ" className="h-9 w-52" /></div>
          <div className="grid gap-1">
            <Label className="text-xs">กลุ่มเป้าหมาย</Label>
            <Select value={trigger} onValueChange={setTrigger}>
              <SelectTrigger className="h-9 w-60"><SelectValue /></SelectTrigger>
              <SelectContent>{TRIGGERS.map((t) => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-1"><Label htmlFor="disc" className="text-xs">ส่วนลด (บาท)</Label><Input id="disc" type="number" min={0} value={discount} onChange={(e) => setDiscount(Math.max(0, +e.target.value))} className="h-9 w-32" /></div>
          <Button disabled={run.isPending} onClick={() => run.mutate()}><Send className="size-4" /> {run.isPending ? 'กำลังส่ง…' : 'ส่งแคมเปญ'}</Button>
        </div>
        {msg && <Msg ok={!msg.startsWith('❌')}>{msg}</Msg>}
        <p className="text-xs text-muted-foreground">เฉพาะสมาชิกที่ยินยอมรับข่าวสารและผูกบัญชี LINE เท่านั้นที่จะได้รับ — ระบบข้ามผู้ที่ไม่ยินยอมโดยอัตโนมัติ</p>
      </Card>

      <Card className="gap-3 p-4">
        <h3 className="text-sm font-semibold text-muted-foreground">แคมเปญที่ผ่านมา — อัตราการใช้คูปอง & รายได้ที่เกิดขึ้น</h3>
        <StateView q={list}>
          {list.data && (
            <DataTable
              rows={list.data.campaigns}
              rowKey={(r: any) => r.id}
              columns={[
                { key: 'name', label: 'แคมเปญ', render: (r: any) => <span className="flex items-center gap-1.5"><Megaphone className="size-3.5 text-muted-foreground" />{r.name}</span> },
                { key: 'trigger', label: 'กลุ่ม', render: (r: any) => <Badge variant="muted">{r.trigger}</Badge> },
                { key: 'sent', label: 'ส่ง', align: 'right', render: (r: any) => num(r.sent) },
                { key: 'redeemed', label: 'ใช้คูปอง', align: 'right', render: (r: any) => num(r.redeemed) },
                { key: 'redemption_rate_pct', label: 'อัตราการใช้', align: 'right', render: (r: any) => <Badge variant={r.redemption_rate_pct >= 20 ? 'success' : 'muted'}>{r.redemption_rate_pct}%</Badge> },
                { key: 'attributed_revenue', label: 'รายได้ที่เกิด', align: 'right', render: (r: any) => baht(r.attributed_revenue) },
              ]}
            />
          )}
        </StateView>
      </Card>
    </div>
  );
}
