'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Loader2, Save, Star, Trash2, RefreshCw, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { StateView } from '@/components/state-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Msg } from '@/components/tabs';

type DocType = { key: string; label_th: string; label_en: string; status: string };
type Tmpl = { id: number; doc_type: string; name: string; is_default: boolean; active: boolean; config: any };
type ReceiptCfg = {
  header: { show_logo: boolean; header_note: string };
  body: { show_branch: boolean; show_address: boolean; show_tax_id: boolean; accent_color: string; font_scale: number };
  footer: { thanks_text: string; extra_lines: string[] };
  paper: { width_mm: number };
};

const DEFAULT_CFG: ReceiptCfg = {
  header: { show_logo: true, header_note: '' },
  body: { show_branch: true, show_address: true, show_tax_id: true, accent_color: '', font_scale: 1 },
  footer: { thanks_text: '', extra_lines: [] },
  paper: { width_mm: 80 },
};

// Merge a stored config over the defaults so the editor always has a complete shape.
function hydrate(c: any): ReceiptCfg {
  const x = c && typeof c === 'object' ? c : {};
  return {
    header: { ...DEFAULT_CFG.header, ...(x.header ?? {}) },
    body: { ...DEFAULT_CFG.body, ...(x.body ?? {}) },
    footer: { ...DEFAULT_CFG.footer, ...(x.footer ?? {}), extra_lines: Array.isArray(x.footer?.extra_lines) ? x.footer.extra_lines : [] },
    paper: { ...DEFAULT_CFG.paper, ...(x.paper ?? {}) },
  };
}

const YesNo = ({ id, value, onChange }: { id: string; value: boolean; onChange: (v: boolean) => void }) => (
  <select id={id} className="h-9 rounded-md border bg-transparent px-3 text-sm" value={value ? '1' : '0'} onChange={(e) => onChange(e.target.value === '1')}>
    <option value="1">แสดง</option>
    <option value="0">ซ่อน</option>
  </select>
);

export default function DocumentTemplatesPage() {
  const qc = useQueryClient();
  const [docType, setDocType] = useState('receipt');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [cfg, setCfg] = useState<ReceiptCfg>(DEFAULT_CFG);
  const [previewHtml, setPreviewHtml] = useState('');
  const [msg, setMsg] = useState('');

  const types = useQuery<{ doc_types: DocType[] }>({ queryKey: ['doc-types'], queryFn: () => api('/api/document-templates/doc-types') });
  const list = useQuery<{ templates: Tmpl[] }>({ queryKey: ['doc-templates', docType], queryFn: () => api(`/api/document-templates?doc_type=${docType}`) });

  const activeType = types.data?.doc_types.find((d) => d.key === docType);
  const isLive = activeType?.status === 'live';

  const resetEditor = () => { setSelectedId(null); setName(''); setCfg(DEFAULT_CFG); setMsg(''); };
  const loadTemplate = (t: Tmpl) => { setSelectedId(t.id); setName(t.name); setCfg(hydrate(t.config)); setMsg(''); };

  // live preview (debounced via explicit refresh + on key changes)
  const runPreview = async (config = cfg, dt = docType) => {
    try { const r = await api<{ html: string }>('/api/document-templates/preview', { method: 'POST', body: JSON.stringify({ doc_type: dt, config }) }); setPreviewHtml(r.html ?? ''); }
    catch (e: any) { setMsg(`❌ ${e.message}`); }
  };
  useEffect(() => { runPreview(cfg, docType); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [docType, selectedId]);

  const save = useMutation({
    mutationFn: () => selectedId
      ? api(`/api/document-templates/${selectedId}`, { method: 'PUT', body: JSON.stringify({ name, config: cfg }) })
      : api('/api/document-templates', { method: 'POST', body: JSON.stringify({ doc_type: docType, name, config: cfg }) }),
    onSuccess: (r: any) => { setMsg('✅ บันทึกเทมเพลตแล้ว'); if (!selectedId && r?.id) setSelectedId(Number(r.id)); qc.invalidateQueries({ queryKey: ['doc-templates', docType] }); runPreview(); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const setDefault = useMutation({
    mutationFn: (id: number) => api(`/api/document-templates/${id}/default`, { method: 'POST' }),
    onSuccess: () => { setMsg('✅ ตั้งเป็นเทมเพลตเริ่มต้นแล้ว'); qc.invalidateQueries({ queryKey: ['doc-templates', docType] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/document-templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setMsg('🗑️ ลบเทมเพลตแล้ว'); resetEditor(); qc.invalidateQueries({ queryKey: ['doc-templates', docType] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div>
      <PageHeader title="เทมเพลตเอกสาร (Document templates)" description="ปรับรูปแบบเอกสารสำหรับลูกค้า (ใบเสร็จ ฯลฯ) แบบไม่ต้องเขียนโค้ด — ปรับได้เฉพาะการแสดงผล ไม่กระทบยอดเงินและไม่ลงบัญชีแยกประเภท" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Label htmlFor="docType" className="text-sm">ประเภทเอกสาร</Label>
        <select id="docType" className="h-9 rounded-md border bg-transparent px-3 text-sm" value={docType} onChange={(e) => { setDocType(e.target.value); resetEditor(); }}>
          {(types.data?.doc_types ?? [{ key: 'receipt', label_th: 'ใบเสร็จรับเงิน', label_en: 'Receipt', status: 'live' }]).map((d) => (
            <option key={d.key} value={d.key}>{d.label_th} ({d.label_en}){d.status !== 'live' ? ' — เร็วๆ นี้' : ''}</option>
          ))}
        </select>
        {activeType && <Badge variant={isLive ? 'success' : 'warning'}>{isLive ? 'พร้อมใช้งาน' : 'กำลังจะมา'}</Badge>}
        <Button size="sm" variant="outline" onClick={resetEditor}><Plus className="size-4" /> เทมเพลตใหม่</Button>
      </div>

      {!isLive && (
        <Card className="mb-4 border-amber-300/60 bg-amber-50/40">
          <CardContent className="py-3 text-sm text-amber-900">
            เอกสารประเภทนี้บันทึกเทมเพลตได้แล้ว แต่การแสดงตัวอย่าง/พิมพ์จริงจะเปิดใช้งานในรุ่นถัดไป (ปัจจุบันรองรับ “ใบเสร็จรับเงิน” เต็มรูปแบบ)
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_minmax(300px,360px)]">
        {/* ── editor ── */}
        <div className="grid gap-6">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileText className="size-4 text-primary" /> เทมเพลตที่บันทึกไว้</CardTitle></CardHeader>
            <CardContent>
              <StateView q={list}>
                {(list.data?.templates ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">ยังไม่มีเทมเพลต — กรอกด้านล่างแล้วกด “บันทึก”</p>
                ) : (
                  <div className="grid gap-2">
                    {(list.data?.templates ?? []).map((t) => (
                      <div key={t.id} className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${selectedId === t.id ? 'border-primary bg-primary/5' : ''}`}>
                        <button className="flex-1 text-left" onClick={() => loadTemplate(t)}>
                          {t.name} {t.is_default && <Badge variant="success" className="ml-2"><Star className="size-3" /> ค่าเริ่มต้น</Badge>}
                        </button>
                        <div className="flex items-center gap-2">
                          {!t.is_default && <Button size="sm" variant="ghost" onClick={() => setDefault.mutate(t.id)}><Star className="size-4" /> ตั้งเริ่มต้น</Button>}
                          <Button size="sm" variant="ghost" onClick={() => remove.mutate(t.id)}><Trash2 className="size-4 text-destructive" /></Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </StateView>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">{selectedId ? 'แก้ไขเทมเพลต' : 'เทมเพลตใหม่'}</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="tname">ชื่อเทมเพลต</Label>
                <Input id="tname" value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น ใบเสร็จสาขาหลัก" />
              </div>

              <div className="grid gap-2"><Label htmlFor="show_logo">โลโก้</Label><YesNo id="show_logo" value={cfg.header.show_logo} onChange={(v) => setCfg((c) => ({ ...c, header: { ...c.header, show_logo: v } }))} /></div>
              <div className="grid gap-2"><Label htmlFor="hdr">ข้อความหัวบิล (เพิ่มเติม)</Label><Input id="hdr" value={cfg.header.header_note} onChange={(e) => setCfg((c) => ({ ...c, header: { ...c.header, header_note: e.target.value } }))} placeholder="เช่น สมาชิกรับแต้มทุกบิล" /></div>

              <div className="grid gap-2"><Label htmlFor="b_branch">สาขา</Label><YesNo id="b_branch" value={cfg.body.show_branch} onChange={(v) => setCfg((c) => ({ ...c, body: { ...c.body, show_branch: v } }))} /></div>
              <div className="grid gap-2"><Label htmlFor="b_addr">ที่อยู่</Label><YesNo id="b_addr" value={cfg.body.show_address} onChange={(v) => setCfg((c) => ({ ...c, body: { ...c.body, show_address: v } }))} /></div>
              <div className="grid gap-2"><Label htmlFor="b_tax">เลขผู้เสียภาษี</Label><YesNo id="b_tax" value={cfg.body.show_tax_id} onChange={(v) => setCfg((c) => ({ ...c, body: { ...c.body, show_tax_id: v } }))} /></div>
              <div className="grid gap-2">
                <Label htmlFor="accent">สีเน้น (accent)</Label>
                <input id="accent" type="color" className="h-9 w-full rounded-md border bg-transparent px-1" value={cfg.body.accent_color || '#000000'} onChange={(e) => setCfg((c) => ({ ...c, body: { ...c.body, accent_color: e.target.value } }))} />
              </div>
              <div className="grid gap-2"><Label htmlFor="fscale">ขนาดตัวอักษร (0.8–1.4)</Label><Input id="fscale" type="number" step="0.05" min="0.8" max="1.4" value={cfg.body.font_scale} onChange={(e) => setCfg((c) => ({ ...c, body: { ...c.body, font_scale: Number(e.target.value) || 1 } }))} /></div>
              <div className="grid gap-2"><Label htmlFor="paper">ความกว้างกระดาษ (มม.)</Label><Input id="paper" type="number" step="1" min="58" max="112" value={cfg.paper.width_mm} onChange={(e) => setCfg((c) => ({ ...c, paper: { width_mm: Number(e.target.value) || 80 } }))} /></div>

              <div className="grid gap-2 sm:col-span-2"><Label htmlFor="thanks">ข้อความขอบคุณ (ท้ายบิล)</Label><Input id="thanks" value={cfg.footer.thanks_text} onChange={(e) => setCfg((c) => ({ ...c, footer: { ...c.footer, thanks_text: e.target.value } }))} placeholder="เช่น ขอบคุณที่อุดหนุน" /></div>
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="extra">บรรทัดเพิ่มเติมท้ายบิล (บรรทัดละ 1 ข้อความ, สูงสุด 5)</Label>
                <textarea id="extra" rows={3} className="rounded-md border bg-transparent px-3 py-2 text-sm" value={cfg.footer.extra_lines.join('\n')} onChange={(e) => setCfg((c) => ({ ...c, footer: { ...c.footer, extra_lines: e.target.value.split('\n').slice(0, 5) } }))} placeholder={'คืนสินค้าภายใน 7 วัน\nwww.example.com'} />
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => { setMsg(''); save.mutate(); }} disabled={save.isPending || !name.trim()}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} บันทึก
            </Button>
            <Button variant="outline" onClick={() => runPreview()}><RefreshCw className="size-4" /> รีเฟรชตัวอย่าง</Button>
            {msg && <Msg ok={msg.startsWith('✅') || msg.startsWith('🗑️')}>{msg}</Msg>}
          </div>
        </div>

        {/* ── live preview ── */}
        <Card className="lg:sticky lg:top-4 h-fit">
          <CardHeader><CardTitle className="text-base">ตัวอย่าง (Live preview)</CardTitle></CardHeader>
          <CardContent>
            <iframe title="preview" srcDoc={previewHtml} className="h-[560px] w-full rounded border bg-white" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
