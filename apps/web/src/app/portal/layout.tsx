'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { getToken, clearToken } from '@/lib/api';
import { useMe } from '@/lib/auth';

const NAV = [
  { label: '🏠 หน้าหลัก', href: '/portal/dashboard' },
  { label: '🏪 ขายสินค้า (POS)', href: '/portal/pos' },
  { label: '📦 สต๊อก & สั่งซื้อ', href: '/portal/inventory' },
  { label: '📮 ติดตามคำสั่งซื้อ', href: '/portal/track' },
  { label: '⭐ แต้มสะสม', href: '/portal/loyalty' },
  { label: '💼 ธุรกิจของฉัน', href: '/portal/my' },
];

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();

  useEffect(() => {
    if (typeof window !== 'undefined' && !getToken()) router.replace('/login');
  }, [router]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '230px 1fr', minHeight: '100vh' }}>
      <aside className="sidebar" style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
        <h3 style={{ marginTop: 4 }}>🛍️ ร้านค้าของฉัน</h3>
        {me.data && <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 8 }}>👤 {me.data.username}{me.data.customer_name ? ` · ${me.data.customer_name}` : ''}</div>}
        <nav style={{ display: 'grid', gap: 4, marginTop: 8, flex: 1 }}>
          {NAV.map((nNav) => (
            <Link key={nNav.href} href={nNav.href} style={{ fontWeight: pathname === nNav.href ? 700 : 400, background: pathname === nNav.href ? 'rgba(255,255,255,.15)' : undefined }}>
              {nNav.label}
            </Link>
          ))}
        </nav>
        <button className="btn" style={{ marginTop: 16 }} onClick={() => { clearToken(); router.replace('/login'); }}>🚪 ออกจากระบบ</button>
      </aside>
      <main style={{ padding: 24 }}>{children}</main>
    </div>
  );
}
