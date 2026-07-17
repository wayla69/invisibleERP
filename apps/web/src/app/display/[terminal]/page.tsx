'use client';

import { useQuery } from '@tanstack/react-query';
import { use } from 'react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';

interface DisplayLine { name: string; qty?: number; amount?: number }
interface DisplayState { message?: string; lines?: DisplayLine[]; subtotal?: number; total?: number; amount_due?: number; change?: number }

// Customer-facing display (pole / second screen). Runs full-screen on the terminal's customer-facing
// monitor and polls the per-terminal state set by the POS. Auth uses the terminal's stored token.
export default function CustomerDisplayPage({ params }: { params: Promise<{ terminal: string }> }) {
  const { terminal } = use(params);
  const q = useQuery<{ terminal: string; state: DisplayState }>({
    queryKey: ['cfd', terminal],
    queryFn: () => api(`/api/peripherals/display/${encodeURIComponent(terminal)}`),
    refetchInterval: 2_000,
  });
  const s = q.data?.state ?? {};
  const lines = s.lines ?? [];
  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-white">
      <div className="flex items-center justify-between px-10 py-6">
        <div className="text-2xl font-semibold text-emerald-400">{s.message || 'ยินดีต้อนรับ / Welcome'}</div>
        <div className="text-sm text-slate-500">{terminal}</div>
      </div>
      <div className="flex-1 overflow-auto px-10">
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-3xl text-slate-600">ขอบคุณที่ใช้บริการ</div>
        ) : (
          <table className="w-full text-2xl">
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-b border-slate-800">
                  <td className="py-3">{l.name}</td>
                  <td className="py-3 text-center text-slate-400">{l.qty ?? ''}</td>
                  <td className="py-3 text-right tabular">{l.amount != null ? baht(l.amount) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="space-y-2 bg-slate-900 px-10 py-8">
        {s.subtotal != null && <Row label="ยอดรวม Subtotal" value={baht(s.subtotal)} muted />}
        <Row label="รวมสุทธิ Total" value={baht(s.total ?? 0)} big />
        {s.amount_due != null && <Row label="รับเงิน Received" value={baht(s.amount_due)} muted />}
        {s.change != null && <Row label="เงินทอน Change" value={baht(s.change)} big accent />}
      </div>
    </div>
  );
}

function Row({ label, value, big, muted, accent }: { label: string; value: string; big?: boolean; muted?: boolean; accent?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${big ? 'text-4xl font-bold' : 'text-xl'} ${muted ? 'text-slate-400' : ''} ${accent ? 'text-emerald-400' : ''}`}>
      <span>{label}</span>
      <span className="tabular">{value}</span>
    </div>
  );
}
