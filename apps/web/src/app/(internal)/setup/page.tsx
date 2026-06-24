'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Building2, Loader2, MapPin, Palette, ReceiptText, Save } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Msg } from '@/components/tabs';

interface Profile {
  code: string; name: string; legal_name: string | null; tax_id: string | null; branch_code: string | null;
  vat_registered: boolean; vat_rate: number; tax_country: string;
  phone: string | null; email: string | null;
  address_line1: string | null; address_line2: string | null; sub_district: string | null;
  district: string | null; province: string | null; postal_code: string | null;
  promptpay_id: string | null;
  logo_url: string | null; tagline: string | null; branding_prefs: Record<string, unknown>;
  setup_complete: boolean;
}

const FIELDS_IDENTITY = [
  ['legal_name', 'ชื่อนิติบุคคล (ตามทะเบียน)'], ['tax_id', 'เลขประจำตัวผู้เสียภาษี (13 หลัก)'],
  ['branch_code', 'รหัสสาขา (00000 = สำนักงานใหญ่)'], ['phone', 'โทรศัพท์'], ['email', 'อีเมล'],
  ['promptpay_id', 'พร้อมเพย์ (เบอร์มือถือ/เลขบัตร 13 หลัก) — สำหรับ QR รับเงิน'],
] as const;
const FIELDS_ADDRESS = [
  ['address_line1', 'ที่อยู่ (บรรทัด 1)'], ['address_line2', 'ที่อยู่ (บรรทัด 2)'],
  ['sub_district', 'ตำบล/แขวง'], ['district', 'อำเภอ/เขต'], ['province', 'จังหวัด'], ['postal_code', 'รหัสไปรษณีย์'],
] as const;

export default function SetupPage() {
  const qc = useQueryClient();
  const q = useQuery<Profile>({ queryKey: ['tenant-profile'], queryFn: () => api('/api/tenant/profile') });
  const [form, setForm] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState('');

  useEffect(() => { if (q.data) setForm(q.data as any); }, [q.data]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: () => api<Profile>('/api/tenant/profile', {
      method: 'PATCH',
      body: JSON.stringify({
        legal_name: form.legal_name, tax_id: form.tax_id, branch_code: form.branch_code,
        vat_registered: !!form.vat_registered, vat_rate: Number(form.vat_rate) || 0.07, name: form.name,
        phone: form.phone, email: form.email,
        address_line1: form.address_line1, address_line2: form.address_line2, sub_district: form.sub_district,
        district: form.district, province: form.province, postal_code: form.postal_code,
        promptpay_id: form.promptpay_id || undefined,
        logo_url: form.logo_url ?? '', tagline: form.tagline ?? '',
        branding_prefs: form.branding_prefs ?? {},
      }),
    }),
    onSuccess: (p) => { setMsg('✅ บันทึกข้อมูลกิจการเรียบร้อย'); qc.setQueryData(['tenant-profile'], p); setForm(p as any); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader
        title="ตั้งค่ากิจการ"
        description="ข้อมูลนี้ใช้ออกใบกำกับภาษีและเอกสารทางการ — กรอกให้ครบก่อนเปิดใช้งานเต็มรูปแบบ"
        actions={q.data ? (
          q.data.setup_complete
            ? <Badge variant="success"><BadgeCheck className="size-3" /> ตั้งค่าครบแล้ว</Badge>
            : <Badge variant="warning">ยังตั้งค่าไม่ครบ</Badge>
        ) : null}
      />
      <StateView q={q}>
        <div className="grid max-w-3xl gap-6">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Building2 className="size-4 text-primary" /> ข้อมูลนิติบุคคล</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {FIELDS_IDENTITY.map(([k, label]) => (
                <div key={k} className="grid gap-2">
                  <Label htmlFor={k}>{label}</Label>
                  <Input id={k} value={form[k] ?? ''} onChange={set(k)} />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ReceiptText className="size-4 text-primary" /> ภาษีมูลค่าเพิ่ม (VAT)</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="vat_registered">จดทะเบียน VAT</Label>
                <select
                  id="vat_registered"
                  className="h-9 rounded-md border bg-transparent px-3 text-sm"
                  value={form.vat_registered ? '1' : '0'}
                  onChange={(e) => setForm((f) => ({ ...f, vat_registered: e.target.value === '1' }))}
                >
                  <option value="0">ไม่ได้จด VAT</option>
                  <option value="1">จดทะเบียน VAT แล้ว</option>
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="vat_rate">อัตรา VAT (เช่น 0.07 = 7%)</Label>
                <Input id="vat_rate" type="number" step="0.0001" value={form.vat_rate ?? 0.07} onChange={set('vat_rate')} className="tabular" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><MapPin className="size-4 text-primary" /> ที่อยู่</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {FIELDS_ADDRESS.map(([k, label]) => (
                <div key={k} className="grid gap-2">
                  <Label htmlFor={k}>{label}</Label>
                  <Input id={k} value={form[k] ?? ''} onChange={set(k)} />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Palette className="size-4 text-primary" /> ตราสินค้า (Branding) — แสดงบนใบเสร็จ/เอกสาร</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="logo_url">โลโก้ (วาง URL รูปภาพ https:// หรือ data URI)</Label>
                <Input id="logo_url" value={form.logo_url ?? ''} onChange={set('logo_url')} placeholder="https://…/logo.png" />
              </div>
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="tagline">สโลแกน / คำโปรย (แสดงใต้ชื่อกิจการ)</Label>
                <Input id="tagline" value={form.tagline ?? ''} onChange={set('tagline')} placeholder="เช่น พันธมิตรที่ไว้ใจได้" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="show_logo">แสดงโลโก้บนใบเสร็จ</Label>
                <select
                  id="show_logo"
                  className="h-9 rounded-md border bg-transparent px-3 text-sm"
                  value={(form.branding_prefs?.show_logo_on_receipt === false) ? '0' : '1'}
                  onChange={(e) => setForm((f) => ({ ...f, branding_prefs: { ...(f.branding_prefs ?? {}), show_logo_on_receipt: e.target.value === '1' } }))}
                >
                  <option value="1">แสดง</option>
                  <option value="0">ไม่แสดง</option>
                </select>
              </div>
              {form.logo_url ? (
                <div className="grid gap-2">
                  <Label>ตัวอย่าง</Label>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={form.logo_url} alt="logo preview" className="max-h-12 w-fit rounded border bg-white p-1" />
                </div>
              ) : null}
            </CardContent>
          </Card>

          <div className="flex items-center gap-3">
            <Button onClick={() => { setMsg(''); save.mutate(); }} disabled={save.isPending}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              บันทึก
            </Button>
            {msg && <Msg ok={msg.startsWith('✅')}>{msg}</Msg>}
          </div>
        </div>
      </StateView>
    </div>
  );
}
