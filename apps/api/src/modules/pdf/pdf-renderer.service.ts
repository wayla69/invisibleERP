import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

// Reject if `p` doesn't settle within `ms`. Used to bound the in-process Chromium render so a hung
// page.setContent/page.pdf can't pin a request (and a worker slot) indefinitely — the remote-offload path
// already has its own fetch timeout. Exported for unit testing.
export async function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface PdfOptions {
  format?: 'A4';
  width?: string;            // e.g. '80mm' for a receipt slip (mutually exclusive with format)
  landscape?: boolean;
  printBackground?: boolean;
  margin?: { top?: string; bottom?: string; left?: string; right?: string };
}

// Centralised HTML→PDF renderer (perf / availability hardening).
//
// Before: four services each called `chromium.launch()` PER REQUEST — a full browser process spawned and
// torn down for every PDF, blocking the event loop and spiking memory (an OOM/latency risk under load).
//
// Now every PDF goes through one renderer with two strategies:
//   1. OFFLOAD (preferred for prod): if PDF_SERVICE_URL is set, POST the HTML to an external PDF
//      microservice and stream back the bytes — Chromium runs entirely OUTSIDE the API process.
//   2. POOLED IN-PROCESS (fallback): launch ONE Chromium lazily and reuse it (one page per render),
//      bounded by a small concurrency semaphore, instead of a launch per request.
// If both are unavailable the renderer returns null and the caller falls back to serving raw HTML
// (unchanged behaviour — Chromium is not present in CI, so callers must still degrade gracefully).
@Injectable()
export class PdfRenderer implements OnModuleDestroy {
  private readonly log = new Logger(PdfRenderer.name);
  private browser: any = null;
  private browserPromise: Promise<any> | null = null;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private get maxConcurrency(): number { return Math.max(1, Number(process.env.PDF_MAX_CONCURRENCY ?? 2)); }

  async render(html: string, opts: PdfOptions = {}): Promise<Buffer | null> {
    const url = (process.env.PDF_SERVICE_URL ?? '').trim();
    if (url) {
      try { return await this.renderRemote(url, html, opts); }
      catch (e) { this.log.warn(`PDF service offload failed (${(e as Error)?.message ?? e}) — falling back to in-process`); }
    }
    return this.renderLocal(html, opts);
  }

  // ── Strategy 1: external PDF microservice ──────────────────────────────────
  // Contract: POST { html, options } → 200 application/pdf (the rendered bytes). Keeps Chromium off the API.
  private async renderRemote(url: string, html: string, opts: PdfOptions): Promise<Buffer> {
    const timeoutMs = Number(process.env.PDF_SERVICE_TIMEOUT_MS ?? 30000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ html, options: opts }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`PDF service HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      if (!ab.byteLength) throw new Error('PDF service returned empty body');
      return Buffer.from(ab);
    } finally { clearTimeout(timer); }
  }

  // ── Strategy 2: pooled in-process Chromium ─────────────────────────────────
  private async renderLocal(html: string, opts: PdfOptions): Promise<Buffer | null> {
    await this.acquire();
    let page: any = null;
    const timeoutMs = Number(process.env.PDF_RENDER_TIMEOUT_MS ?? 30000);
    try {
      const browser = await this.getBrowser();
      page = await browser.newPage();
      // Bound each render: a hung networkidle wait or page.pdf throws → caught below → browser reset →
      // null returned → caller serves raw HTML (graceful degrade), instead of blocking the request forever.
      await withTimeout(page.setContent(html, { waitUntil: 'networkidle' }), timeoutMs, 'PDF setContent');
      const pdf = await withTimeout(page.pdf(this.toPlaywrightOpts(opts)), timeoutMs, 'PDF render');
      return Buffer.from(pdf);
    } catch (err) {
      this.log.warn(`Chromium unavailable, falling back to HTML: ${(err as Error)?.message ?? err}`);
      await this.resetBrowser(); // a crashed/disconnected browser must not poison later renders
      return null;
    } finally {
      if (page) { try { await page.close(); } catch { /* ignore */ } }
      this.release();
    }
  }

  private toPlaywrightOpts(opts: PdfOptions): Record<string, unknown> {
    const o: Record<string, unknown> = { printBackground: opts.printBackground ?? true };
    if (opts.width) o.width = opts.width; else o.format = opts.format ?? 'A4';
    if (opts.landscape) o.landscape = true;
    if (opts.margin) o.margin = opts.margin;
    return o;
  }

  private async getBrowser(): Promise<any> {
    if (this.browser) return this.browser;
    if (!this.browserPromise) {
      this.browserPromise = (async () => {
        const { chromium } = await import('playwright-core');
        return chromium.launch({ headless: true });
      })();
    }
    try { this.browser = await this.browserPromise; }
    finally { this.browserPromise = null; }
    return this.browser;
  }

  private async resetBrowser(): Promise<void> {
    const b = this.browser; this.browser = null; this.browserPromise = null;
    if (b) { try { await b.close(); } catch { /* ignore */ } }
  }

  // tiny concurrency semaphore so a burst of PDF requests can't open unbounded Chromium pages
  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) { this.active++; return Promise.resolve(); }
    return new Promise<void>((resolve) => this.waiters.push(() => { this.active++; resolve(); }));
  }
  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  async onModuleDestroy(): Promise<void> { await this.resetBrowser(); }
}
