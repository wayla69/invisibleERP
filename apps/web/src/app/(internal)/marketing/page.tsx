'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, Kpi, DataTable, Badge, StateView } from '@/components/ui';
import { Tabs, Msg } from '@/components/tabs';
import { baht, thaiDate } from '@/lib/format';

const g = (r: any, ...keys: string[]) => { for (const k of keys) if (r[k] != null) return r[k]; return ''; };

function Campaigns() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['mk-camp'], queryFn: () => api('/api/marketing/campaigns') });
  const [name, setName] = useState(''); const [type, setType] = useState('Popup');
  const add = useMutation({ mutationFn: () => api('/api/marketing/campaigns', { method: 'POST', body: JSON.stringify({ campaign_name: name, campaign_type: type }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['mk-camp'] }); setName(''); } });
  const toggle = useMutation({ mutationFn: (id: number) => api(`/api/marketing/campaigns/${id}/toggle`, { method: 'PATCH' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['mk-camp'] }) });
  return (
    <>
      <Card style={{ maxWidth: 560, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" placeholder="ชื่อแคมเปญ" value={name} onChange={(e) => setName(e.target.value)} />
          <select className="input" style={{ maxWidth: 130 }} value={type} onChange={(e) => setType(e.target.value)}><option>Popup</option><option>Ticker</option><option>Banner</option></select>
          <button className="btn" disabled={!name || add.isPending} onClick={() => add.mutate()}>สร้าง</button>
        </div>
        {add.error && <Msg>{(add.error as Error).message}</Msg>}
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.campaigns} columns={[
          { key: 'name', label: 'ชื่อ', render: (r) => g(r, 'campaignName', 'campaign_name') },
          { key: 'type', label: 'ประเภท', render: (r) => g(r, 'campaignType', 'campaign_type') },
          { key: 'dates', label: 'ช่วงเวลา', render: (r) => `${thaiDate(g(r, 'startDate', 'start_date'))} – ${thaiDate(g(r, 'endDate', 'end_date'))}` },
          { key: 'active', label: 'สถานะ', render: (r) => <Badge value={(r.active ? 'Active' : 'Paused')} /> },
          { key: 'x', label: '', render: (r) => <button className="btn" style={{ padding: '4px 10px', background: '#64748b' }} onClick={() => toggle.mutate(r.id)}>เปิด/ปิด</button> },
        ]} />}
      </StateView>
    </>
  );
}

function Segments() {
  const q = useQuery<any>({ queryKey: ['mk-seg'], queryFn: () => api('/api/marketing/segments') });
  const d = q.data;
  return (
    <StateView q={q}>
      {d && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            {Object.entries(d.counts ?? {}).map(([k, v]) => <Kpi key={k} label={k} value={String(v)} />)}
          </div>
          <DataTable rows={d.segments ?? []} columns={[
            { key: 'name', label: 'ลูกค้า', render: (r) => g(r, 'tenant', 'customer_name', 'code') },
            { key: 'segment', label: 'กลุ่ม', render: (r) => <Badge value={g(r, 'segment')} /> },
            { key: 'spend', label: 'ยอดซื้อ', render: (r) => baht(g(r, 'spend', 'total_spend')) },
            { key: 'orders', label: 'จำนวนครั้ง', render: (r) => g(r, 'order_count', 'orders') },
            { key: 'days', label: 'ซื้อล่าสุด (วันก่อน)', render: (r) => g(r, 'days_since', 'days') },
          ]} />
        </>
      )}
    </StateView>
  );
}

function Promotions() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['mk-promo'], queryFn: () => api('/api/promotions') });
  const [name, setName] = useState(''); const [type, setType] = useState('Discount %'); const [pct, setPct] = useState(10);
  const add = useMutation({ mutationFn: () => api('/api/promotions', { method: 'POST', body: JSON.stringify({ promo_name: name, promo_type: type, discount_pct: Number(pct) }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['mk-promo'] }); setName(''); } });
  const toggle = useMutation({ mutationFn: (id: number) => api(`/api/promotions/${id}/toggle`, { method: 'PATCH' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['mk-promo'] }) });
  return (
    <>
      <Card style={{ maxWidth: 600, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" placeholder="ชื่อโปรโมชั่น" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" style={{ maxWidth: 90 }} type="number" value={pct} onChange={(e) => setPct(+e.target.value)} />
          <span className="label" style={{ alignSelf: 'center' }}>% ลด</span>
          <button className="btn" disabled={!name || add.isPending} onClick={() => add.mutate()}>สร้าง</button>
        </div>
      </Card>
      <StateView q={q}>
        {q.data && <DataTable rows={q.data.promotions} columns={[
          { key: 'name', label: 'ชื่อ', render: (r) => g(r, 'promoName', 'promo_name') },
          { key: 'type', label: 'ประเภท', render: (r) => g(r, 'promoType', 'promo_type') },
          { key: 'active', label: 'สถานะ', render: (r) => <Badge value={(g(r, 'active', 'isActive') ? 'Active' : 'Paused')} /> },
          { key: 'x', label: '', render: (r) => <button className="btn" style={{ padding: '4px 10px', background: '#64748b' }} onClick={() => toggle.mutate(g(r, 'id'))}>เปิด/ปิด</button> },
        ]} />}
      </StateView>
    </>
  );
}

export default function Marketing() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>📣 การตลาด</h1>
      <Tabs tabs={[
        { key: 'c', label: 'แคมเปญ', content: <Campaigns /> },
        { key: 's', label: 'กลุ่มลูกค้า (RFM)', content: <Segments /> },
        { key: 'p', label: 'โปรโมชั่น', content: <Promotions /> },
      ]} />
    </div>
  );
}
