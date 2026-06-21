'use client';

import { useState, type ReactNode } from 'react';

export function Tabs({ tabs }: { tabs: { key: string; label: string; content: ReactNode }[] }) {
  const [active, setActive] = useState(tabs[0]?.key);
  return (
    <div>
      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid var(--border)', marginBottom: 16, flexWrap: 'wrap' }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActive(t.key)}
            style={{
              border: 0, background: 'transparent', padding: '8px 14px', cursor: 'pointer', fontSize: 15,
              fontWeight: active === t.key ? 700 : 400, color: active === t.key ? 'var(--navy)' : 'var(--muted)',
              borderBottom: active === t.key ? '2px solid var(--navy)' : '2px solid transparent', marginBottom: -2,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.find((t) => t.key === active)?.content}
    </div>
  );
}

export function Msg({ ok, children }: { ok?: boolean; children: ReactNode }) {
  if (!children) return null;
  return (
    <p style={{ color: ok ? '#059669' : 'var(--ruby)', fontSize: 14, margin: '8px 0' }}>{children}</p>
  );
}
