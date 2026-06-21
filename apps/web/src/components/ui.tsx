'use client';

import type { ReactNode } from 'react';

export function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return <div className="card" style={style}>{children}</div>;
}

export function Kpi({ label, value, accent }: { label: string; value: ReactNode; accent?: string }) {
  return (
    <div className="card" style={{ minWidth: 160 }}>
      <div className="label">{label}</div>
      <strong style={{ fontSize: 22, color: accent }}>{value}</strong>
    </div>
  );
}

const BADGE_COLORS: Record<string, string> = {
  Pending: '#fbbf24', Processing: '#60a5fa', Shipped: '#a78bfa', Completed: '#34d399',
  Claimed: '#f87171', Cancelled: '#9ca3af', Paid: '#34d399', Partial: '#fbbf24', Unpaid: '#f87171',
  Open: '#60a5fa', Closed: '#34d399', Received: '#a78bfa', Approved: '#34d399', Draft: '#9ca3af',
};
export function Badge({ value }: { value: string }) {
  const bg = BADGE_COLORS[value] ?? '#cbd5e1';
  return <span style={{ background: bg, color: '#1a1a1a', padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{value}</span>;
}

export function StateView({ q, children }: { q: { isLoading: boolean; error: unknown }; children: ReactNode }) {
  if (q.isLoading) return <p className="label">กำลังโหลด…</p>;
  if (q.error) return <Card style={{ color: 'var(--ruby)' }}>เกิดข้อผิดพลาด: {String((q.error as Error)?.message ?? q.error)}</Card>;
  return <>{children}</>;
}

export function DataTable<T extends Record<string, any>>({
  rows, columns,
}: {
  rows: T[];
  columns: { key: string; label: string; render?: (row: T) => ReactNode }[];
}) {
  return (
    <Card>
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="label">ไม่มีข้อมูล</td></tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i}>{columns.map((c) => <td key={c.key}>{c.render ? c.render(row) : String(row[c.key] ?? '')}</td>)}</tr>
            ))
          )}
        </tbody>
      </table>
    </Card>
  );
}
