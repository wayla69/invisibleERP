// Multi-format code decoder used by the camera scanner.
//   • Native `BarcodeDetector` (Chromium desktop / Android / WebView) — fast, GPU-backed, QR + many 1D.
//   • Fallback: @zxing/browser (pure JS, lazy-loaded so it stays out of the main bundle) — so scanning
//     ALSO works on iOS Safari / Firefox, and 1D barcodes (EAN/UPC/Code-128/Code-39/ITF) decode
//     everywhere, not just where BarcodeDetector exists.
// Both paths decode a single already-drawn <canvas> frame, so the scanner owns the camera/torch itself.

export interface FrameDecoder {
  decode(canvas: HTMLCanvasElement): Promise<string | null>;
}

// Formats we care about: our own QR tags + the common retail/warehouse 1D symbologies.
const NATIVE_FORMATS = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'];

function nativeCtor(): (new (opts?: { formats?: string[] }) => { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }) & { getSupportedFormats?: () => Promise<string[]> } | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { BarcodeDetector?: any }).BarcodeDetector ?? null;
}

/** Camera scanning is possible whenever there's a camera to read — decoding itself always works
 *  (native detector, else the lazy JS fallback). */
export function cameraScanSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export async function createFrameDecoder(): Promise<FrameDecoder> {
  const Ctor = nativeCtor();
  if (Ctor) {
    let formats = NATIVE_FORMATS;
    try {
      const supported = await Ctor.getSupportedFormats?.();
      if (Array.isArray(supported) && supported.length) {
        const usable = NATIVE_FORMATS.filter((f) => supported.includes(f));
        if (usable.length) formats = usable;
      }
    } catch {
      /* keep defaults */
    }
    const det = new Ctor({ formats });
    return {
      async decode(canvas) {
        try {
          const hits = await det.detect(canvas);
          return hits.find((h) => h.rawValue)?.rawValue ?? null;
        } catch {
          return null;
        }
      },
    };
  }
  // Lazy-load the JS fallback only when the native detector is absent.
  const { BrowserMultiFormatReader } = await import('@zxing/browser');
  const reader = new BrowserMultiFormatReader();
  return {
    async decode(canvas) {
      try {
        const res = reader.decodeFromCanvas(canvas);
        const text = res?.getText?.();
        return text || null;
      } catch {
        // NotFoundException on a frame with no code — keep scanning.
        return null;
      }
    },
  };
}
