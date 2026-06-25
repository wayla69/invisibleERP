'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Receipt, Coins, Ban, Plus, ExternalLink, FileCode, Mail, SearchX } from 'lucide-react';
import { api } from '@/lib/api';
import { baht, num, thaiDate } from '@/lib/format';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusVariant } from '@/components/ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

type Invoice = {
  doc_no: string;
  type: 'full' | 'abbreviated';
  status: string;
  issue_date: string;
  source_type: string;
  source_ref: string;
  buyer: { name: string } | null;
  subtotal: number;
  vat_amount: number;
  grand_total: number;
};

const typeLabel = (t: string) => (t === 'abbreviated' ? 'อย่างย่อ (ม.86/6)' : 'เต็มรูป (ม.86/4)');

export default function TaxInvoicesPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'' | 'full' | 'abbreviated'>('');
  const q = useQuery<{ invoices: Invoice[]; count: number }>({
    queryKey: ['tax-invoices', filter],
    queryFn: () => api(`/api/tax-invoices${filter ? `?type=${filter}` : ''}`),
  });

  const invoices = q.data?.invoices ?? [];
  const totalVat = invoices.reduce((a, r) => a + (r.vat_amount || 0), 0);
  const totalGrand = invoices.reduce((a, r) => a + (r.grand_total || 0), 0);

  // ── ออกใบกำกับภาษีเต็มรูป (ม.86/4) ──
  const [src, setSrc] = useState<'POS' | 'AR'>('POS');
  const [srcRef, setSrcRef] = useState('');
  const [buyerName, setBuyerName] = useState('');
  const [buyerTaxId, setBuyerTaxId] = useState('');
  const [buyerAddr, setBuyerAddr] = useState('');

  const issue = useMutation({
    mutationFn: () =>
      api<{ doc_no: string }>('/api/tax-invoices/full', {
        method: 'POST',
        body: JSON.stringify({
          source_type: src,
          source_ref: srcRef,
          buyer: { name: buyerName, tax_id: buyerTaxId || undefined, address: buyerAddr },
        }),
      }),
    onSuccess: (r) => {
      notifySuccess(`ออกใบกำกับภาษีสำเร็จ: ${r.doc_no}`);
      setSrcRef(''); setBuyerName(''); setBuyerTaxId(''); setBuyerAddr('');
      qc.invalidateQueries({ queryKey: ['tax-invoices'] });
    },
    onError: (e: any) => notifyError(e.message),
  });

  const canIssue = !!srcRef && !!buyerName && !!buyerAddr && !issue.isPending;

  // ── ส่ง e-Tax Invoice by Email (ETDA, ไม่ต้องมีใบรับรอง CA) ──
  const [emailDoc, setEmailDoc] = useState<string | null>(null);
  const [emailTo, setEmailTo] = useState('');
  const sendEmail = useMutation({
    mutationFn: () =>
      api<{ cc: string }>(`/api/tax-invoices/${emailDoc}/send-etax-email`, {
        method: 'POST',
        body: JSON.stringify({ to_email: emailTo }),
      }),
    onSuccess: (r) => notifySuccess(`ส่งแล้ว — สำเนาถึงระบบประทับเวลา ETDA (${r.cc})`),
    onError: (e: any) => notifyError(e.message),
  });
  const openEmail = (docNo: string) => { setEmailDoc(docNo); setEmailTo(''); };

  return (
    <div>
      <PageHeader
        title="ใบกำกับภาษี"
        description="ใบกำกับภาษีเต็มรูป (ม.86/4) และอย่างย่อ (ม.86/6) — เลขที่เอกสารห้ามนำกลับมาใช้ซ้ำ"
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button variant={filter === '' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('')}>
          ทั้งหมด
        </Button>
        <Button variant={filter === 'full' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('full')}>
          เต็มรูป
        </Button>
        <Button variant={filter === 'abbreviated' ? 'default' : 'outline'} size="sm" onClick={() => setFilter('abbreviated')}>
          อย่างย่อ
        </Button>
      </div>

      <Card className="mb-6 max-w-2xl gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plus className="size-4" /> ออกใบกำกับภาษีเต็มรูป (ม.86/4)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="src">แหล่งอ้างอิง</Label>
              <div className="flex gap-2">
                <Button type="button" variant={src === 'POS' ? 'default' : 'outline'} size="sm" onClick={() => setSrc('POS')}>
                  POS
                </Button>
                <Button type="button" variant={src === 'AR' ? 'default' : 'outline'} size="sm" onClick={() => setSrc('AR')}>
                  AR
                </Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="src-ref">เลขที่อ้างอิง ({src === 'POS' ? 'sale_no' : 'invoice_no'})</Label>
              <Input id="src-ref" value={srcRef} onChange={(e) => setSrcRef(e.target.value)} placeholder={src === 'POS' ? 'SALE-…' : 'INV-…'} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="buyer-name">ชื่อผู้ซื้อ</Label>
            <Input id="buyer-name" value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder="ชื่อผู้ซื้อ (จำเป็น)" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="buyer-taxid">เลขประจำตัวผู้เสียภาษี (13 หลัก)</Label>
              <Input id="buyer-taxid" value={buyerTaxId} onChange={(e) => setBuyerTaxId(e.target.value)} placeholder="ไม่บังคับ" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="buyer-addr">ที่อยู่ผู้ซื้อ</Label>
              <Input id="buyer-addr" value={buyerAddr} onChange={(e) => setBuyerAddr(e.target.value)} placeholder="ที่อยู่ (จำเป็น)" />
            </div>
          </div>
          <Button disabled={!canIssue} onClick={() => issue.mutate()}>
            <Receipt className="size-4" /> {issue.isPending ? 'กำลังออก…' : 'ออกใบกำกับภาษี'}
          </Button>
        </CardContent>
      </Card>

      <StateView q={q}>
        {q.data && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="จำนวนใบกำกับ" value={num(q.data.count)} icon={FileText} tone="primary" />
              <StatCard label="รวมภาษีมูลค่าเพิ่ม" value={baht(totalVat)} icon={Coins} tone="info" />
              <StatCard label="รวมมูลค่าทั้งสิ้น" value={baht(totalGrand)} icon={Receipt} />
              <StatCard
                label="ใบกำกับอย่างย่อ"
                value={num(invoices.filter((r) => r.type === 'abbreviated').length)}
                icon={FileText}
                tone="default"
              />
            </div>
            <DataTable
              rows={invoices}
              columns={[
                { key: 'doc_no', label: 'เลขที่เอกสาร' },
                { key: 'issue_date', label: 'วันที่', render: (r: Invoice) => thaiDate(r.issue_date) },
                { key: 'type', label: 'ประเภท', render: (r: Invoice) => typeLabel(r.type) },
                { key: 'buyer', label: 'ผู้ซื้อ', render: (r: Invoice) => r.buyer?.name ?? 'เงินสด' },
                { key: 'source_ref', label: 'อ้างอิง', render: (r: Invoice) => `${r.source_type} · ${r.source_ref}` },
                { key: 'subtotal', label: 'มูลค่า', align: 'right', render: (r: Invoice) => <span className="tabular">{baht(r.subtotal)}</span> },
                { key: 'vat_amount', label: 'VAT', align: 'right', render: (r: Invoice) => <span className="tabular">{baht(r.vat_amount)}</span> },
                { key: 'grand_total', label: 'รวม', align: 'right', render: (r: Invoice) => <span className="tabular">{baht(r.grand_total)}</span> },
                { key: 'status', label: 'สถานะ', render: (r: Invoice) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
                {
                  key: 'pdf',
                  label: 'PDF',
                  sortable: false,
                  render: (r: Invoice) => (
                    <Button variant="ghost" size="sm" asChild>
                      <a href={`${BASE}/api/tax-invoices/${r.doc_no}/pdf`} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="size-4" />
                      </a>
                    </Button>
                  ),
                },
                {
                  key: 'xml',
                  label: 'e-Tax XML',
                  sortable: false,
                  render: (r: Invoice) => (
                    <Button variant="ghost" size="sm" asChild title="ดาวน์โหลด e-Tax XML (UBL 2.1)">
                      <a href={`${BASE}/api/tax-invoices/${r.doc_no}/etax-xml`} target="_blank" rel="noopener noreferrer">
                        <FileCode className="size-4" />
                      </a>
                    </Button>
                  ),
                },
                {
                  key: 'email',
                  label: 'ส่งอีเมล',
                  sortable: false,
                  render: (r: Invoice) => (
                    <Button variant="ghost" size="sm" title="ส่ง e-Tax ทางอีเมล (ประทับเวลา ETDA)" onClick={() => openEmail(r.doc_no)}>
                      <Mail className="size-4" />
                    </Button>
                  ),
                },
              ]}
              emptyState={
                filter
                  ? {
                      icon: SearchX,
                      title: 'ไม่พบใบกำกับภาษีที่ตรงกับตัวกรอง',
                      description: 'ลองเลือกประเภทอื่น หรือล้างตัวกรองเพื่อดูทั้งหมด',
                      action: (
                        <Button variant="outline" size="sm" onClick={() => setFilter('')}>
                          ล้างตัวกรอง
                        </Button>
                      ),
                    }
                  : {
                      icon: FileText,
                      title: 'ยังไม่มีใบกำกับภาษี',
                      description: 'ออกใบกำกับภาษีเต็มรูป (ม.86/4) จากฟอร์มด้านบนเพื่อเริ่มต้น',
                    }
              }
            />
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Ban className="size-3.5" /> การยกเลิกใบกำกับ (void) ไม่ลบเลขที่เอกสาร — ระบบจะเก็บไว้และเปลี่ยนสถานะเป็น Voided ตามข้อกำหนดสรรพากร
            </p>
          </div>
        )}
      </StateView>

      <Dialog open={!!emailDoc} onOpenChange={(o) => !o && setEmailDoc(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ส่ง e-Tax ทางอีเมล — {emailDoc}</DialogTitle>
            <DialogDescription>
              ระบบ e-Tax Invoice by Email (สำหรับกิจการรายได้ ≤ 30 ล้าน/ปี) — ส่งใบกำกับให้ผู้ซื้อ พร้อมสำเนา (CC) ถึงระบบประทับรับรองเวลาของ ETDA โดยไม่ต้องมีใบรับรองอิเล็กทรอนิกส์ (CA)
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="email-to">อีเมลผู้ซื้อ</Label>
            <Input id="email-to" type="email" placeholder="buyer@example.com" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEmailDoc(null)}>ปิด</Button>
            <Button onClick={() => sendEmail.mutate()} disabled={!emailTo.includes('@') || sendEmail.isPending}>
              <Mail className="size-4" /> ส่งอีเมล
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
