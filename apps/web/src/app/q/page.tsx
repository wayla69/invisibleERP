// Public deep-link resolver for a scanned asset/inventory QR — a SERVER component (no client JS).
// A printed QR (when WEB_BASE_URL is set) encodes `<base>/q?d=<payload>`, so a phone's native camera
// opens this page. We parse the payload, resolve it against the API server-side (cookie-forwarded via
// serverApi — null when there's no session or the item is unknown), and render identity + one-tap links
// into the workspace. Kept server-first per docs/28 §4 (the use-client ratchet); it needs no interactivity
// beyond links, so there is no client island.
import Link from 'next/link';
import { Boxes, Landmark, PackageSearch, ScanLine } from 'lucide-react';
import { serverApi } from '@/lib/server-api';
import { parseQrPayload } from '@/lib/qr';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

// cookies() (inside serverApi) already opts this route out of prerendering; explicit for clarity.
export const dynamic = 'force-dynamic';

interface Resolved {
  kind: 'item' | 'asset' | 'unknown';
  id: string;
  description?: string | null;
  uom?: string | null;
  price?: string | null;
  category?: string | null;
  location?: string | null;
  status?: string | null;
}

function firstParam(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? '') : '';
}

export default async function QrResolverPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Deep links are built as `/q?d=<payload>` (see qrLink). Read only the non-sensitive `d` param.
  const code = firstParam(sp.d);
  const parsed = parseQrPayload(code);
  // Live lookup, server-side. serverApi returns null with no session / on error → we fall back to the
  // payload the tag itself carries (DESC/LOC) plus a login link.
  const resolved = code ? await serverApi<Resolved>(`/api/scan/sessions/resolve?d=${encodeURIComponent(code)}`) : null;

  const kind: 'item' | 'asset' | 'unknown' =
    resolved && resolved.kind !== 'unknown' ? resolved.kind : parsed.ASSET_ID ? 'asset' : parsed.ITEM_ID ? 'item' : 'unknown';
  const id = resolved?.id || parsed.ITEM_ID || parsed.ASSET_ID || code;
  const desc = resolved?.description ?? parsed.DESC ?? '';
  const loginHref = `/login?next=${encodeURIComponent('/q?d=' + code)}`;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6">
      <Card className="w-full gap-4 p-6">
        <div className="flex items-center gap-2 text-muted-foreground">
          <ScanLine className="size-5" />
          <span className="text-sm font-medium">ผลการสแกน QR · Scanned QR</span>
        </div>

        {!code ? (
          <p className="text-sm text-muted-foreground">ไม่พบข้อมูลในลิงก์ QR นี้ · No data in this QR link</p>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-md bg-muted p-2">
                {kind === 'asset' ? <Landmark className="size-6" /> : <Boxes className="size-6" />}
              </div>
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {kind === 'asset' ? 'สินทรัพย์ · Asset' : kind === 'item' ? 'สินค้า · Item' : 'รหัสที่สแกน · Scanned code'}
                </div>
                <div className="truncate text-lg font-semibold">{id}</div>
                {desc && <div className="truncate text-sm text-muted-foreground">{desc}</div>}
              </div>
            </div>

            {resolved && resolved.kind !== 'unknown' ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                {resolved.kind === 'asset' && resolved.location != null && (
                  <><dt className="text-muted-foreground">ตำแหน่ง · Location</dt><dd>{resolved.location || '—'}</dd></>
                )}
                {resolved.kind === 'asset' && resolved.status != null && (
                  <><dt className="text-muted-foreground">สถานะ · Status</dt><dd>{resolved.status}</dd></>
                )}
                {resolved.kind === 'item' && resolved.uom != null && (
                  <><dt className="text-muted-foreground">หน่วย · Unit</dt><dd>{resolved.uom || '—'}</dd></>
                )}
                {resolved.kind === 'item' && resolved.price != null && (
                  <><dt className="text-muted-foreground">ราคา · Price</dt><dd>{resolved.price}</dd></>
                )}
              </dl>
            ) : null}

            {/* Actions — deep links into the right workspace. Navigating there prompts login if needed. */}
            <div className="flex flex-wrap gap-2">
              {kind === 'asset' ? (
                <Button asChild><Link href="/assets"><Landmark className="size-4" /> เปิดทะเบียนสินทรัพย์ · Open assets</Link></Button>
              ) : (
                <>
                  <Button asChild><Link href="/mobile-scan"><ScanLine className="size-4" /> สแกนมือถือ · Mobile scan</Link></Button>
                  <Button asChild variant="outline"><Link href="/goods-issue"><PackageSearch className="size-4" /> สต๊อก · Stock</Link></Button>
                </>
              )}
              {!resolved && <Button asChild variant="ghost"><Link href={loginHref}>เข้าสู่ระบบ · Log in</Link></Button>}
            </div>

            <code className="block break-all rounded bg-muted px-2 py-1 text-center text-xs text-muted-foreground">{code}</code>
          </>
        )}
      </Card>
    </main>
  );
}
