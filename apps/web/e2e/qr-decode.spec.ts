import { test, expect, type Page } from '@playwright/test';
import { MultiFormatWriter, BarcodeFormat } from '@zxing/library';

/**
 * Camera decode pipeline — the first REAL decode coverage (UAT-INV-069/069b were manual-only).
 * Drives the actual scanner stack end-to-end: QrScanButton (components/qr-scanner.tsx) → frame loop →
 * lib/qr-decode (native BarcodeDetector, else the lazy @zxing/browser fallback) → parseQrPayload/
 * scanCodeId scan-to-fill on /stocktake.
 *
 * The "camera" is a stubbed getUserMedia returning a canvas.captureStream() whose canvas carries a code
 * rendered from a bit matrix we generate in Node (@zxing/library's QR writer; EAN-13 encoded by hand —
 * this zxing build ships no 1D writer, and a wrong hand-encoding simply fails to decode, so the test is
 * self-verifying). No binary fixtures, fully deterministic.
 *
 * Headless Linux Chromium has no shape-detection backend, so the native-BarcodeDetector variants probe
 * and skip there; the @zxing fallback variants are the unconditional CI coverage (and iOS Safari/Firefox
 * take exactly that path in production).
 */

const ITEM_PAYLOAD = 'ITEM_ID:A|DESC:Apple|UOM:EA';
const DEEPLINK = 'https://erp.example/q?d=' + encodeURIComponent('ITEM_ID:B7|DESC:Bean|UOM:KG');
const EAN13_12DIGITS = '885000123456'; // check digit computed below

const ME = { username: 'warehouse', role: 'Admin', customer_name: 'AMBER', permissions: [] };
const STOCK = {
  items: [
    { Item_ID: 'A', Item_Description: 'Apple', UOM: 'EA', AV_QTY: 5 },
    { Item_ID: 'B7', Item_Description: 'Bean', UOM: 'KG', AV_QTY: 2 },
  ],
};

/** QR bit matrix via @zxing/library's writer → rows of '1'/'0' strings. */
function qrMatrix(text: string): string[] {
  const m = new MultiFormatWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, new Map());
  const rows: string[] = [];
  for (let y = 0; y < m.getHeight(); y++) {
    let r = '';
    for (let x = 0; x < m.getWidth(); x++) r += m.get(x, y) ? '1' : '0';
    rows.push(r);
  }
  return rows;
}

/** EAN-13 module row (95 modules) encoded by hand — L/G/R pattern tables per the GS1 spec. */
function ean13Row(digits12: string): { row: string; code: string } {
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const G = L.map((p) => p.split('').map((b) => (b === '1' ? '0' : '1')).reverse().join(''));
  const R = L.map((p) => p.split('').map((b) => (b === '1' ? '0' : '1')).join(''));
  const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  const ds = digits12.split('').map(Number);
  const sum = ds.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  const check = (10 - (sum % 10)) % 10;
  const all = [...ds, check];
  const parity = PARITY[all[0]!]!;
  let row = '101';
  for (let i = 1; i <= 6; i++) row += (parity[i - 1] === 'L' ? L : G)[all[i]!]!;
  row += '01010';
  for (let i = 7; i <= 12; i++) row += R[all[i]!]!;
  row += '101';
  return { row, code: all.join('') };
}

/** Route-mock the internal app + replace getUserMedia with a canvas stream rendering `rows`. */
async function boot(page: Page, rows: string[], opts: { moduleSize: number; barHeight?: number; dropNativeDetector?: boolean }) {
  await page.addInitScript(() => { document.cookie = 'ierp_csrf=e2e; path=/'; });
  if (opts.dropNativeDetector) {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'BarcodeDetector', { value: undefined, configurable: true });
    });
  }
  await page.addInitScript(
    ({ rows, moduleSize, barHeight }: { rows: string[]; moduleSize: number; barHeight: number }) => {
      const QUIET = 12 * moduleSize;
      const w = rows[0]!.length * moduleSize + QUIET * 2;
      const h = (rows.length === 1 ? barHeight : rows.length * moduleSize) + QUIET * 2;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d')!;
      const draw = () => {
        g.fillStyle = '#fff';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#000';
        rows.forEach((row, y) => {
          for (let x = 0; x < row.length; x++) {
            if (row[x] === '1') {
              g.fillRect(QUIET + x * moduleSize, QUIET + y * moduleSize, moduleSize, rows.length === 1 ? barHeight : moduleSize);
            }
          }
        });
      };
      draw();
      // Keep repainting so captureStream keeps emitting frames (a never-changing canvas may deliver
      // only the first frame, and the scanner reads frames continuously).
      setInterval(draw, 100);
      const fake = async () => canvas.captureStream(15);
      if (!navigator.mediaDevices) {
        Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
      }
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: fake, configurable: true });
    },
    { rows, moduleSize: opts.moduleSize, barHeight: opts.barHeight ?? 160 },
  );
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/modules/effective')) return json({ modules: [], disabled: [] });
    if (url.includes('/api/user-prefs')) return json({ favourites: [], nav: {} });
    if (url.includes('/api/inventory/stock')) return json(STOCK);
    return json({});
  });
}

/** Open /stocktake (hydration-gated on the stock fetch — mantra #16) and run one scan. */
async function scanOnStocktake(page: Page) {
  const stockLoaded = page.waitForResponse((r) => r.url().includes('/api/inventory/stock'));
  await page.goto('/stocktake');
  await stockLoaded;
  await page.getByRole('button', { name: 'สแกน QR' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function hasNativeDetector(page: Page): Promise<boolean> {
  await page.goto('/login');
  return page.evaluate(() => 'BarcodeDetector' in window && typeof (window as any).BarcodeDetector === 'function');
}

test('zxing fallback: scans an item QR tag into the stocktake form', async ({ page }) => {
  await boot(page, qrMatrix(ITEM_PAYLOAD), { moduleSize: 10, dropNativeDetector: true });
  await scanOnStocktake(page);

  // Decoded payload lands verbatim in the scan box; scanCodeId fills the item select; dialog auto-closes.
  await expect(page.locator('#st-scan')).toHaveValue(ITEM_PAYLOAD, { timeout: 15_000 });
  await expect(page.locator('#st-item')).toHaveValue('A');
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('zxing fallback: unwraps a /q?d= deep-link QR to its item id', async ({ page }) => {
  await boot(page, qrMatrix(DEEPLINK), { moduleSize: 8, dropNativeDetector: true });
  await scanOnStocktake(page);

  await expect(page.locator('#st-scan')).toHaveValue(DEEPLINK, { timeout: 15_000 });
  await expect(page.locator('#st-item')).toHaveValue('B7'); // unwrapQrUrl → parseQrPayload
});

test('zxing fallback: reads a retail EAN-13 barcode as a bare item code', async ({ page }) => {
  const { row, code } = ean13Row(EAN13_12DIGITS);
  await boot(page, [row], { moduleSize: 4, barHeight: 200, dropNativeDetector: true });
  await scanOnStocktake(page);

  await expect(page.locator('#st-scan')).toHaveValue(code, { timeout: 15_000 });
});

test('native BarcodeDetector: scans an item QR tag (skips where unsupported)', async ({ page }) => {
  await boot(page, qrMatrix(ITEM_PAYLOAD), { moduleSize: 10 });
  test.skip(!(await hasNativeDetector(page)), 'BarcodeDetector not available in this Chromium build');
  await scanOnStocktake(page);

  await expect(page.locator('#st-scan')).toHaveValue(ITEM_PAYLOAD, { timeout: 15_000 });
  await expect(page.locator('#st-item')).toHaveValue('A');
});
