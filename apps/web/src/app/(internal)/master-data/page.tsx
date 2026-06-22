'use client';

import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { api, apiDownload } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

const selectCls =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

interface Entity { key: string; label_en: string; label_th: string; required: string[]; columns: string[]; allow_replace: boolean }

export default function MasterDataPage() {
  const list = useQuery<{ entities: Entity[] }>({ queryKey: ['md-entities'], queryFn: () => api('/api/admin/master-data/entities') });
  const [sel, setSel] = useState('');
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const entities = list.data?.entities ?? [];
  const ent = entities.find((e) => e.key === sel) ?? entities[0];
  const key = ent?.key;

  async function dl(path: string, filename: string, label: string) {
    setMsg(''); setBusy(label);
    try { await apiDownload(path, filename); } catch (e: any) { setMsg(`❌ ${e.message}`); } finally { setBusy(''); }
  }

  async function onFile(file: File) {
    if (!ent) return;
    setMsg(''); setBusy('import');
    try {
      const csv = await file.text();
      const r = await api<{ imported: number }>(`/api/admin/master-data/${ent.key}/import`, {
        method: 'POST', body: JSON.stringify({ format: 'csv', mode, csv }),
      });
      setMsg(`✅ นำเข้า ${r.imported} แถวเข้า ${ent.label_th} สำเร็จ`);
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div>
      <PageHeader title="ข้อมูลหลัก (Master Data)" description="นำเข้า / ส่งออก ข้อมูลหลักทุกประเภท (สินค้า ลูกค้า ผู้ขาย คลัง ราคา โปรโมชั่น BoM ทรัพย์สิน)" />
      <StateView q={list}>
        <div className="space-y-4">
          <Card className="gap-3 p-5">
            <div className="grid gap-1.5 max-w-sm">
              <Label htmlFor="md-ent">ประเภทข้อมูล</Label>
              <select id="md-ent" className={selectCls} value={key ?? ''} onChange={(e) => setSel(e.target.value)}>
                {entities.map((e) => <option key={e.key} value={e.key}>{e.label_th} ({e.label_en})</option>)}
              </select>
            </div>
            {ent && (
              <div className="text-sm text-muted-foreground">
                คอลัมน์ที่จำเป็น: {ent.required.map((c) => <code key={c} className="mx-0.5 rounded bg-muted px-1 py-0.5 text-xs">{c}</code>)}
              </div>
            )}
            <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
          </Card>

          {ent && (
            <div className="grid gap-4 md:grid-cols-2">
              <Card className="gap-3 p-5">
                <h3 className="text-base font-semibold">ส่งออก (Export)</h3>
                <p className="text-sm text-muted-foreground">ดาวน์โหลดข้อมูลปัจจุบันเพื่อดูหรือแก้ไขแล้วนำเข้ากลับ</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={!!busy} onClick={() => dl(`/api/admin/master-data/${key}/export`, `${key}.xlsx`, 'xlsx')}>
                    <FileSpreadsheet className="size-4" /> Excel
                  </Button>
                  <Button variant="outline" disabled={!!busy} onClick={() => dl(`/api/admin/master-data/${key}/export?format=csv`, `${key}.csv`, 'csv')}>
                    <Download className="size-4" /> CSV
                  </Button>
                  <Button variant="outline" disabled={!!busy} onClick={() => dl(`/api/admin/master-data/${key}/template`, `${key}_template.xlsx`, 'tpl')}>
                    <Download className="size-4" /> แบบฟอร์ม (Template)
                  </Button>
                </div>
              </Card>

              <Card className="gap-3 p-5">
                <h3 className="text-base font-semibold">นำเข้า (Import)</h3>
                <p className="text-sm text-muted-foreground">อัปโหลดไฟล์ CSV (หัวคอลัมน์ตรงกับแบบฟอร์ม)</p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="md-mode">โหมด</Label>
                    <select id="md-mode" className={`${selectCls} max-w-[200px]`} value={mode} onChange={(e) => setMode(e.target.value as any)}>
                      <option value="append">เพิ่ม / ข้ามที่ซ้ำ (Append)</option>
                      <option value="replace" disabled={!ent.allow_replace}>แทนที่ทั้งหมด (Replace){!ent.allow_replace ? ' — ไม่อนุญาต' : ''}</option>
                    </select>
                  </div>
                  <Button disabled={!!busy} onClick={() => fileRef.current?.click()}>
                    <Upload className="size-4" /> {busy === 'import' ? 'กำลังนำเข้า…' : 'เลือกไฟล์ CSV'}
                  </Button>
                  <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
                </div>
                {mode === 'replace' && <Badge variant="destructive">โหมดแทนที่จะลบข้อมูลเดิมทั้งหมดก่อนนำเข้า</Badge>}
              </Card>
            </div>
          )}
        </div>
      </StateView>
    </div>
  );
}
