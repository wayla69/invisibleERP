'use client';

/**
 * POS terminal bridge — the glue between the register UI and the cashier's hardware.
 *
 * Wraps the low-level WebUSB/WebSerial transport in `peripherals.ts` and the server peripheral endpoints
 * (`/api/peripherals/*`, `/api/pos/sales/:saleNo/receipt`) behind a small React hook + helpers, and
 * persists per-device settings (terminal code, preferred print method, "reconnect my printer") in
 * localStorage so a terminal remembers its setup across reloads.
 *
 * Print strategy (Windows + USB, Thai receipts):
 *   • 'browser' (default) — print the 80mm HTML slip through the OS print driver (Sarabun font →
 *     guaranteed Thai). Works with any Windows-installed thermal printer, no WebUSB grant needed.
 *   • 'usb' — push raw ESC/POS bytes straight to a WebUSB-connected printer (fast, no dialog; Thai
 *     depends on the printer's codepage).
 * The cash drawer is kicked over WebUSB when a printer is connected (codepage-agnostic), and every kick
 * is also recorded server-side for the Z-report reconciliation audit.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, api } from './api';
import { ts } from './i18n-static';
import { connectUsbPrinter, printReceiptRaw, kickDrawer as pulseDrawer, isWebUsbSupported } from './peripherals';

const TERMINAL_KEY = 'ierp_pos_terminal';
const PRINT_METHOD_KEY = 'ierp_pos_print_method';
const PRINTER_WANTED_KEY = 'ierp_pos_printer_wanted';

export type PrintMethod = 'browser' | 'usb';

export interface DisplayLine { name: string; qty?: number; amount?: number }
export interface DisplayState {
  message?: string;
  lines?: DisplayLine[];
  subtotal?: number;
  total?: number;
  amount_due?: number;
  change?: number;
}

const canStore = () => typeof window !== 'undefined' && !!window.localStorage;
const lsGet = (k: string, def: string) => (canStore() ? localStorage.getItem(k) ?? def : def);
const lsSet = (k: string, v: string) => { if (canStore()) localStorage.setItem(k, v); };

/** Stored terminal code (device id used for the customer display + drawer audit). Defaults to T01. */
export function getTerminalCode(): string { return lsGet(TERMINAL_KEY, 'T01'); }

// ── receipt printing ──────────────────────────────────────────────────────────────────────────────

/** Print the 80mm HTML slip via the OS driver: fetch (cookie-auth) → hidden iframe → window.print(). */
async function printHtmlSlip(saleNo: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/pos/sales/${encodeURIComponent(saleNo)}/receipt?format=html`, { credentials: 'include' });
  if (!res.ok) throw new Error(ts('err.receipt_load'));
  const html = await res.text();
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  // Sandbox the receipt (security review M-6): a slip needs NO scripting, so block script execution as
  // defense-in-depth should an unescaped field ever reach this document. `allow-same-origin` keeps the
  // parent able to drive `win.print()`; `allow-modals` permits the print dialog; the ABSENCE of
  // `allow-scripts` makes any <script> in the slip inert. `srcdoc` replaces the document.write sink.
  iframe.setAttribute('sandbox', 'allow-same-origin allow-modals');
  Object.assign(iframe.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  iframe.srcdoc = html;
  document.body.appendChild(iframe);
  await new Promise<void>((resolve) => {
    iframe.addEventListener('load', () => resolve(), { once: true });
    setTimeout(resolve, 1500); // fallback if the load event doesn't fire
  });
  const win = iframe.contentWindow;
  if (!win) { iframe.remove(); throw new Error(ts('err.print_window')); }
  // Give the webfont/layout a moment, then print and clean up.
  await new Promise((r) => setTimeout(r, 250));
  win.focus(); win.print();
  setTimeout(() => iframe.remove(), 1500);
}

/** Push raw ESC/POS bytes to a connected USB printer. */
async function printUsbSlip(device: any, saleNo: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/pos/sales/${encodeURIComponent(saleNo)}/receipt?format=escpos`, { credentials: 'include' });
  if (!res.ok) throw new Error(ts('err.receipt_load'));
  const bytes = new Uint8Array(await res.arrayBuffer());
  await printReceiptRaw(device, bytes);
}

/** Open the receipt (HTML) in a new tab — manual fallback if auto-print is blocked. */
export function openReceipt(saleNo: string, format: 'html' | 'pdf' = 'html'): void {
  window.open(`${API_BASE}/api/pos/sales/${encodeURIComponent(saleNo)}/receipt?format=${format}`, '_blank', 'noopener');
}

// ── silent reconnect of a previously-granted USB printer ────────────────────────────────────────────

async function reopenGrantedPrinter(): Promise<any | null> {
  if (!isWebUsbSupported()) return null;
  try {
    const usb = (navigator as any).usb;
    const devices: any[] = await usb.getDevices();
    const device = devices[0];
    if (!device) return null;
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    await device.claimInterface(0);
    return device;
  } catch {
    return null; // not granted yet / busy — user can connect manually
  }
}

// ── the hook ────────────────────────────────────────────────────────────────────────────────────────

export interface Terminal {
  terminalCode: string;
  setTerminalCode: (code: string) => void;
  printMethod: PrintMethod;
  setPrintMethod: (m: PrintMethod) => void;
  webUsbSupported: boolean;
  printerConnected: boolean;
  connecting: boolean;
  connectPrinter: () => Promise<void>;
  disconnectPrinter: () => Promise<void>;
  /** Print a receipt for a settled sale. Uses the chosen method, falling back to a new-tab open. */
  printReceipt: (saleNo: string) => Promise<void>;
  /** Print a short hardware self-test (no sale needed). */
  testPrint: () => Promise<void>;
  /** Pulse the cash drawer (USB if connected) and record the open server-side for the Z-report audit. */
  kickDrawer: (opts?: { saleNo?: string; amount?: number; reason?: 'sale' | 'no_sale' }) => Promise<void>;
  /** Update the customer-facing display for this terminal (best-effort, fire-and-forget). */
  pushDisplay: (state: DisplayState) => void;
  /** URL of the customer-facing display page for this terminal. */
  displayUrl: string;
}

export function useTerminal(): Terminal {
  const [terminalCode, setTerminalCodeState] = useState('T01');
  const [printMethod, setPrintMethodState] = useState<PrintMethod>('browser');
  const [printerConnected, setPrinterConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const deviceRef = useRef<any>(null);
  const webUsbSupported = typeof navigator !== 'undefined' && 'usb' in navigator;

  // Hydrate persisted settings + silently reconnect a previously-granted printer.
  useEffect(() => {
    setTerminalCodeState(getTerminalCode());
    setPrintMethodState((lsGet(PRINT_METHOD_KEY, 'browser') as PrintMethod) === 'usb' ? 'usb' : 'browser');
    if (lsGet(PRINTER_WANTED_KEY, '') === '1') {
      void reopenGrantedPrinter().then((d) => { if (d) { deviceRef.current = d; setPrinterConnected(true); } });
    }
  }, []);

  const setTerminalCode = useCallback((code: string) => {
    const clean = code.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'T01';
    lsSet(TERMINAL_KEY, clean);
    setTerminalCodeState(clean);
  }, []);

  const setPrintMethod = useCallback((m: PrintMethod) => { lsSet(PRINT_METHOD_KEY, m); setPrintMethodState(m); }, []);

  const connectPrinter = useCallback(async () => {
    setConnecting(true);
    try {
      const device = await connectUsbPrinter();
      deviceRef.current = device;
      setPrinterConnected(true);
      lsSet(PRINTER_WANTED_KEY, '1');
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnectPrinter = useCallback(async () => {
    const d = deviceRef.current;
    deviceRef.current = null;
    setPrinterConnected(false);
    lsSet(PRINTER_WANTED_KEY, '0');
    try { await d?.close?.(); } catch { /* already gone */ }
  }, []);

  const printReceipt = useCallback(async (saleNo: string) => {
    if (printMethod === 'usb' && deviceRef.current) {
      await printUsbSlip(deviceRef.current, saleNo);
      return;
    }
    await printHtmlSlip(saleNo);
  }, [printMethod]);

  const testPrint = useCallback(async () => {
    if (printMethod === 'usb' && deviceRef.current) {
      const text = new TextEncoder().encode('*** POS TEST ***\nInvisible ERP\n' + new Date().toLocaleString() + '\n\n\n');
      await printReceiptRaw(deviceRef.current, text);
      return;
    }
    const w = window.open('', '_blank', 'width=380,height=500');
    if (!w) throw new Error(ts('err.print_window_popup'));
    w.document.write('<pre style="font-family:Sarabun,monospace;font-size:13px">*** POS TEST ***\nInvisible ERP\nทดสอบพิมพ์ภาษาไทย\n' + new Date().toLocaleString('th-TH') + '</pre>');
    w.document.close(); w.focus(); w.print();
    setTimeout(() => w.close(), 1500);
  }, [printMethod]);

  const kickDrawer = useCallback(async (opts?: { saleNo?: string; amount?: number; reason?: 'sale' | 'no_sale' }) => {
    // Physical pulse over USB (drawer is wired to the printer's RJ11 port).
    if (deviceRef.current) { try { await pulseDrawer(deviceRef.current); } catch { /* fall through to audit */ } }
    // Always record the open for the Z-report reconciliation audit.
    await api('/api/peripherals/drawer/kick', {
      method: 'POST',
      body: JSON.stringify({ terminal: getTerminalCode(), reason: opts?.reason ?? 'sale', sale_no: opts?.saleNo, amount: opts?.amount }),
    }).catch(() => { /* audit best-effort — never block the sale */ });
  }, []);

  const pushDisplay = useCallback((state: DisplayState) => {
    void api(`/api/peripherals/display/${encodeURIComponent(getTerminalCode())}`, {
      method: 'POST',
      body: JSON.stringify(state),
    }).catch(() => { /* CFD is best-effort */ });
  }, []);

  return {
    terminalCode,
    setTerminalCode,
    printMethod,
    setPrintMethod,
    webUsbSupported,
    printerConnected,
    connecting,
    connectPrinter,
    disconnectPrinter,
    printReceipt,
    testPrint,
    kickDrawer,
    pushDisplay,
    displayUrl: `/display/${encodeURIComponent(terminalCode)}`,
  };
}
