import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { Inter, Sarabun } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { LanguageProvider } from '@/lib/i18n';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { PwaRegister } from '@/components/pwa-register';
import { ChunkReloadGuard } from '@/components/chunk-reload-guard';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const sarabun = Sarabun({
  subsets: ['thai', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sarabun',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Invisible ERP V2',
  description: 'Oshinei Enterprise ERP — V2',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Invisible ERP', statusBarStyle: 'default' },
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  // Long ID/figure strings (Sale_No, tax IDs) must not become tappable "phone numbers" on iOS Safari.
  formatDetection: { telephone: false },
};

// E3 (Phase 28) — PWA chrome + mobile viewport. `viewportFit: 'cover'` lets the installed app draw
// edge-to-edge on notched iPhone / gesture-bar Android; the app shell then pads itself back in with
// env(safe-area-inset-*) (a no-op in a normal browser, where the insets are 0). `initialScale` is set
// but pinch-zoom is intentionally left enabled (no maximumScale) — disabling it is an a11y anti-pattern.
export const viewport: Viewport = {
  themeColor: '#1E3C72',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Per-request CSP nonce set by middleware (M-1). next-themes' anti-flash inline <script> must carry it or
  // the strict production CSP would block it; passing `nonce` here stamps it onto that script.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="th" suppressHydrationWarning className={`${inter.variable} ${sarabun.variable}`}>
      <body className="font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange nonce={nonce}>
          <ChunkReloadGuard />
          <PwaRegister />
          {/* App-wide locale context: signed-in users resolve user → tenant → th from the server; on
              signed-out/public pages (login, diner QR, tracking) the localStorage cache alone applies,
              so the device's last explicit choice still holds. */}
          <Providers><LanguageProvider>{children}</LanguageProvider></Providers>
          <Toaster richColors position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
