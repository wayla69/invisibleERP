'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Route, Save, Eye } from 'lucide-react';
import { api } from '@/lib/api';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// กฎการลงบัญชี — read + tenant-override editor over the account-determination engine (posting_rules).
// Global defaults ship with the product; a tenant shadows a leg with its own account (docs/33 · GL-12/GL-21).
export default function PostingRulesPage() {
  const qc = useQueryClient();
  const events = useQuery<any[]>({ queryKey: ['posting-event-types'], queryFn: () => api('/api/ledger/posting-rules/event-types') });
  const [eventType, setEventType] = useState('');
  const rules = useQuery<any>({ queryKey: ['posting-rules', eventType], queryFn: () => api(`/api/ledger/posting-rules?eventType=${encodeURIComponent(eventType)}`), enabled: !!eventType });

  const [legOrder, setLegOrder] = useState('1');
  const [role, setRole] = useState('');
  const [side, setSide] = useState<'DR' | 'CR'>('DR');
  const [accountCode, setAccountCode] = useState('');
  const upsert = useMutation({
    mutationFn: () => api('/api/ledger/posting-rules', { method: 'POST', body: JSON.stringify({ eventType, legOrder: Number(legOrder), role: role.trim(), side, accountCode: accountCode.trim() }) }),
    onSuccess: () => { notifySuccess('บันทึกกฎเฉพาะกิจการแล้ว'); setRole(''); setAccountCode(''); qc.invalidateQueries({ queryKey: ['posting-rules', eventType] }); },
    onError: (e: any) => notifyError(e.message),
  });

  const [amounts, setAmounts] = useState('{"inventory":1000}');
  const preview = useMutation<any[]>({
    mutationFn: () => api('/api/ledger/posting-rules/preview', { method: 'POST', body: JSON.stringify({ eventType, amounts: JSON.parse(amounts || '{}') }) }),
    onError: (e: any) => notifyError(e.message?.includes('JSON') ? 'จำนวนเงิน (amounts) ต้องเป็น JSON ที่ถูกต้อง' : e.message),
  });

  const eventList = events.data ?? [];

  return (
    <div>
      <PageHeader title="กฎการลงบัญชี (Posting Rules / Account Determination)" description="ผังการกำหนดบัญชีต่อเหตุการณ์ทางบัญชี — ค่าปริยายมากับระบบ กิจการสามารถแทนที่บัญชีของแต่ละ leg ได้เอง และดูตัวอย่างรายการก่อนใช้งานจริง" />
      <div className="space-y-5">
        <Card className="max-w-xl gap-4 p-5">
          <Label>เหตุการณ์ทางบัญชี (Event type)</Label>
          <Select value={eventType} onValueChange={setEventType}>
            <SelectTrigger className="w-full"><SelectValue placeholder="เลือกเหตุการณ์…" /></SelectTrigger>
            <SelectContent>
              {eventList.map((e: any) => <SelectItem key={e.key} value={e.key}>{e.key} — {e.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </Card>

        {eventType && (
          <>
            <Card className="gap-4 p-5">
              <h3 className="text-base font-semibold">กฎที่ใช้อยู่</h3>
              <DataTable
                rows={rules.data ?? []}
                rowKey={(r: any, i: number) => `${r.legOrder}-${r.role}-${i}`}
                columns={[
                  { key: 'legOrder', label: 'ลำดับ' },
                  { key: 'role', label: 'บทบาท (role)' },
                  { key: 'side', label: 'ด้าน', render: (r: any) => <Badge variant={r.side === 'DR' ? 'success' : 'warning'}>{r.side}</Badge> },
                  { key: 'accountCode', label: 'บัญชี' },
                  { key: 'tenantId', label: 'ที่มา', render: (r: any) => <Badge variant={r.tenantId ? 'info' : 'muted'}>{r.tenantId ? 'กิจการ (override)' : 'ค่าปริยาย'}</Badge> },
                ]}
                emptyState={{ icon: Route, title: 'ยังไม่มีกฎสำหรับเหตุการณ์นี้', description: 'เพิ่มกฎเฉพาะกิจการด้านล่าง' }}
              />
            </Card>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="gap-4 p-5">
                <h3 className="text-base font-semibold">แทนที่บัญชี (override เฉพาะกิจการ)</h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2"><Label>ลำดับ (leg)</Label><Input type="number" value={legOrder} onChange={(e) => setLegOrder(e.target.value)} /></div>
                  <div className="grid gap-2"><Label>บทบาท (role)</Label><Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="เช่น inventory / cogs" /></div>
                  <div className="grid gap-2">
                    <Label>ด้าน</Label>
                    <Select value={side} onValueChange={(v) => setSide(v as 'DR' | 'CR')}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="DR">เดบิต (DR)</SelectItem><SelectItem value="CR">เครดิต (CR)</SelectItem></SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2"><Label>บัญชี</Label><Input value={accountCode} onChange={(e) => setAccountCode(e.target.value)} placeholder="เช่น 5000" /></div>
                </div>
                <div>
                  <Button disabled={upsert.isPending || !role.trim() || !accountCode.trim()} onClick={() => upsert.mutate()}><Save className="size-4" /> {upsert.isPending ? 'กำลังบันทึก…' : 'บันทึก override'}</Button>
                </div>
              </Card>

              <Card className="gap-4 p-5">
                <h3 className="text-base font-semibold">ดูตัวอย่างรายการ (Preview)</h3>
                <div className="grid gap-2">
                  <Label>จำนวนเงินตามบทบาท (JSON)</Label>
                  <Input value={amounts} onChange={(e) => setAmounts(e.target.value)} placeholder='{"inventory":1000}' />
                </div>
                <div><Button variant="outline" disabled={preview.isPending} onClick={() => preview.mutate()}><Eye className="size-4" /> แสดงตัวอย่าง</Button></div>
                {preview.data && (
                  <DataTable
                    rows={preview.data as any[]}
                    rowKey={(r: any, i: number) => i}
                    columns={[
                      { key: 'role', label: 'บทบาท' },
                      { key: 'side', label: 'ด้าน', render: (r: any) => <Badge variant={r.side === 'DR' ? 'success' : 'warning'}>{r.side}</Badge> },
                      { key: 'accountCode', label: 'บัญชี' },
                      { key: 'amount', label: 'จำนวน', align: 'right', render: (r: any) => Number(r.amount).toLocaleString() },
                    ]}
                    emptyState={{ icon: Eye, title: 'ยังไม่มีตัวอย่าง', description: 'กดแสดงตัวอย่าง' }}
                  />
                )}
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
