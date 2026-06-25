/**
 * B3 — POS peripheral bridge (browser-side).
 *
 * Drives common POS hardware directly from the web app via WebUSB / WebSerial:
 *   • ESC/POS receipt printer  • cash-drawer kick  • barcode scanner (keyboard-wedge).
 * The API already renders ESC/POS bytes (apps/api/src/modules/pos/receipt-format.ts); this module
 * is the client transport that sends those bytes to the device and pulses the drawer.
 *
 * ⚠️ Scaffold: typechecked but NOT runtime-verified here (needs a browser + physical device + the
 * user granting WebUSB/WebSerial access). WebUSB/WebSerial aren't in the standard TS DOM lib, so we
 * feature-detect via `navigator` and keep the device handles loosely typed.
 */

// ESC/POS control sequences.
const ESC = 0x1b;
const GS = 0x1d;
// Initialise/reset printer: ESC @.
const INIT = new Uint8Array([ESC, 0x40]);
// Feed a few lines so the slip clears the cutter before the cut.
const FEED = new Uint8Array([0x0a, 0x0a, 0x0a]);
// Drawer kick: ESC p m t1 t2 — pulse the solenoid on pin 0 (most cash drawers).
const DRAWER_KICK = new Uint8Array([ESC, 0x70, 0x00, 0x19, 0xfa]);
// Full cut: GS V 66 0.
const CUT = new Uint8Array([GS, 0x56, 66, 0]);

export function isWebUsbSupported(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}
export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/** Prompt the user to pick a USB printer (must be called from a user gesture). Returns an opaque handle. */
export async function connectUsbPrinter(): Promise<any> {
  if (!isWebUsbSupported()) throw new Error('WebUSB not supported in this browser');
  const usb = (navigator as any).usb;
  const device = await usb.requestDevice({ filters: [{ classCode: 7 }] }); // class 7 = printer
  await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  await device.claimInterface(0);
  return device;
}

function usbOutEndpoint(device: any): number {
  const iface = device.configuration.interfaces[0].alternate;
  const ep = iface.endpoints.find((e: any) => e.direction === 'out');
  return ep?.endpointNumber ?? 1;
}

/** Send raw bytes (e.g. the API's base64-decoded ESC/POS receipt) to a connected USB printer. */
export async function printBytes(device: any, bytes: Uint8Array): Promise<void> {
  await device.transferOut(usbOutEndpoint(device), bytes);
}

/** Decode a base64 ESC/POS payload (as returned by the receipt API) and print it, then cut. */
export async function printReceiptBase64(device: any, b64: string, cut = true): Promise<void> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  await printBytes(device, bytes);
  if (cut) await printBytes(device, CUT);
}

/**
 * Print a raw ESC/POS receipt body (the bytes the API's `?format=escpos` endpoint returns): reset the
 * printer, send the body, feed, then cut. Used by the POS terminal bridge for direct-USB receipts.
 * Note: the API body is plain text — Thai glyphs render only if the printer's active codepage supports
 * them; for guaranteed Thai, the register prints the HTML slip through the OS driver instead.
 */
export async function printReceiptRaw(device: any, bytes: Uint8Array, cut = true): Promise<void> {
  await printBytes(device, INIT);
  await printBytes(device, bytes);
  if (cut) { await printBytes(device, FEED); await printBytes(device, CUT); }
}

/** Pulse the cash drawer connected to the printer's drawer port. */
export async function kickDrawer(device: any): Promise<void> {
  await printBytes(device, DRAWER_KICK);
}

/**
 * Barcode scanners act as keyboards: they "type" the code fast and end with Enter. This listens for
 * that burst (configurable inter-key gap) and calls back with the scanned code, ignoring normal typing
 * in <input>/<textarea>. Returns an unsubscribe fn. Call once from the POS shell.
 */
export function onBarcodeScan(onScan: (code: string) => void, opts?: { maxGapMs?: number; minLength?: number }): () => void {
  const maxGap = opts?.maxGapMs ?? 50;
  const minLen = opts?.minLength ?? 4;
  let buf = '';
  let last = 0;
  const handler = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const now = Date.now();
    if (now - last > maxGap) buf = '';
    last = now;
    if (e.key === 'Enter') { if (buf.length >= minLen) onScan(buf); buf = ''; return; }
    if (e.key.length === 1) buf += e.key;
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
