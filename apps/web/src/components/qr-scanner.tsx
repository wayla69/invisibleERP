// Camera QR / barcode scanner.
// (No 'use client' directive: this component is only ever imported by client pages — the assets QR tab,
//  mobile-scan, stocktake, goods-issue — so it already lives in their client bundle. Adding the directive
//  would trip the use-client ratchet, tools/ci/check-use-client.mjs, for no benefit.)
//
// Decoding is delegated to lib/qr-decode (native BarcodeDetector, else a lazy @zxing/browser fallback) so
// it works on iOS Safari / Firefox too and reads 1D barcodes as well as our QR tags. The decoded text
// (raw `ITEM_ID:…` payload, a plain product barcode, or a `/q?d=…` deep-link URL) is handed to `onScan`
// verbatim — the caller's parseQrPayload/scanCodeId unwraps it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Flashlight, ScanLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createFrameDecoder, cameraScanSupported } from '@/lib/qr-decode';
import { useLang } from '@/lib/i18n';

// `torch`/`zoom` are real, widely-shipped camera constraints/capabilities that the DOM lib types don't include yet.
interface TorchConstraintSet extends MediaTrackConstraintSet { torch?: boolean }
interface ZoomConstraintSet extends MediaTrackConstraintSet { zoom?: number }
type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };
type ZoomCapabilities = MediaTrackCapabilities & { zoom?: { min: number; max: number; step?: number } };

// Short confirmation beep + haptic tick on a successful read (best-effort; silently no-ops if unavailable).
function feedback() {
  try {
    const AC = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (AC) {
      const ac = new AC();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.05;
      osc.connect(gain); gain.connect(ac.destination);
      osc.start();
      osc.stop(ac.currentTime + 0.08);
      setTimeout(() => ac.close().catch(() => {}), 200);
    }
  } catch { /* no audio */ }
  try { navigator.vibrate?.(60); } catch { /* no haptics */ }
}

export function QrScanButton({
  onScan,
  size = 'icon',
  variant = 'outline',
  label,
  continuous = false,
}: {
  onScan: (text: string) => void;
  size?: 'icon' | 'sm' | 'default';
  variant?: 'outline' | 'secondary' | 'default';
  label?: string;
  /** Keep scanning after a hit (rattle through many items). Duplicate reads are debounced ~1.5s. */
  continuous?: boolean;
}) {
  const { t } = useLang();
  const [supported, setSupported] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [zoomCaps, setZoomCaps] = useState<{ min: number; max: number; step?: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [count, setCount] = useState(0);
  const [last, setLast] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const onScanRef = useRef(onScan);
  const lastHitRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });

  useEffect(() => { onScanRef.current = onScan; });
  useEffect(() => { setSupported(cameraScanSupported()); }, []);

  const stop = useCallback(() => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const close = useCallback(() => { stop(); setOpen(false); }, [stop]);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] as TorchConstraintSet[] });
      setTorchOn(next);
    } catch { /* torch not controllable */ }
  }, [torchOn]);

  const applyZoom = useCallback(async (next: number) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    setZoom(next);
    try {
      await track.applyConstraints({ advanced: [{ zoom: next }] as ZoomConstraintSet[] });
    } catch { /* zoom not controllable */ }
  }, []);

  // Camera + decode loop while the dialog is open; torn down on close/unmount.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null); setCount(0); setLast(''); setTorchOn(false); setHasTorch(false); setZoomCaps(null);
    lastHitRef.current = { code: '', at: 0 };

    (async () => {
      let decoder;
      try {
        decoder = await createFrameDecoder();
      } catch {
        setError(t('qr.scan_camera_error'));
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (e: unknown) {
        const name = (e as { name?: string })?.name;
        setError(name === 'NotAllowedError' ? t('qr.scan_denied') : name === 'NotFoundError' ? t('qr.scan_no_camera') : t('qr.scan_camera_error'));
        return;
      }
      if (cancelled) { stream.getTracks().forEach((tr) => tr.stop()); return; }
      streamRef.current = stream;
      try {
        const caps = stream.getVideoTracks()[0]?.getCapabilities?.() as (TorchCapabilities & ZoomCapabilities) | undefined;
        setHasTorch(!!caps?.torch);
        if (caps?.zoom && typeof caps.zoom.min === 'number' && typeof caps.zoom.max === 'number' && caps.zoom.max > caps.zoom.min) {
          setZoomCaps({ min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step });
          setZoom(caps.zoom.min);
        }
      } catch { /* capabilities unsupported */ }

      const v = videoRef.current;
      if (!v) return;
      v.srcObject = stream;
      await v.play().catch(() => { /* autoplay guard — the dialog open was a user gesture */ });

      const canvas = canvasRef.current ?? document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      let misses = 0; // consecutive frames with no code at 640px — every ~15th miss retries at full resolution

      const tick = async () => {
        if (cancelled || !videoRef.current || !ctx) return;
        const vid = videoRef.current;
        if (vid.readyState >= 2 && vid.videoWidth) {
          // Downscale the longer side to ~640px — plenty for decoding, much faster for the JS fallback.
          // Small/far codes can be unresolvable at 640px, so after ~15 straight misses decode one
          // full-resolution frame (capped at 1920) before falling back to the fast path.
          const fullRes = misses >= 15;
          const target = fullRes ? 1920 : 640;
          const scale = Math.min(1, target / Math.max(vid.videoWidth, vid.videoHeight));
          canvas.width = Math.round(vid.videoWidth * scale);
          canvas.height = Math.round(vid.videoHeight * scale);
          ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
          const raw = await decoder.decode(canvas);
          misses = raw ? 0 : fullRes ? 0 : misses + 1;
          if (raw && !cancelled) {
            const now = Date.now();
            const dup = raw === lastHitRef.current.code && now - lastHitRef.current.at < 1500;
            if (!dup) {
              lastHitRef.current = { code: raw, at: now };
              feedback();
              onScanRef.current(raw);
              if (continuous) {
                setCount((c) => c + 1);
                setLast(raw);
              } else {
                stop(); setOpen(false); return;
              }
            }
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    })();

    return () => { cancelled = true; stop(); };
  }, [open, stop, t, continuous]);

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
          <div className="relative overflow-hidden rounded-md border bg-black">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline />
            <canvas ref={canvasRef} className="hidden" />
            {hasTorch && (
              <Button type="button" size="icon" variant={torchOn ? 'default' : 'secondary'} className="absolute bottom-2 right-2 opacity-90" onClick={toggleTorch} title={t('qr.scan_torch')} aria-label={t('qr.scan_torch')}>
                <Flashlight className="size-4" />
              </Button>
            )}
            {zoomCaps && (
              <input
                type="range"
                className="absolute bottom-3 left-2 w-28 opacity-90 sm:w-36"
                min={zoomCaps.min}
                max={zoomCaps.max}
                step={zoomCaps.step ?? (zoomCaps.max - zoomCaps.min) / 20}
                value={zoom}
                onChange={(e) => applyZoom(Number(e.target.value))}
                title={t('qr.scan_zoom')}
                aria-label={t('qr.scan_zoom')}
              />
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {continuous && !error && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t('qr.scan_count', { n: count })}{last ? ` · ${last.slice(0, 24)}` : ''}</span>
              <Button type="button" size="sm" onClick={close}>{t('qr.scan_done')}</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
