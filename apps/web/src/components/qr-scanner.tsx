// Camera QR scanner — dependency-free, using the browser-native BarcodeDetector API
// (No 'use client' directive: this component is only ever imported by client pages — the assets QR tab,
//  mobile-scan, stocktake, goods-issue — so it already lives in their client bundle. Adding the directive
//  would trip the use-client ratchet, tools/ci/check-use-client.mjs, for no benefit.)
// (Chromium desktop/Android, Android WebView, Samsung Internet). When the API or a camera is
// unavailable (e.g. Firefox, older Safari, no getUserMedia) the button renders nothing, so the
// page's manual text input / hardware wedge-scanner path remains the fallback. The decoded text
// (raw `ITEM_ID:…` payload, or a `/q?d=…` deep-link URL) is handed to `onScan` verbatim — the
// caller's parseQrPayload/scanCodeId already unwraps both carriers.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ScanLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLang } from '@/lib/i18n';

interface DetectedBarcode { rawValue: string }
interface BarcodeDetectorLike { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> }
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

function getCtor(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null;
}

/** True when this browser can decode a QR from the camera (native BarcodeDetector + getUserMedia). */
export function qrScanSupported(): boolean {
  return getCtor() != null && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export function QrScanButton({
  onScan,
  size = 'icon',
  variant = 'outline',
  label,
}: {
  onScan: (text: string) => void;
  size?: 'icon' | 'sm' | 'default';
  variant?: 'outline' | 'secondary' | 'default';
  label?: string;
}) {
  const { t } = useLang();
  const [supported, setSupported] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const onScanRef = useRef(onScan);

  useEffect(() => { onScanRef.current = onScan; });
  useEffect(() => { setSupported(qrScanSupported()); }, []);

  const stop = useCallback(() => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const close = useCallback(() => { stop(); setOpen(false); }, [stop]);

  // Start the camera + decode loop while the dialog is open; tear everything down on close/unmount.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    const Ctor = getCtor();
    if (!Ctor) { setError(t('qr.scan_unsupported')); return; }
    const detector = new Ctor({ formats: ['qr_code'] });

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (cancelled) { stream.getTracks().forEach((tr) => tr.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play().catch(() => { /* autoplay guard — user gesture already opened the dialog */ });

        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            if (videoRef.current.readyState >= 2) {
              const hits = await detector.detect(videoRef.current);
              const raw = hits.find((h) => h.rawValue)?.rawValue;
              if (raw) { stop(); setOpen(false); onScanRef.current(raw); return; }
            }
          } catch { /* transient decode error — keep scanning */ }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e: unknown) {
        const name = (e as { name?: string })?.name;
        setError(name === 'NotAllowedError' ? t('qr.scan_denied') : t('qr.scan_camera_error'));
      }
    })();

    return () => { cancelled = true; stop(); };
  }, [open, stop, t]);

  useEffect(() => () => stop(), [stop]); // unmount safety

  if (!supported) return null;

  return (
    <>
      <Button type="button" variant={variant} size={size} onClick={() => setOpen(true)} title={t('qr.scan_button')} aria-label={t('qr.scan_button')}>
        <Camera className="size-4" />
        {size !== 'icon' ? <span>{label ?? t('qr.scan_button')}</span> : null}
      </Button>
      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ScanLine className="size-4" /> {t('qr.scan_title')}</DialogTitle>
            <DialogDescription>{t('qr.scan_hint')}</DialogDescription>
          </DialogHeader>
          <div className="overflow-hidden rounded-md border bg-black">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}
