'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus, Send, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { num } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { Msg } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Line { item_id: string; theoretical_use?: number; actual_use: number; reason?: string }

export default function PortalVariancePage() {
  const { t } = useLang();
  const [shift, setShift] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [f, setF] = useState({ item_id: '', theoretical_use: '', actual_use: '', reason: '' });
  const [msg, setMsg] = useState('');

  const submit = useMutation({
    mutationFn: () => api('/api/portal/variance', { method: 'POST', body: JSON.stringify({ shift: shift || undefined, items: lines }) }),
    onSuccess: () => { setMsg(t('pt.var.submit_ok', { n: lines.length })); setLines([]); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  function add() {
    if (!f.item_id || f.actual_use === '') return;
    setLines((ls) => [...ls.filter((l) => l.item_id !== f.item_id), {
      item_id: f.item_id, actual_use: Number(f.actual_use),
      theoretical_use: f.theoretical_use ? Number(f.theoretical_use) : undefined, reason: f.reason || undefined,
    }]);
    setF({ item_id: '', theoretical_use: '', actual_use: '', reason: '' });
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t('pt.var.title')} description={t('pt.var.desc')} />
      <Card className="gap-3 p-5">
        <div className="grid gap-1.5 max-w-[220px]"><Label>{t('pt.var.shift')}</Label><Input value={shift} onChange={(e) => setShift(e.target.value)} placeholder={t('pt.var.shift_ph')} /></div>
        <div className="grid gap-2 sm:grid-cols-4">
          <Input placeholder={t('pt.var.ph_item')} value={f.item_id} onChange={(e) => setF({ ...f, item_id: e.target.value })} />
          <Input type="number" placeholder={t('pt.var.ph_theory')} value={f.theoretical_use} onChange={(e) => setF({ ...f, theoretical_use: e.target.value })} />
          <Input type="number" placeholder={t('pt.var.ph_actual')} value={f.actual_use} onChange={(e) => setF({ ...f, actual_use: e.target.value })} />
          <Input placeholder={t('pt.var.ph_reason')} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </div>
        <Button className="w-fit" disabled={!f.item_id || f.actual_use === ''} onClick={add}><Plus className="size-4" /> {t('pt.add')}</Button>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      {lines.length > 0 && (
        <Card className="gap-3 p-5">
          <DataTable
            rows={lines.map((l) => ({ ...l, diff: l.actual_use - (l.theoretical_use ?? 0) }))}
            columns={[
              { key: 'item_id', label: t('pt.var.col_item') },
              { key: 'theoretical_use', label: t('pt.var.ph_theory'), align: 'right', render: (r: any) => num(r.theoretical_use ?? 0) },
              { key: 'actual_use', label: t('pt.var.ph_actual'), align: 'right', render: (r: any) => num(r.actual_use) },
              { key: 'diff', label: t('pt.var.col_diff'), align: 'right', render: (r: any) => num(r.diff) },
              { key: 'act', label: '', render: (r: any) => <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((x) => x.item_id !== r.item_id))}><Trash2 className="size-4" /></Button> },
            ]}
          />
          <Button disabled={submit.isPending} onClick={() => submit.mutate()}><Send className="size-4" /> {t('pt.var.submit_n', { n: lines.length })}</Button>
        </Card>
      )}
    </div>
  );
}
