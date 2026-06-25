import type { Metadata, Viewport } from 'next';
import { Inter, Sarabun } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { PwaRegister } from '@/components/pwa-register';

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" suppressHydrationWarning className={`${inter.variable} ${sarabun.variable}`}>
      <body className="font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
          <PwaRegister />
          <Providers>{children}</Providers>
          <Toaster richColors position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
