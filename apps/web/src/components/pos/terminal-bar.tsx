'use client';

import { useState } from 'react';
import { Cable, MonitorSmartphone, Plug, PlugZap, Printer, Settings, Wifi, WifiOff } from 'lucide-react';
import { useOnline } from '@/lib/offline';
import { useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { notifyError, notifySuccess } from '@/lib/notify';
import type { Terminal } from '@/lib/terminal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

/** Compact device/status strip for the register, with a settings sheet to pair the printer + drawer + CFD. */
export function TerminalBar({ terminal: tm }: { terminal: Terminal }) {
  const { t } = useLang();
  const online = useOnline();
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) notifySuccess(ok); }
    catch (e) { notifyError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
      <Badge variant="secondary" className="gap-1"><MonitorSmartphone className="size-3.5" /> {t('px.term_device', { code: tm.terminalCode })}</Badge>

      <span className={cn('inline-flex items-center gap-1.5 font-medium', tm.printerConnected ? 'text-success' : 'text-muted-foreground')}>
        <Printer className="size-4" /> {tm.printerConnected ? t('px.term_printer_ready') : tm.printMethod === 'usb' ? t('px.term_printer_none') : t('px.term_printer_driver')}
      </span>

      <span className={cn('inline-flex items-center gap-1.5', online ? 'text-success' : 'text-amber-600')}>
        {online ? <Wifi className="size-4" /> : <WifiOff className="size-4" />} {online ? t('px.term_online') : t('px.term_offline')}
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        <a href={tm.displayUrl} target="_blank" rel="noreferrer">
          <Button variant="outline" size="sm"><MonitorSmartphone className="size-4" /> {t('px.term_cfd')}</Button>
        </a>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm"><Settings className="size-4" /> {t('px.term_settings')}</Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2"><Cable className="size-4" /> {t('px.term_settings_title')}</SheetTitle>
            </SheetHeader>

            <div className="space-y-5 p-4">
              {/* terminal code */}
              <div className="grid gap-1.5">
                <Label htmlFor="tm-code">{t('px.term_code_label')}</Label>
                <Input id="tm-code" value={tm.terminalCode} onChange={(e) => tm.setTerminalCode(e.target.value)} placeholder="T01" />
                <p className="text-xs text-muted-foreground">{t('px.term_code_hint')}</p>
              </div>

              {/* printer */}
              <div className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center gap-2 text-sm font-medium"><Printer className="size-4" /> {t('px.term_printer_section')}</div>

                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => tm.setPrintMethod('browser')}
                    className={cn('rounded-md border px-2 py-2 text-xs', tm.printMethod === 'browser' ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-accent')}
                  >
                    {t('px.term_pm_browser')}
                    <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">{t('px.term_pm_browser_note')}</span>
                  </button>
                  <button
                    type="button"
                    disabled={!tm.webUsbSupported}
                    onClick={() => tm.setPrintMethod('usb')}
                    className={cn('rounded-md border px-2 py-2 text-xs disabled:opacity-50', tm.printMethod === 'usb' ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-accent')}
                  >
                    {t('px.term_pm_usb')}
                    <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">{t('px.term_pm_usb_note')}</span>
                  </button>
                </div>

                {tm.webUsbSupported ? (
                  tm.printerConnected ? (
                    <Button variant="outline" size="sm" className="w-full" disabled={busy} onClick={() => run(tm.disconnectPrinter, t('px.term_printer_disconnected'))}>
                      <Plug className="size-4" /> {t('px.term_disconnect_printer')}
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" className="w-full" disabled={busy || tm.connecting} onClick={() => run(tm.connectPrinter, t('px.term_printer_connected'))}>
                      <PlugZap className="size-4" /> {tm.connecting ? t('px.term_connecting') : t('px.term_connect_usb')}
                    </Button>
                  )
                ) : (
                  <p className="text-xs text-muted-foreground">{t('px.term_no_webusb')}</p>
                )}

                <Button variant="secondary" size="sm" className="w-full" disabled={busy} onClick={() => run(tm.testPrint, t('px.term_testprint_sent'))}>
                  {t('px.term_testprint')}
                </Button>
              </div>

              {/* drawer */}
              <div className="space-y-2 rounded-lg border p-3">
                <div className="text-sm font-medium">{t('px.term_drawer')}</div>
                <p className="text-xs text-muted-foreground">{t('px.term_drawer_hint')}</p>
                <Button variant="secondary" size="sm" className="w-full" disabled={busy} onClick={() => run(() => tm.kickDrawer({ reason: 'no_sale' }), t('px.term_drawer_test_ok'))}>
                  {t('px.term_drawer_test')}
                </Button>
              </div>

              {/* customer display */}
              <div className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center gap-2 text-sm font-medium"><MonitorSmartphone className="size-4" /> {t('px.term_cfd_section')}</div>
                <p className="text-xs text-muted-foreground">{t('px.term_cfd_hint')}</p>
                <a href={tm.displayUrl} target="_blank" rel="noreferrer">
                  <Button variant="secondary" size="sm" className="w-full">{t('px.term_open_cfd', { code: tm.terminalCode })}</Button>
                </a>
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
