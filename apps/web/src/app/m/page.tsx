'use client';

// Loyalty MEMBER self-service app (consumer-facing, mobile-first). Standalone surface at /m — NOT the staff
// shell. Auth is phone-OTP (POST /api/member/auth/*) which mints a member token delivered as a server-set
// httpOnly cookie (the JWT is NOT readable from JS — XSS can't steal it), paired with a readable double-submit
// CSRF token (`ierp_csrf`) echoed in X-CSRF-Token on mutations. The member only ever sees/acts on themselves
// (the API derives the member from the cookie token — there is no member_id input).
import { useState, useEffect, useCallback, useRef } from 'react';
import { Gift, Trophy, Users, Star, LogOut, Sparkles, Ticket, Loader2, Disc3, Handshake, ReceiptText, Upload, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useLang } from '@/lib/i18n';
import { currentLang } from '@/lib/i18n-static';
import { LanguageToggle } from '@/components/language-toggle';
import { num, baht, thaiDate } from '@/lib/format';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
const CSRF_COOKIE = 'ierp_csrf';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// CSRF double-submit header on mutating requests — mirrors the staff lib/api.ts client.
function csrfHeader(method?: string): Record<string, string> {
  if (!MUTATING.has((method ?? 'GET').toUpperCase())) return {};
  const t = readCookie(CSRF_COOKIE);
  return t ? { 'X-CSRF-Token': t } : {};
}

// All member calls ride the httpOnly auth cookie (credentials: 'include'); no token is held in JS.
async function mapi<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...csrfHeader(init.method), ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body?.error ?? {};
    const msg = currentLang() === 'th' ? err.messageTh ?? err.message : err.message ?? err.messageTh;
    throw new Error(msg ?? `HTTP ${res.status}`);
  }
  return body as T;
}

const TIER_TONE: Record<string, string> = { Bronze: 'from-amber-700 to-amber-500', Silver: 'from-slate-400 to-slate-300', Gold: 'from-yellow-500 to-amber-400', Platinum: 'from-indigo-500 to-violet-400' };

export default function MemberApp() {
  // null = still probing the session; true/false once known. The auth JWT is httpOnly and unreadable, so we
  // confirm a live member session by probing /api/member/me rather than reading a token from localStorage.
  const [authed, setAuthed] = useState<boolean | null>(null);
  // G1 (docs/45, control MKT-13): staff mint a QR pointing at /m?clink=<token> for a channel order. Read
  // it client-side only (SSR has no window) — the null initial value avoids a hydration mismatch.
  const [clinkToken, setClinkToken] = useState<string | null>(null);
  useEffect(() => { setClinkToken(new URLSearchParams(window.location.search).get('clink')); }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!readCookie(CSRF_COOKIE)) { if (!cancelled) setAuthed(false); return; } // no session cookie at all
      try { await mapi('/api/member/me'); if (!cancelled) setAuthed(true); }
      catch { if (!cancelled) setAuthed(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  const onLogout = useCallback(async () => {
    try { await mapi('/api/member/auth/logout', { method: 'POST' }); } catch { /* clear regardless */ }
    setAuthed(false);
  }, []);

  if (authed === null) return null;
  return (
    <div className="mx-auto min-h-screen max-w-md bg-muted/30 px-4 py-6">
      <div className="mb-2 flex justify-end"><LanguageToggle /></div>
      {clinkToken
        ? <ChannelLink token={clinkToken} authed={authed} onAuthed={() => setAuthed(true)} onLogout={onLogout} />
        : authed ? <Home onLogout={onLogout} on401={() => setAuthed(false)} /> : <Login onAuthed={() => setAuthed(true)} />}
    </div>
  );
}

// ── Channel-to-member identity linking (docs/45 G1, control MKT-13) ─────────
// GET is @Public() so the platform/order_count preview shows BEFORE login; the actual link (POST) requires
// a member session, and always carries a REQUIRED explicit marketing_opt_in choice (never pre-selected —
// this is a consent decision, not a default). Ref hashes only, never raw PII (channel-customer-refs.service.ts).
function ChannelLink({ token, authed, onAuthed, onLogout }: { token: string; authed: boolean; onAuthed: () => void; onLogout: () => void }) {
  const { t } = useLang();
  const [info, setInfo] = useState<{ platform: string; order_count: number; linked: boolean } | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [optIn, setOptIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try { const r = await mapi<{ platform: string; order_count: number; linked: boolean }>(`/api/member/channel-link/${encodeURIComponent(token)}`); if (!cancelled) setInfo(r); }
      catch (e: any) { if (!cancelled) setLoadErr(e.message); }
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (loadErr) {
    return (
      <div className="flex min-h-[80vh] flex-col items-center justify-center gap-2 px-4 text-center">
        <p className="text-sm text-destructive">{loadErr}</p>
        <p className="text-xs text-muted-foreground">{t('mb.link_expired')}</p>
      </div>
    );
  }
  if (!info) return <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;

  if (info.linked || done) {
    return (
      <div className="flex min-h-[80vh] flex-col items-center justify-center gap-3 px-4 text-center">
        <ShieldCheck className="size-10 text-success" />
        <p className="text-base font-semibold">{t('mb.linked_done', { platform: info.platform })}</p>
        <Button onClick={() => { window.location.href = '/m'; }}>{t('mb.go_member')}</Button>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl bg-primary/10 p-4 text-center">
          <p className="text-sm font-medium">{t('mb.link_preview', { platform: info.platform, n: num(info.order_count) })}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('mb.login_first')}</p>
        </div>
        <Login onAuthed={onAuthed} />
      </div>
    );
  }

  const confirm = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try { await mapi('/api/member/channel-link', { method: 'POST', body: JSON.stringify({ token, marketing_opt_in: optIn }) }); setDone(true); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-[80vh] flex-col justify-center gap-4">
      <div className="text-center">
        <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground"><Users className="size-7" /></div>
        <h1 className="text-lg font-bold">{t('mb.link_title', { platform: info.platform })}</h1>
        <p className="text-sm text-muted-foreground">{t('mb.link_desc', { n: num(info.order_count) })}</p>
      </div>
      <Card>
        <CardContent className="space-y-3 pt-6">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />
            <span>{t('mb.optin')}</span>
          </label>
          <Button className="w-full" disabled={busy} onClick={confirm}>{busy ? <Loader2 className="size-4 animate-spin" /> : t('mb.link_confirm')}</Button>
          {err && <p className="text-center text-sm text-destructive">{err}</p>}
        </CardContent>
      </Card>
      <button className="text-center text-xs text-muted-foreground underline" onClick={onLogout}>{t('mb.logout')}</button>
    </div>
  );
}

// ── LINE LIFF wrapper (post-docs/29 follow-up) ───────────────────────────────
// When /m opens INSIDE LINE (the LIFF in-app browser) and NEXT_PUBLIC_LIFF_ID is set, the member signs in
// with one tap: the LIFF SDK — loaded from LINE's CDN only in that context, so the normal bundle is
// untouched — hands us a verified id_token which /api/member/auth/line exchanges for the member session.
// A LINE account not yet linked falls back to the normal OTP login and then links automatically, so every
// later open is one-tap. The id_token comes from the SDK, NEVER from the URL (the CWE-598 lesson); the
// shop code comes from the LIFF URL query (?shop=T1) or the last successful login on this device.
// Unset NEXT_PUBLIC_LIFF_ID (or a normal browser) ⇒ exactly the old OTP flow.
const LIFF_ID = process.env.NEXT_PUBLIC_LIFF_ID ?? '';
const SHOP_KEY = 'm:last_shop';
interface LiffLike {
  init(cfg: { liffId: string }): Promise<void>;
  isInClient(): boolean;
  isLoggedIn(): boolean;
  login(): void;
  getIDToken(): string | null;
}
function loadLiff(): Promise<LiffLike | null> {
  return new Promise((resolve) => {
    const w = window as unknown as { liff?: LiffLike };
    if (w.liff) return resolve(w.liff);
    const s = document.createElement('script');
    s.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js';
    s.onload = () => resolve((window as unknown as { liff?: LiffLike }).liff ?? null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
}

// ── Phone-OTP login ──────────────────────────────────────────────────────────
function Login({ onAuthed }: { onAuthed: () => void }) {
  const { t } = useLang();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [shop, setShop] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // LIFF: 'trying' = attempting the one-tap login; a pending idToken means "link after the OTP succeeds".
  const [liffTrying, setLiffTrying] = useState(false);
  const [liffToken, setLiffToken] = useState<string | null>(null);

  useEffect(() => {
    if (!LIFF_ID) return;
    let cancelled = false;
    (async () => {
      try {
        const liff = await loadLiff();
        if (!liff || cancelled) return;
        await liff.init({ liffId: LIFF_ID });
        if (!liff.isInClient()) return; // normal browser → normal OTP flow, no redirects
        if (!liff.isLoggedIn()) { liff.login(); return; } // in-app: establish the LINE session (redirects)
        const idToken = liff.getIDToken();
        if (!idToken || cancelled) return;
        setLiffTrying(true);
        const shopCode = (new URLSearchParams(window.location.search).get('shop') ?? localStorage.getItem(SHOP_KEY) ?? '').trim();
        if (shopCode) {
          try {
            await mapi('/api/member/auth/line', { method: 'POST', body: JSON.stringify({ tenant_code: shopCode, id_token: idToken }) });
            if (!cancelled) { localStorage.setItem(SHOP_KEY, shopCode); onAuthed(); }
            return;
          } catch { /* not linked yet (or wrong shop) → OTP once, then auto-link below */ }
        }
        if (!cancelled) { if (shopCode) setShop(shopCode); setLiffToken(idToken); setLiffTrying(false); }
      } catch { if (!cancelled) setLiffTrying(false); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run the one-tap attempt once per mount
  }, []);

  const request = async () => {
    setBusy(true); setErr('');
    try {
      const r = await mapi<{ sent: boolean; dev_otp?: string }>('/api/member/auth/request-otp', { method: 'POST', body: JSON.stringify({ phone, tenant_code: shop }) });
      setDevOtp(r.dev_otp ?? null); setStep('otp');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setErr('');
    try {
      // verify-otp sets the httpOnly auth cookie + CSRF cookie on success; nothing to store client-side.
      await mapi<{ token: string }>('/api/member/auth/verify-otp', { method: 'POST', body: JSON.stringify({ phone, tenant_code: shop, code }) });
      // First OTP login from inside LINE: link the LINE account (best-effort) so the next open is one-tap.
      if (liffToken) { try { await mapi('/api/member/link-line', { method: 'POST', body: JSON.stringify({ id_token: liffToken }) }); } catch { /* link next time */ } }
      localStorage.setItem(SHOP_KEY, shop.trim());
      onAuthed();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  if (liffTrying) {
    return (
      <div className="flex min-h-[80vh] flex-col items-center justify-center gap-3">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t('mb.line_signing')}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-[80vh] flex-col justify-center">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground"><Sparkles className="size-7" /></div>
        <h1 className="text-xl font-bold">{t('mb.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('mb.login_hint')}</p>
        {liffToken && <p className="mt-2 rounded-md bg-success/10 px-3 py-2 text-xs text-success">{t('mb.line_first')}</p>}
      </div>
      <Card>
        <CardContent className="space-y-3 pt-6">
          {step === 'phone' ? (
            <>
              <div className="grid gap-1.5"><Label>{t('mb.shop_code')}</Label><Input value={shop} onChange={(e) => setShop(e.target.value)} placeholder={t('mb.shop_code_ph')} autoCapitalize="characters" /></div>
              <div className="grid gap-1.5"><Label>{t('mb.phone')}</Label><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="08xxxxxxxx" inputMode="tel" /></div>
              <Button className="w-full" disabled={busy || !shop.trim() || phone.trim().length < 4} onClick={request}>{busy ? <Loader2 className="size-4 animate-spin" /> : t('mb.request_otp')}</Button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t('mb.otp_sent')} <span className="font-medium text-foreground">{phone}</span></p>
              {devOtp && <p className="rounded-md bg-warning/10 px-3 py-2 text-center text-sm">{t('mb.dev_otp')} <span className="font-mono font-bold tracking-widest">{devOtp}</span></p>}
              <div className="grid gap-1.5"><Label>{t('mb.otp')}</Label><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="••••••" inputMode="numeric" maxLength={6} className="text-center text-lg tracking-[0.5em]" /></div>
              <Button className="w-full" disabled={busy || code.trim().length < 4} onClick={verify}>{busy ? <Loader2 className="size-4 animate-spin" /> : t('mb.sign_in')}</Button>
              <button className="w-full text-center text-xs text-muted-foreground underline" onClick={() => { setStep('phone'); setCode(''); setErr(''); }}>{t('mb.change_phone')}</button>
            </>
          )}
          {err && <p className="text-center text-sm text-destructive">{err}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Member home ──────────────────────────────────────────────────────────────
function Home({ onLogout, on401 }: { onLogout: () => void; on401: () => void }) {
  const { t } = useLang();
  const [me, setMe] = useState<any>(null);
  const [rewards, setRewards] = useState<any[]>([]);
  const [missions, setMissions] = useState<any[]>([]);
  const [refs, setRefs] = useState<any[]>([]);
  const [wallet, setWallet] = useState<any[]>([]);
  const [wheels, setWheels] = useState<any[]>([]);
  const [privileges, setPrivileges] = useState<any[]>([]);
  const [receipts, setReceipts] = useState<any[]>([]);
  // V1 (docs/29): tier journey (× earn multiplier + progress), points history, upcoming expiry warning.
  const [tier, setTier] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [expiring, setExpiring] = useState<any>(null);
  const [consents, setConsents] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState('');

  const reload = useCallback(async () => {
    try {
      const [m, r, ms, rf, w, wh, pv, rc, tj, hi, ex, cs] = await Promise.all([
        mapi('/api/member/me'),
        mapi<{ rewards: any[] }>('/api/member/rewards'),
        mapi<{ missions: any[] }>('/api/member/missions'),
        mapi<{ referrals: any[] }>('/api/member/referrals'),
        mapi<{ coupons: any[] }>('/api/member/wallet'),
        mapi<{ wheels: any[] }>('/api/member/wheels'),
        mapi<{ privileges: any[] }>('/api/member/privileges'),
        mapi<{ submissions: any[] }>('/api/member/receipts'),
        mapi('/api/member/tier').catch(() => null),
        mapi<{ history: any[] }>('/api/member/history').catch(() => ({ history: [] })),
        mapi('/api/member/points/expiring').catch(() => null),
        mapi<{ consents: any[] }>('/api/member/consents').catch(() => ({ consents: [] })),
      ]);
      setMe(m); setRewards(r.rewards ?? []); setMissions(ms.missions ?? []); setRefs(rf.referrals ?? []); setWallet(w.coupons ?? []); setWheels(wh.wheels ?? []); setPrivileges(pv.privileges ?? []); setReceipts(rc.submissions ?? []);
      setTier(tj); setHistory(hi?.history ?? []); setExpiring(ex); setConsents(cs?.consents ?? []);
    } catch (e: any) { if (/เซสชัน|session|401|token/i.test(e.message)) on401(); else setErr(e.message); }
  }, [on401]);
  useEffect(() => { reload(); }, [reload]);

  // `busy` gates every point-spending / coupon-issuing action so a mobile double-tap can't fire a duplicate
  // redeem / spin / claim (double-spent points or duplicate coupons). Re-entrancy guarded at the top.
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<any>, okMsg: string) => {
    if (busy) return;
    setBusy(true); setFlash(''); setErr('');
    try { await fn(); setFlash(okMsg); await reload(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const spin = async (w: any) => {
    if (busy) return;
    setBusy(true); setFlash(''); setErr('');
    try {
      const res: any = await mapi(`/api/member/wheels/${w.id}/spin`, { method: 'POST' });
      const p = res.prize;
      setFlash(p?.kind === 'points' ? t('mb.spin_points', { n: p.points }) : p?.kind === 'coupon' ? t('mb.spin_coupon', { label: p.label }) : `🎡 ${p?.label ?? t('mb.spin_none')}`);
      await reload();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const claimPriv = async (v: any) => {
    if (busy) return;
    setBusy(true); setFlash(''); setErr('');
    try { const res: any = await mapi(`/api/member/privileges/${v.id}/claim`, { method: 'POST' }); setFlash(t('mb.claimed_code', { code: res.claim_code })); await reload(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  if (err && !me) return <div className="py-10 text-center text-sm text-destructive">{err}</div>;
  if (!me) return <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;

  const tone = TIER_TONE[me.tier] ?? 'from-primary to-primary';
  return (
    <div className="space-y-5">
      {/* Loyalty card */}
      <div className={`rounded-2xl bg-gradient-to-br ${tone} p-5 text-white shadow-lg`}>
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs/relaxed opacity-80">{t('mb.member')}</p>
            <p className="text-lg font-semibold">{me.name}</p>
            <p className="font-mono text-xs opacity-80">{me.member_code}</p>
          </div>
          <Badge className="border-white/30 bg-white/20 text-white"><Star className="mr-1 size-3" />{me.tier}</Badge>
        </div>
        <div className="mt-5">
          <p className="text-xs opacity-80">{t('mb.points')}</p>
          <p className="text-3xl font-bold tabular-nums">{num(me.balance)}</p>
        </div>
        {/* V1 (docs/29): tier ladder strip — the member sees their ×earn and the road to the next rung */}
        {tier && (
          <div className="mt-4 rounded-lg bg-white/15 px-3 py-2 text-xs">
            <div className="flex justify-between">
              <span>{t('mb.tier_level', { tier: tier.current_tier ?? me.tier })}{(() => { const cur = (tier.tiers ?? []).find((x: any) => x.tier === (tier.current_tier ?? me.tier)); return cur && Number(cur.earn_mult) !== 1 ? t('mb.earn_mult', { x: Number(cur.earn_mult) }) : ''; })()}</span>
              {tier.next_tier && <span>{t('mb.to_next', { n: num(tier.to_next), tier: tier.next_tier })}</span>}
            </div>
            {tier.next_tier && (
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/25">
                <div className="h-full rounded-full bg-white" style={{ width: `${Math.min(100, Number(tier.progress_pct ?? 0))}%` }} />
              </div>
            )}
            {/* V4 (docs/29): paid VIP membership status */}
            {tier.membership?.status === 'Active' && (
              <p className="mt-1 text-[11px] opacity-90">{t('mb.vip_until', { plan: tier.membership.plan_name ?? tier.membership.plan, date: tier.membership.end_date })}</p>
            )}
          </div>
        )}
      </div>
      <div className="flex justify-between px-1">
        <p className="text-xs text-muted-foreground">{t('mb.lifetime', { n: num(me.lifetime) })}</p>
        <div className="flex items-center gap-3">
          {/* V5 (docs/29): the card in the phone wallet — idempotent; mock install link until ops sets WALLET_* creds */}
          <button className="text-xs text-muted-foreground" disabled={busy}
            onClick={() => act(async () => {
              const w: any = await mapi('/api/member/wallet-pass', { method: 'POST', body: JSON.stringify({}) });
              if (w.install_url) window.open(w.install_url, '_blank', 'noopener');
            }, t('mb.wallet_added'))}>{t('mb.add_wallet')}</button>
          <button className="flex items-center gap-1 text-xs text-muted-foreground" onClick={onLogout}><LogOut className="size-3" /> {t('mb.logout')}</button>
        </div>
      </div>

      {/* V1 (docs/29): expiring-points warning chip (reads the W1 look-ahead register) */}
      {expiring && Number(expiring.expiring_points) > 0 && (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-center text-sm">
          {t('mb.expiring', { n: num(expiring.expiring_points), d: expiring.days_left, date: expiring.expire_by })}
        </p>
      )}

      {flash && <p className="rounded-md bg-success/10 px-3 py-2 text-center text-sm text-success">{flash}</p>}
      {err && <p className="rounded-md bg-destructive/10 px-3 py-2 text-center text-sm text-destructive">{err}</p>}

      {/* Rewards */}
      <Section icon={<Gift className="size-4" />} title={t('mb.rewards')}>
        {rewards.length === 0 ? <Empty>{t('mb.rewards_empty')}</Empty> : rewards.map((r) => (
          <Row key={r.id} title={r.name} sub={`${t('mb.reward_cost', { n: num(r.point_cost) })}${r.tier_min ? t('mb.tier_min', { tier: r.tier_min }) : ''}`}>
            <Button size="sm" variant="outline" disabled={busy || Number(me.balance) < Number(r.point_cost)} onClick={() => act(() => mapi(`/api/member/rewards/${r.id}/redeem`, { method: 'POST' }), t('mb.redeem_ok'))}>{t('mb.redeem')}</Button>
          </Row>
        ))}
      </Section>

      {/* Spin-the-wheel */}
      {wheels.length > 0 && (
        <Section icon={<Disc3 className="size-4" />} title={t('mb.wheel_title')}>
          {wheels.map((w) => (
            <Row key={w.id} title={w.name} sub={w.cost_points > 0 ? `${t('mb.wheel_cost', { n: num(w.cost_points) })}${w.daily_free_spins > 0 ? t('mb.wheel_free_n', { n: w.daily_free_spins }) : ''}` : (w.daily_free_spins > 0 ? t('mb.wheel_free_daily', { n: w.daily_free_spins }) : t('mb.free'))}>
              <Button size="sm" disabled={busy || (w.cost_points > 0 && Number(me.balance) < w.cost_points)} onClick={() => spin(w)}>{t('mb.spin')}</Button>
            </Row>
          ))}
        </Section>
      )}

      {/* Partner privileges */}
      {privileges.length > 0 && (
        <Section icon={<Handshake className="size-4" />} title={t('mb.privileges')}>
          {privileges.map((v) => (
            <Row key={v.id} title={v.name} sub={`${v.partner ?? ''}${v.kind === 'discount_percent' ? t('mb.priv_discount_pct', { n: v.value }) : v.kind === 'discount_amount' ? t('mb.priv_discount_amt', { n: v.value }) : v.kind === 'freebie' ? t('mb.priv_freebie') : ''}`}>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => claimPriv(v)}>{t('mb.claim')}</Button>
            </Row>
          ))}
        </Section>
      )}

      {/* Wallet */}
      {wallet.length > 0 && (
        <Section icon={<Ticket className="size-4" />} title={t('mb.coupons')}>
          {wallet.map((c) => (
            <Row key={c.id} title={c.reward_name ?? c.coupon_code} sub={c.status === 'issued' ? t('mb.coupon_ready') : c.status}>
              <span className="font-mono text-sm font-semibold">{c.coupon_code ?? c.code}</span>
            </Row>
          ))}
        </Section>
      )}

      {/* Missions */}
      <Section icon={<Trophy className="size-4" />} title={t('mb.missions')}>
        {missions.length === 0 ? <Empty>{t('mb.missions_empty')}</Empty> : missions.map((m) => (
          <Row key={m.id} title={m.name} sub={`${Number(m.progress ?? 0)}/${Number(m.goal ?? 0)} · ${t('mb.mission_reward', { n: Number(m.reward_points ?? 0) })}`}>
            {m.claimed ? <Badge variant="muted">{t('mb.claimed')}</Badge>
              : m.completed ? <Button size="sm" disabled={busy} onClick={() => act(() => mapi(`/api/member/missions/${m.id}/claim`, { method: 'POST' }), t('mb.mission_claimed'))}>{t('mb.claim_reward')}</Button>
              : <Badge variant="info">{Math.round((Number(m.progress ?? 0) / Math.max(1, Number(m.goal ?? 1))) * 100)}%</Badge>}
          </Row>
        ))}
      </Section>

      {/* V1 (docs/29): P2P transfer — the W1 API (LYL-18), finally tappable */}
      <Section icon={<Users className="size-4" />} title={t('mb.transfer')}>
        <TransferForm busy={busy} balance={Number(me.balance ?? 0)} onDone={(msg) => act(async () => {}, msg)} />
      </Section>

      {/* V1 (docs/29): points history — Earn / Redeem / Transfer / Expire with running balance */}
      {history.length > 0 && (
        <Section icon={<ReceiptText className="size-4" />} title={t('mb.history')}>
          {history.slice(0, 10).map((h: any, i: number) => (
            <Row key={i}
              title={`${h.txn_type === 'Earn' ? t('mb.h_earn') : h.txn_type === 'Redeem' ? t('mb.h_redeem') : h.txn_type === 'Transfer' ? (Number(h.points) < 0 ? t('mb.h_out') : t('mb.h_in')) : h.txn_type === 'Expire' ? t('mb.h_expire') : h.txn_type} ${t('mb.h_points', { sign: Number(h.points) > 0 ? '+' : '', n: num(h.points) })}`}
              sub={`${h.ref_doc ?? ''}${t('mb.h_balance', { n: num(h.balance_after) })}`}>
              <span className="text-xs text-muted-foreground">{h.txn_date ? new Date(h.txn_date).toLocaleDateString('th-TH') : ''}</span>
            </Row>
          ))}
        </Section>
      )}

      {/* Refer a friend */}
      <Section icon={<Users className="size-4" />} title={t('mb.refer')}>
        <ReferForm onDone={(msg) => act(async () => {}, msg)} />
        {refs.map((r) => (
          <Row key={r.id} title={r.code} sub={r.referred_phone ?? r.referred_name ?? '—'}>
            <Badge variant={r.status === 'rewarded' ? 'success' : 'muted'}>{r.status === 'rewarded' ? t('mb.ref_rewarded') : t('mb.ref_waiting')}</Badge>
          </Row>
        ))}
      </Section>

      {/* Receipt upload — ซื้อนอก POS แล้วแนบรูปใบเสร็จเพื่อขอแต้ม (LYL-17); staff ตรวจสอบก่อนบันทึกแต้ม */}
      <Section icon={<ReceiptText className="size-4" />} title={t('mb.receipts')}>
        <ReceiptUploadForm onDone={(msg) => act(async () => {}, msg)} />
        {receipts.length === 0 ? <Empty>{t('mb.receipts_empty')}</Empty> : receipts.map((r) => (
          <Row key={r.id} title={`${baht(r.purchase_amount)}${r.store_name ? ` · ${r.store_name}` : ''}`} sub={t('mb.receipt_when', { date: thaiDate(r.submitted_at) })}>
            <Badge variant={r.status === 'Approved' ? 'success' : r.status === 'Rejected' ? 'destructive' : 'warning'}>
              {r.status === 'Approved' ? t('mb.rc_approved') : r.status === 'Rejected' ? t('mb.rc_rejected') : t('mb.rc_pending')}
            </Badge>
          </Row>
        ))}
      </Section>

      {/* PDPA consents — the data subject manages their OWN per-purpose consents (LYL-10c, source='self').
          Includes 'dining_profile' (the fine-dining guest preference profile the shop may keep for service). */}
      <Section icon={<ShieldCheck className="size-4" />} title={t('mb.consents')}>
        <p className="mb-1 text-xs text-muted-foreground">{t('mb.consents_hint')}</p>
        {CONSENT_PURPOSES.map((p) => {
          const row = consents.find((c: any) => c.purpose === p.purpose);
          const granted = row ? row.granted === true : p.purpose === 'marketing' ? me.marketing_opt_in !== false : false;
          return (
            <Row key={p.purpose} title={t(p.label)} sub={t(p.sub)}>
              <Button size="sm" variant={granted ? 'outline' : 'default'} disabled={busy}
                onClick={() => act(() => mapi('/api/member/consents', { method: 'PUT', body: JSON.stringify({ purpose: p.purpose, granted: !granted }) }), granted ? t('mb.consent_withdrawn') : t('mb.consent_granted'))}>
                {granted ? t('mb.withdraw') : t('mb.consent')}
              </Button>
            </Row>
          );
        })}
      </Section>
    </div>
  );
}

// PDPA per-purpose consent catalogue surfaced to the member (the ledger accepts any purpose; these are the
// ones a guest can meaningfully self-manage). label/sub are message-catalog keys.
const CONSENT_PURPOSES: { purpose: string; label: string; sub: string }[] = [
  { purpose: 'marketing', label: 'mb.consent_marketing', sub: 'mb.consent_marketing_sub' },
  { purpose: 'dining_profile', label: 'mb.consent_dining', sub: 'mb.consent_dining_sub' },
];

// V1 (docs/29) — P2P transfer form. The API enforces every guard (balance, same shop, no self, day cap);
// this form just surfaces the messages verbatim. `busy` is shared with the page so a double-tap can't
// fire a duplicate transfer.
function TransferForm({ busy, balance, onDone }: { busy: boolean; balance: number; onDone: (msg: string) => void }) {
  const { t } = useLang();
  const [phone, setPhone] = useState('');
  const [points, setPoints] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const send = async () => {
    if (busy || sending) return;
    setSending(true); setErr('');
    try {
      const r: any = await mapi('/api/member/points/transfer', { method: 'POST', body: JSON.stringify({ to_phone: phone.trim(), points: Number(points), note: note.trim() || undefined }) });
      setPhone(''); setPoints(''); setNote('');
      onDone(t('mb.transfer_ok', { n: num(r.points), bal: num(r.from_balance) }));
    } catch (e: any) { setErr(e.message); } finally { setSending(false); }
  };
  const pts = Number(points);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t('mb.friend_phone_ph')} inputMode="tel" />
        <Input value={points} onChange={(e) => setPoints(e.target.value)} placeholder={t('mb.points_ph')} inputMode="numeric" />
      </div>
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('mb.note_ph')} maxLength={200} />
      <Button className="w-full" size="sm" disabled={busy || sending || !phone.trim() || !Number.isInteger(pts) || pts <= 0 || pts > balance} onClick={send}>
        {sending ? <Loader2 className="size-4 animate-spin" /> : t('mb.send_points')}
      </Button>
      <p className="text-center text-[11px] text-muted-foreground">{t('mb.transfer_note')}</p>
      {err && <p className="text-center text-sm text-destructive">{err}</p>}
    </div>
  );
}

function ReferForm({ onDone }: { onDone: (msg: string) => void }) {
  const { t } = useLang();
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true); setErr('');
    try { await mapi('/api/member/refer', { method: 'POST', body: JSON.stringify({ referred_phone: phone }) }); setPhone(''); onDone(t('mb.refer_sent')); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="mb-2 flex gap-2">
      <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t('mb.friend_phone_ph')} inputMode="tel" />
      <Button disabled={busy || phone.trim().length < 4} onClick={submit}>{busy ? <Loader2 className="size-4 animate-spin" /> : t('mb.invite')}</Button>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}

function ReceiptUploadForm({ onDone }: { onDone: (msg: string) => void }) {
  const { t } = useLang();
  const [preview, setPreview] = useState('');
  const [amount, setAmount] = useState('');
  const [storeName, setStoreName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  function onFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => setPreview(String(reader.result));
    reader.readAsDataURL(file);
  }
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      await mapi('/api/member/receipts', { method: 'POST', body: JSON.stringify({ receipt_image: preview, purchase_amount: Number(amount), store_name: storeName || undefined }) });
      setPreview(''); setAmount(''); setStoreName('');
      onDone(t('mb.receipt_sent'));
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="mb-2 space-y-2 rounded-lg border border-border/60 p-3">
      <div className="grid gap-1.5"><Label>{t('mb.receipt_amount')}</Label><Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="150" inputMode="decimal" /></div>
      <div className="grid gap-1.5"><Label>{t('mb.receipt_store')}</Label><Input value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder={t('mb.receipt_store_ph')} /></div>
      <Button variant="outline" className="w-full" onClick={() => fileRef.current?.click()}><Upload className="size-4" /> {preview ? t('mb.receipt_change') : t('mb.receipt_pick')}</Button>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
      {preview && <img src={preview} alt={t('mb.receipt_preview')} className="max-h-40 w-full rounded-md object-contain" />}
      <Button className="w-full" disabled={busy || !preview || !amount} onClick={submit}>{busy ? <Loader2 className="size-4 animate-spin" /> : t('mb.receipt_submit')}</Button>
      {err && <p className="text-center text-xs text-destructive">{err}</p>}
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <Card className="gap-3">
      <CardHeader className="pb-0"><CardTitle className="flex items-center gap-2 text-sm">{icon} {title}</CardTitle></CardHeader>
      <CardContent className="space-y-2">{children}</CardContent>
    </Card>
  );
}
function Row({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-3">
      <div className="min-w-0"><p className="truncate text-sm font-medium">{title}</p>{sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}</div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) { return <p className="py-2 text-center text-xs text-muted-foreground">{children}</p>; }
