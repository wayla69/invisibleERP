'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { getToken, clearToken } from '@/lib/api';
import { useMe, hasPerm } from '@/lib/auth';

const NAV = [
  { label: '📊 Dashboard', href: '/dashboard', perms: ['dashboard', 'exec'] },
  { label: '🛒 POS', href: '/pos', perms: ['pos', 'order_mgt'] },
  { label: '📦 Inventory', href: '/inventory', perms: ['warehouse', 'dashboard', 'planner'] },
  { label: '🏢 Suppliers', href: '/inventory/suppliers', perms: ['procurement', 'warehouse'] },
  { label: '🧾 Purchase Orders', href: '/inventory/purchase-orders', perms: ['procurement'] },
  { label: '🛒 Procurement', href: '/procurement', perms: ['procurement'] },
  { label: '💵 Finance', href: '/finance', perms: ['ar', 'creditors', 'exec'] },
];

export default function InternalLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();

  useEffect(() => {
    if (typeof window !== 'undefined' && !getToken()) router.replace('/login');
  }, [router]);

  const items = NAV.filter((n) => hasPerm(me.data, ...n.perms));

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '230px 1fr', minHeight: '100vh' }}>
      <aside className="sidebar" style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
        <h3 style={{ marginTop: 4 }}>Invisible ERP V2</h3>
        {me.data && (
          <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 8 }}>
            👤 {me.data.username} · {me.data.role}
            {me.data.customer_name ? ` · ${me.data.customer_name}` : ''}
          </div>
        )}
        <nav style={{ display: 'grid', gap: 4, marginTop: 8, flex: 1 }}>
          {(items.length ? items : NAV).map((n) => (
            <Link key={n.href} href={n.href} style={{ fontWeight: pathname === n.href ? 700 : 400, background: pathname === n.href ? 'rgba(255,255,255,.15)' : undefined }}>
              {n.label}
            </Link>
          ))}
        </nav>
        <button
          className="btn"
          style={{ marginTop: 16 }}
          onClick={() => { clearToken(); router.replace('/login'); }}
        >
          🚪 ออกจากระบบ
        </button>
      </aside>
      <main style={{ padding: 24 }}>{children}</main>
    </div>
  );
}
