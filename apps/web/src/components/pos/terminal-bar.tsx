'use client';

import { useState } from 'react';
import { Cable, MonitorSmartphone, Plug, PlugZap, Printer, Settings, Wifi, WifiOff } from 'lucide-react';
import { useOnline } from '@/lib/offline';
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
      <Badge variant="secondary" className="gap-1"><MonitorSmartphone className="size-3.5" /> เครื่อง {tm.terminalCode}</Badge>

      <span className={cn('inline-flex items-center gap-1.5 font-medium', tm.printerConnected ? 'text-success' : 'text-muted-foreground')}>
        <Printer className="size-4" /> {tm.printerConnected ? 'เครื่องพิมพ์พร้อม' : tm.printMethod === 'usb' ? 'ยังไม่ต่อเครื่องพิมพ์' : 'พิมพ์ผ่านไดรเวอร์'}
      </span>

      <span className={cn('inline-flex items-center gap-1.5', online ? 'text-success' : 'text-amber-600')}>
        {online ? <Wifi className="size-4" /> : <WifiOff className="size-4" />} {online ? 'ออนไลน์' : 'ออฟไลน์'}
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        <a href={tm.displayUrl} target="_blank" rel="noreferrer">
          <Button variant="outline" size="sm"><MonitorSmartphone className="size-4" /> จอลูกค้า ↗</Button>
        </a>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm"><Settings className="size-4" /> ตั้งค่าเครื่อง</Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2"><Cable className="size-4" /> ตั้งค่าเครื่อง POS (Terminal)</SheetTitle>
            </SheetHeader>

            <div className="space-y-5 p-4">
              {/* terminal code */}
              <div className="grid gap-1.5">
                <Label htmlFor="tm-code">รหัสเครื่อง (Terminal)</Label>
                <Input id="tm-code" value={tm.terminalCode} onChange={(e) => tm.setTerminalCode(e.target.value)} placeholder="T01" />
                <p className="text-xs text-muted-foreground">ใช้จับคู่จอลูกค้าและบันทึกการเปิดลิ้นชักของเครื่องนี้</p>
              </div>

              {/* printer */}
              <div className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center gap-2 text-sm font-medium"><Printer className="size-4" /> เครื่องพิมพ์ใบเสร็จ</div>

                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => tm.setPrintMethod('browser')}
                    className={cn('rounded-md border px-2 py-2 text-xs', tm.printMethod === 'browser' ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-accent')}
                  >
                    ผ่านไดรเวอร์ (แนะนำ)
                    <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">ภาษาไทยชัดเจน</span>
                  </button>
                  <button
                    type="button"
                    disabled={!tm.webUsbSupported}
                    onClick={() => tm.setPrintMethod('usb')}
                    className={cn('rounded-md border px-2 py-2 text-xs disabled:opacity-50', tm.printMethod === 'usb' ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-accent')}
                  >
                    ตรง USB (ESC/POS)
                    <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">เร็ว · ไทยขึ้นกับเครื่อง</span>
                  </button>
                </div>

                {tm.webUsbSupported ? (
                  tm.printerConnected ? (
                    <Button variant="outline" size="sm" className="w-full" disabled={busy} onClick={() => run(tm.disconnectPrinter, 'ถอดเครื่องพิมพ์แล้ว')}>
                      <Plug className="size-4" /> ถอดเครื่องพิมพ์
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" className="w-full" disabled={busy || tm.connecting} onClick={() => run(tm.connectPrinter, 'เชื่อมต่อเครื่องพิมพ์แล้ว')}>
                      <PlugZap className="size-4" /> {tm.connecting ? 'กำลังเชื่อมต่อ…' : 'ต่อเครื่องพิมพ์ USB'}
                    </Button>
                  )
                ) : (
                  <p className="text-xs text-muted-foreground">เบราว์เซอร์นี้ไม่รองรับ WebUSB — ใช้พิมพ์ผ่านไดรเวอร์ (เปิดได้บน Chrome/Edge บนคอมพิวเตอร์)</p>
                )}

                <Button variant="secondary" size="sm" className="w-full" disabled={busy} onClick={() => run(tm.testPrint, 'ส่งงานทดสอบพิมพ์แล้ว')}>
                  ทดสอบพิมพ์
                </Button>
              </div>

              {/* drawer */}
              <div className="space-y-2 rounded-lg border p-3">
                <div className="text-sm font-medium">ลิ้นชักเก็บเงิน</div>
                <p className="text-xs text-muted-foreground">เปิดอัตโนมัติเมื่อรับเงินสด (ต้องต่อเครื่องพิมพ์ USB ที่เสียบลิ้นชัก)</p>
                <Button variant="secondary" size="sm" className="w-full" disabled={busy} onClick={() => run(() => tm.kickDrawer({ reason: 'no_sale' }), 'เปิดลิ้นชัก (ทดสอบ)')}>
                  ทดสอบเปิดลิ้นชัก
                </Button>
              </div>

              {/* customer display */}
              <div className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center gap-2 text-sm font-medium"><MonitorSmartphone className="size-4" /> จอลูกค้า</div>
                <p className="text-xs text-muted-foreground">เปิดหน้านี้บนจอที่หันไปทางลูกค้า — รายการ ยอดรวม และเงินทอนจะอัปเดตตามการขาย</p>
                <a href={tm.displayUrl} target="_blank" rel="noreferrer">
                  <Button variant="secondary" size="sm" className="w-full">เปิดจอลูกค้า ({tm.terminalCode}) ↗</Button>
                </a>
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
