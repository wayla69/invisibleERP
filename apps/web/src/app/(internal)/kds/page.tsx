'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { StateView } from '@/components/ui';

type KdsItem = { item_id: number; order_no: string; table_label: string | null; name: string; qty: number; modifiers: { label: string }[]; notes: string | null; kds_status: string; elapsed_min: number; prep_min: number };
type Station = { station_id: number; station_code: string; station_name: string; items: KdsItem[] };

const NEXT: Record<string, { action: string; label: string }> = {
  queued: { action: 'start', label: 'เริ่มทำ' },
  preparing: { action: 'ready', label: 'เสร็จแล้ว' },
  ready: { action: 'serve', label: 'เสิร์ฟแล้ว' },
};

export default function KdsPage() {
  const qc = useQueryClient();
  const feed = useQuery<{ stations: Station[] }>({ queryKey: ['kds'], queryFn: () => api('/api/restaurant/kds/feed'), refetchInterval: 3000 });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: number; action: string }) => api(`/api/restaurant/kds/items/${id}`, { method: 'PATCH', body: JSON.stringify({ action }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kds'] }),
  });

  const color = (el: number, prep: number) => (el < prep ? '#059669' : el < prep * 1.5 ? '#d97706' : 'var(--ruby)');

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>🍳 จอครัว (KDS)</h1>
      <p className="label" style={{ marginTop: -8 }}>อัปเดตอัตโนมัติทุก 3 วินาที · แตะการ์ดเพื่อเปลี่ยนสถานะ</p>
      <StateView q={feed}>
        {feed.data && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14, alignItems: 'start' }}>
            {feed.data.stations.length === 0 && <p className="label">ยังไม่มีออเดอร์เข้าครัว</p>}
            {feed.data.stations.map((st) => (
              <div key={st.station_id} className="card" style={{ padding: 12 }}>
                <h3 style={{ margin: '0 0 10px', color: 'var(--navy)' }}>{st.station_name} <span className="label">({st.items.length})</span></h3>
                <div style={{ display: 'grid', gap: 8 }}>
                  {st.items.map((it) => {
                    const nxt = NEXT[it.kds_status];
                    return (
                      <div key={it.item_id} style={{ border: `2px solid ${color(it.elapsed_min, it.prep_min)}`, borderRadius: 8, padding: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                          <strong>{it.qty}× {it.name}</strong>
                          <span style={{ color: color(it.elapsed_min, it.prep_min), fontWeight: 700 }}>{it.elapsed_min}′</span>
                        </div>
                        <div className="label" style={{ fontSize: 12 }}>{it.table_label ? `โต๊ะ ${it.table_label}` : 'กลับบ้าน'} · {it.order_no}</div>
                        {(it.modifiers?.length > 0 || it.notes) && (
                          <div style={{ fontSize: 12, color: '#b45309', marginTop: 2 }}>
                            {(it.modifiers ?? []).map((m) => m.label).join(', ')}{it.notes ? ` · ${it.notes}` : ''}
                          </div>
                        )}
                        {nxt && (
                          <button className="btn" style={{ width: '100%', marginTop: 6, padding: '6px' }} disabled={act.isPending} onClick={() => act.mutate({ id: it.item_id, action: nxt.action })}>
                            {nxt.label}
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {st.items.length === 0 && <span className="label" style={{ fontSize: 13 }}>— ว่าง —</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </StateView>
    </div>
  );
}
