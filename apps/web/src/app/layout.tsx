import type { Metadata } from 'next';
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
};

// E3 (Phase 28) — PWA theme color for the installed app's chrome.
export const viewport = { themeColor: '#1E3C72' };

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
