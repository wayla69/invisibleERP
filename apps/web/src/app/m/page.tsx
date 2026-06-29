'use client';

// Loyalty MEMBER self-service app (consumer-facing, mobile-first). Standalone surface at /m — NOT the staff
// shell. Auth is phone-OTP (POST /api/member/auth/*) which mints a member token delivered as a server-set
// httpOnly cookie (the JWT is NOT readable from JS — XSS can't steal it), paired with a readable double-submit
// CSRF token (`ierp_csrf`) echoed in X-CSRF-Token on mutations. The member only ever sees/acts on themselves
// (the API derives the member from the cookie token — there is no member_id input).
import { useState, useEffect, useCallback } from 'react';
import { Gift, Trophy, Users, Star, LogOut, Sparkles, Ticket, Loader2, Disc3, Handshake } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

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
  if (!res.ok) throw new Error(body?.error?.messageTh ?? body?.error?.message ?? `HTTP ${res.status}`);
  return body as T;
}

const TIER_TONE: Record<string, string> = { Bronze: 'from-amber-700 to-amber-500', Silver: 'from-slate-400 to-slate-300', Gold: 'from-yellow-500 to-amber-400', Platinum: 'from-indigo-500 to-violet-400' };

export default function MemberApp() {
  // null = still probing the session; true/false once known. The auth JWT is httpOnly and unreadable, so we
  // confirm a live member session by probing /api/member/me rather than reading a token from localStorage.
  const [authed, setAuthed] = useState<boolean | null>(null);
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
      {authed ? <Home onLogout={onLogout} on401={() => setAuthed(false)} /> : <Login onAuthed={() => setAuthed(true)} />}
    </div>
  );
}

// ── Phone-OTP login ──────────────────────────────────────────────────────────
function Login({ onAuthed }: { onAuthed: () => void }) {
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [shop, setShop] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

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
      onAuthed();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-[80vh] flex-col justify-center">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground"><Sparkles className="size-7" /></div>
        <h1 className="text-xl font-bold">สมาชิก & แต้ม</h1>
        <p className="text-sm text-muted-foreground">เข้าสู่ระบบด้วยเบอร์โทรเพื่อดูแต้มและสิทธิพิเศษ</p>
      </div>
      <Card>
        <CardContent className="space-y-3 pt-6">
          {step === 'phone' ? (
            <>
              <div className="grid gap-1.5"><Label>รหัสร้าน (Shop code)</Label><Input value={shop} onChange={(e) => setShop(e.target.value)} placeholder="เช่น T1" autoCapitalize="characters" /></div>
              <div className="grid gap-1.5"><Label>เบอร์โทรศัพท์</Label><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="08xxxxxxxx" inputMode="tel" /></div>
              <Button className="w-full" disabled={busy || !shop.trim() || phone.trim().length < 4} onClick={request}>{busy ? <Loader2 className="size-4 animate-spin" /> : 'ขอรหัส OTP'}</Button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">เราส่งรหัส 6 หลักไปที่ <span className="font-medium text-foreground">{phone}</span></p>
              {devOtp && <p className="rounded-md bg-warning/10 px-3 py-2 text-center text-sm">รหัสทดสอบ (dev): <span className="font-mono font-bold tracking-widest">{devOtp}</span></p>}
              <div className="grid gap-1.5"><Label>รหัส OTP</Label><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="••••••" inputMode="numeric" maxLength={6} className="text-center text-lg tracking-[0.5em]" /></div>
              <Button className="w-full" disabled={busy || code.trim().length < 4} onClick={verify}>{busy ? <Loader2 className="size-4 animate-spin" /> : 'เข้าสู่ระบบ'}</Button>
              <button className="w-full text-center text-xs text-muted-foreground underline" onClick={() => { setStep('phone'); setCode(''); setErr(''); }}>เปลี่ยนเบอร์โทร</button>
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
  const [me, setMe] = useState<any>(null);
  const [rewards, setRewards] = useState<any[]>([]);
  const [missions, setMissions] = useState<any[]>([]);
  const [refs, setRefs] = useState<any[]>([]);
  const [wallet, setWallet] = useState<any[]>([]);
  const [wheels, setWheels] = useState<any[]>([]);
  const [privileges, setPrivileges] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState('');

  const reload = useCallback(async () => {
    try {
      const [m, r, ms, rf, w, wh, pv] = await Promise.all([
        mapi('/api/member/me'),
        mapi<{ rewards: any[] }>('/api/member/rewards'),
        mapi<{ missions: any[] }>('/api/member/missions'),
        mapi<{ referrals: any[] }>('/api/member/referrals'),
        mapi<{ coupons: any[] }>('/api/member/wallet'),
        mapi<{ wheels: any[] }>('/api/member/wheels'),
        mapi<{ privileges: any[] }>('/api/member/privileges'),
      ]);
      setMe(m); setRewards(r.rewards ?? []); setMissions(ms.missions ?? []); setRefs(rf.referrals ?? []); setWallet(w.coupons ?? []); setWheels(wh.wheels ?? []); setPrivileges(pv.privileges ?? []);
    } catch (e: any) { if (/เซสชัน|401|token/i.test(e.message)) on401(); else setErr(e.message); }
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
      setFlash(p?.kind === 'points' ? `🎉 ได้รับ ${p.points} แต้ม!` : p?.kind === 'coupon' ? `🎟️ ได้คูปอง “${p.label}” — ดูในคูปองของฉัน` : `🎡 ${p?.label ?? 'รอบนี้ยังไม่ได้รางวัล ลองใหม่!'}`);
      await reload();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const claimPriv = async (v: any) => {
    if (busy) return;
    setBusy(true); setFlash(''); setErr('');
    try { const res: any = await mapi(`/api/member/privileges/${v.id}/claim`, { method: 'POST' }); setFlash(`🎫 รับสิทธิ์แล้ว! รหัส ${res.claim_code} — แสดงที่ร้านพันธมิตร`); await reload(); }
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
            <p className="text-xs/relaxed opacity-80">สมาชิก</p>
            <p className="text-lg font-semibold">{me.name}</p>
            <p className="font-mono text-xs opacity-80">{me.member_code}</p>
          </div>
          <Badge className="border-white/30 bg-white/20 text-white"><Star className="mr-1 size-3" />{me.tier}</Badge>
        </div>
        <div className="mt-5">
          <p className="text-xs opacity-80">แต้มสะสม</p>
          <p className="text-3xl font-bold tabular-nums">{Number(me.balance ?? 0).toLocaleString()}</p>
        </div>
      </div>
      <div className="flex justify-between px-1">
        <p className="text-xs text-muted-foreground">แต้มสะสมตลอดชีพ {Number(me.lifetime ?? 0).toLocaleString()}</p>
        <button className="flex items-center gap-1 text-xs text-muted-foreground" onClick={onLogout}><LogOut className="size-3" /> ออกจากระบบ</button>
      </div>

      {flash && <p className="rounded-md bg-success/10 px-3 py-2 text-center text-sm text-success">{flash}</p>}
      {err && <p className="rounded-md bg-destructive/10 px-3 py-2 text-center text-sm text-destructive">{err}</p>}

      {/* Rewards */}
      <Section icon={<Gift className="size-4" />} title="ของรางวัล — ใช้แต้มแลก">
        {rewards.length === 0 ? <Empty>ยังไม่มีของรางวัล</Empty> : rewards.map((r) => (
          <Row key={r.id} title={r.name} sub={`${Number(r.point_cost).toLocaleString()} แต้ม${r.tier_min ? ` · ขั้นต่ำ ${r.tier_min}` : ''}`}>
            <Button size="sm" variant="outline" disabled={busy || Number(me.balance) < Number(r.point_cost)} onClick={() => act(() => mapi(`/api/member/rewards/${r.id}/redeem`, { method: 'POST' }), '🎁 แลกสำเร็จ! ดูโค้ดในคูปองของฉัน')}>แลก</Button>
          </Row>
        ))}
      </Section>

      {/* Spin-the-wheel */}
      {wheels.length > 0 && (
        <Section icon={<Disc3 className="size-4" />} title="วงล้อนำโชค — หมุนรับรางวัล">
          {wheels.map((w) => (
            <Row key={w.id} title={w.name} sub={w.cost_points > 0 ? `${Number(w.cost_points).toLocaleString()} แต้ม/ครั้ง${w.daily_free_spins > 0 ? ` · ฟรี ${w.daily_free_spins}/วัน` : ''}` : (w.daily_free_spins > 0 ? `ฟรี ${w.daily_free_spins} ครั้ง/วัน` : 'ฟรี')}>
              <Button size="sm" disabled={busy || (w.cost_points > 0 && Number(me.balance) < w.cost_points)} onClick={() => spin(w)}>หมุน</Button>
            </Row>
          ))}
        </Section>
      )}

      {/* Partner privileges */}
      {privileges.length > 0 && (
        <Section icon={<Handshake className="size-4" />} title="สิทธิพิเศษพันธมิตร">
          {privileges.map((v) => (
            <Row key={v.id} title={v.name} sub={`${v.partner ?? ''}${v.kind === 'discount_percent' ? ` · ลด ${v.value}%` : v.kind === 'discount_amount' ? ` · ลด ฿${v.value}` : v.kind === 'freebie' ? ' · ของแถม' : ''}`}>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => claimPriv(v)}>รับสิทธิ์</Button>
            </Row>
          ))}
        </Section>
      )}

      {/* Wallet */}
      {wallet.length > 0 && (
        <Section icon={<Ticket className="size-4" />} title="คูปองของฉัน">
          {wallet.map((c) => (
            <Row key={c.id} title={c.reward_name ?? c.coupon_code} sub={c.status === 'issued' ? 'พร้อมใช้' : c.status}>
              <span className="font-mono text-sm font-semibold">{c.coupon_code ?? c.code}</span>
            </Row>
          ))}
        </Section>
      )}

      {/* Missions */}
      <Section icon={<Trophy className="size-4" />} title="ภารกิจ & แสตมป์">
        {missions.length === 0 ? <Empty>ยังไม่มีภารกิจ</Empty> : missions.map((m) => (
          <Row key={m.id} title={m.name} sub={`${Number(m.progress ?? 0)}/${Number(m.goal ?? 0)} · +${Number(m.reward_points ?? 0)} แต้ม`}>
            {m.claimed ? <Badge variant="muted">รับแล้ว</Badge>
              : m.completed ? <Button size="sm" disabled={busy} onClick={() => act(() => mapi(`/api/member/missions/${m.id}/claim`, { method: 'POST' }), '🏆 รับรางวัลภารกิจแล้ว')}>รับรางวัล</Button>
              : <Badge variant="info">{Math.round((Number(m.progress ?? 0) / Math.max(1, Number(m.goal ?? 1))) * 100)}%</Badge>}
          </Row>
        ))}
      </Section>

      {/* Refer a friend */}
      <Section icon={<Users className="size-4" />} title="ชวนเพื่อน รับแต้ม">
        <ReferForm onDone={(msg) => act(async () => {}, msg)} />
        {refs.map((r) => (
          <Row key={r.id} title={r.code} sub={r.referred_phone ?? r.referred_name ?? '—'}>
            <Badge variant={r.status === 'rewarded' ? 'success' : 'muted'}>{r.status === 'rewarded' ? 'ได้แต้มแล้ว' : 'รอเพื่อนสมัคร'}</Badge>
          </Row>
        ))}
      </Section>
    </div>
  );
}

function ReferForm({ onDone }: { onDone: (msg: string) => void }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true); setErr('');
    try { await mapi('/api/member/refer', { method: 'POST', body: JSON.stringify({ referred_phone: phone }) }); setPhone(''); onDone('📨 ส่งคำชวนแล้ว — เพื่อนสมัครและซื้อครบ คุณทั้งคู่ได้แต้ม'); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="mb-2 flex gap-2">
      <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="เบอร์เพื่อน 08xxxxxxxx" inputMode="tel" />
      <Button disabled={busy || phone.trim().length < 4} onClick={submit}>{busy ? <Loader2 className="size-4 animate-spin" /> : 'ชวน'}</Button>
      {err && <p className="text-xs text-destructive">{err}</p>}
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
