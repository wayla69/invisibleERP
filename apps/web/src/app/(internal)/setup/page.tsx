'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Building2, Loader2, MapPin, Palette, ReceiptText, Save } from 'lucide-react';
import { api } from '@/lib/api';
import { notifyError, notifySuccess } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { FormField } from '@/components/form-field';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

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

// Field config: label + optional helper hint. Validated fields also appear in `validate()` below.
type FieldDef = { key: string; label: string; hint?: string };
const FIELDS_IDENTITY: FieldDef[] = [
  { key: 'legal_name', label: 'ชื่อนิติบุคคล (ตามทะเบียน)', hint: 'ตามหนังสือรับรอง — พิมพ์บนใบกำกับภาษี' },
  { key: 'tax_id', label: 'เลขประจำตัวผู้เสียภาษี', hint: 'ตัวเลข 13 หลัก' },
  { key: 'branch_code', label: 'รหัสสาขา', hint: '00000 = สำนักงานใหญ่' },
  { key: 'phone', label: 'โทรศัพท์' },
  { key: 'email', label: 'อีเมล' },
  { key: 'promptpay_id', label: 'พร้อมเพย์ (สำหรับ QR รับเงิน)', hint: 'เบอร์มือถือ 10 หลัก หรือเลขบัตร 13 หลัก' },
];
const FIELDS_ADDRESS: FieldDef[] = [
  { key: 'address_line1', label: 'ที่อยู่ (บรรทัด 1)' },
  { key: 'address_line2', label: 'ที่อยู่ (บรรทัด 2)' },
  { key: 'sub_district', label: 'ตำบล/แขวง' },
  { key: 'district', label: 'อำเภอ/เขต' },
  { key: 'province', label: 'จังหวัด' },
  { key: 'postal_code', label: 'รหัสไปรษณีย์', hint: 'ตัวเลข 5 หลัก' },
];

/** Client-side format checks — all optional fields, but if filled they must be well-formed. Returns a map of
 *  field key → Thai error message; an empty map means the form is valid. Mirrors the tax-doc format rules so
 *  a bad tax ID / PromptPay is caught before it ever reaches a printed invoice. */
function validate(form: Record<string, any>): Record<string, string> {
  const e: Record<string, string> = {};
  const s = (k: string) => String(form[k] ?? '').trim();
  if (s('tax_id') && !/^\d{13}$/.test(s('tax_id'))) e.tax_id = 'เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก';
  if (s('branch_code') && !/^\d{5}$/.test(s('branch_code'))) e.branch_code = 'รหัสสาขาต้องเป็นตัวเลข 5 หลัก (เช่น 00000)';
  if (s('email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s('email'))) e.email = 'รูปแบบอีเมลไม่ถูกต้อง';
  if (s('postal_code') && !/^\d{5}$/.test(s('postal_code'))) e.postal_code = 'รหัสไปรษณีย์ต้องเป็นตัวเลข 5 หลัก';
  if (s('promptpay_id') && !/^(\d{10}|\d{13})$/.test(s('promptpay_id'))) e.promptpay_id = 'พร้อมเพย์ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขบัตร 13 หลัก';
  const rate = Number(form.vat_rate);
  if (form.vat_registered && (!Number.isFinite(rate) || rate <= 0 || rate >= 1)) e.vat_rate = 'อัตรา VAT ต้องอยู่ระหว่าง 0 ถึง 1 (เช่น 0.07 = 7%)';
  return e;
}

export default function SetupPage() {
  const qc = useQueryClient();
  const q = useQuery<Profile>({ queryKey: ['tenant-profile'], queryFn: () => api('/api/tenant/profile') });
  const [form, setForm] = useState<Record<string, any>>({});
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => { if (q.data) setForm(q.data as any); }, [q.data]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const errors = useMemo(() => validate(form), [form]);
  const errFor = (k: string) => (showErrors ? errors[k] : undefined);

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
    onSuccess: (p) => { notifySuccess('บันทึกข้อมูลกิจการเรียบร้อย'); qc.setQueryData(['tenant-profile'], p); setForm(p as any); setShowErrors(false); },
    onError: (e: any) => notifyError(e?.message ?? 'บันทึกไม่สำเร็จ'),
  });

  const onSave = () => {
    setShowErrors(true);
    if (Object.keys(validate(form)).length > 0) { notifyError('กรุณาแก้ไขข้อมูลที่ไม่ถูกต้องก่อนบันทึก'); return; }
    save.mutate();
  };

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
              {FIELDS_IDENTITY.map(({ key, label, hint }) => (
                <FormField key={key} htmlFor={key} label={label} hint={hint} error={errFor(key)}>
                  <Input id={key} value={form[key] ?? ''} onChange={set(key)} aria-invalid={!!errFor(key)} />
                </FormField>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ReceiptText className="size-4 text-primary" /> ภาษีมูลค่าเพิ่ม (VAT)</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <FormField htmlFor="vat_registered" label="จดทะเบียน VAT">
                <select
                  id="vat_registered"
                  className="h-9 rounded-md border bg-transparent px-3 text-sm"
                  value={form.vat_registered ? '1' : '0'}
                  onChange={(e) => setForm((f) => ({ ...f, vat_registered: e.target.value === '1' }))}
                >
                  <option value="0">ไม่ได้จด VAT</option>
                  <option value="1">จดทะเบียน VAT แล้ว</option>
                </select>
              </FormField>
              <FormField htmlFor="vat_rate" label="อัตรา VAT" hint="เช่น 0.07 = 7%" error={errFor('vat_rate')}>
                <Input id="vat_rate" type="number" step="0.0001" value={form.vat_rate ?? 0.07} onChange={set('vat_rate')} className="tabular" aria-invalid={!!errFor('vat_rate')} />
              </FormField>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><MapPin className="size-4 text-primary" /> ที่อยู่</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {FIELDS_ADDRESS.map(({ key, label, hint }) => (
                <FormField key={key} htmlFor={key} label={label} hint={hint} error={errFor(key)}>
                  <Input id={key} value={form[key] ?? ''} onChange={set(key)} aria-invalid={!!errFor(key)} />
                </FormField>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Palette className="size-4 text-primary" /> ตราสินค้า (Branding) — แสดงบนใบเสร็จ/เอกสาร</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <FormField htmlFor="logo_url" label="โลโก้ (วาง URL รูปภาพ https:// หรือ data URI)" className="sm:col-span-2">
                <Input id="logo_url" value={form.logo_url ?? ''} onChange={set('logo_url')} placeholder="https://…/logo.png" />
              </FormField>
              <FormField htmlFor="tagline" label="สโลแกน / คำโปรย (แสดงใต้ชื่อกิจการ)" className="sm:col-span-2">
                <Input id="tagline" value={form.tagline ?? ''} onChange={set('tagline')} placeholder="เช่น พันธมิตรที่ไว้ใจได้" />
              </FormField>
              <FormField htmlFor="show_logo" label="แสดงโลโก้บนใบเสร็จ">
                <select
                  id="show_logo"
                  className="h-9 rounded-md border bg-transparent px-3 text-sm"
                  value={(form.branding_prefs?.show_logo_on_receipt === false) ? '0' : '1'}
                  onChange={(e) => setForm((f) => ({ ...f, branding_prefs: { ...(f.branding_prefs ?? {}), show_logo_on_receipt: e.target.value === '1' } }))}
                >
                  <option value="1">แสดง</option>
                  <option value="0">ไม่แสดง</option>
                </select>
              </FormField>
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
            <Button onClick={onSave} disabled={save.isPending}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              บันทึก
            </Button>
            {showErrors && Object.keys(errors).length > 0 && (
              <span className="text-sm text-destructive" role="alert">มีข้อมูลที่ต้องแก้ไข {Object.keys(errors).length} รายการ</span>
            )}
          </div>
        </div>
      </StateView>
    </div>
  );
}
