'use client';

// C1 (Platform Phase 20) — client-side i18n framework. A LanguageProvider keeps the chosen UI locale,
// resolved on mount from the server (user override → tenant default → 'th') with a localStorage cache, and
// exposes useLang() → { lang, setLang, t, fmtNumber, fmtDate, locales }. `t(key, vars?)` does {var}
// interpolation and falls back to the Thai value then the key. setLang persists to the server (best-effort)
// + localStorage. Catalogs live in messages.ts. Per-screen coverage stays incremental (opt in via t()).
import * as React from 'react';
import { type Lang } from './messages';
import { LANG_KEY as KEY, interpolate, lookup } from './i18n-static';
import { api, hasSession } from './api';

export type { Lang };
// Set (to the chosen locale) when the server persist failed — e.g. offline, or a god in read-only company
// view where every PUT is rejected (403 READONLY_IMPERSONATION). While present, the local choice is
// authoritative: on mount we retry the persist instead of letting the stale server value clobber it.
const PENDING_KEY = 'ierp_lang_pending';
const LOCALES: { code: Lang; label: string }[] = [
  { code: 'th', label: 'ไทย' },
  { code: 'en', label: 'English' },
  { code: 'ms', label: 'Bahasa Melayu' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'id', label: 'Bahasa Indonesia' },
];
const INTL: Record<Lang, string> = { th: 'th-TH', en: 'en-US', ms: 'ms-MY', vi: 'vi-VN', id: 'id-ID' };
const CODES = LOCALES.map((l) => l.code);
const isLang = (x: unknown): x is Lang => typeof x === 'string' && (CODES as string[]).includes(x);

type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  fmtNumber: (n: number, opts?: Intl.NumberFormatOptions) => string;
  fmtDate: (d: Date | string | number, opts?: Intl.DateTimeFormatOptions) => string;
  locales: { code: Lang; label: string }[];
};
const LangContext = React.createContext<Ctx | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = React.useState<Lang>('th');
  // True once the user explicitly picks a locale this mount — a still-in-flight mount-time server read must
  // never clobber an explicit choice that raced past it (picking EN right after page load snapped back to TH).
  const userChose = React.useRef(false);

  // Initial locale: localStorage cache first (instant), then the server-resolved value (user → tenant → th).
  // If a previous choice never reached the server (PENDING_KEY set), the local choice wins — retry the
  // persist and skip the server read, so a full page load can't revert the user's explicit selection.
  React.useEffect(() => {
    let saved: string | null = null;
    let pending: string | null = null;
    try { saved = window.localStorage.getItem(KEY); pending = window.localStorage.getItem(PENDING_KEY); } catch { /* ignore */ }
    if (isLang(saved)) setLangState(saved);
    if (!hasSession()) return;
    if (isLang(pending)) {
      api('/api/i18n/me', { method: 'PUT', body: JSON.stringify({ locale: pending }) })
        .then(() => { try { window.localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ } })
        .catch(() => { /* still unpersistable (offline / read-only view) — keep honoring the local choice */ });
      return;
    }
    api<{ locale: string }>('/api/i18n/me')
      .then((r) => {
        if (userChose.current || !isLang(r?.locale)) return;
        setLangState(r.locale);
        try { window.localStorage.setItem(KEY, r.locale); } catch { /* ignore */ }
      })
      .catch(() => { /* unauthenticated or offline — keep the cached/default locale */ });
  }, []);
  React.useEffect(() => { if (typeof document !== 'undefined') document.documentElement.lang = lang; }, [lang]);

  const setLang = React.useCallback((l: Lang) => {
    if (!isLang(l)) return;
    userChose.current = true;
    setLangState(l);
    try { window.localStorage.setItem(KEY, l); } catch { /* ignore */ }
    if (hasSession()) {
      api('/api/i18n/me', { method: 'PUT', body: JSON.stringify({ locale: l }) })
        .then(() => { try { window.localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ } })
        .catch(() => { try { window.localStorage.setItem(PENDING_KEY, l); } catch { /* ignore */ } });
    }
  }, []);

  const value = React.useMemo<Ctx>(() => ({
    lang, setLang, locales: LOCALES,
    t: (key, vars) => interpolate(lookup(key, lang), vars),
    fmtNumber: (n, opts) => new Intl.NumberFormat(INTL[lang], opts).format(n),
    fmtDate: (d, opts) => new Intl.DateTimeFormat(INTL[lang], opts).format(new Date(d)),
  }), [lang, setLang]);

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

// Safe outside a provider (returns Thai defaults) so screens/components never crash if unwrapped.
export function useLang(): Ctx {
  const ctx = React.useContext(LangContext);
  if (ctx) return ctx;
  return {
    lang: 'th', setLang: () => {}, locales: LOCALES,
    t: (k, vars) => interpolate(lookup(k, 'th'), vars),
    fmtNumber: (n, opts) => new Intl.NumberFormat('th-TH', opts).format(n),
    fmtDate: (d, opts) => new Intl.DateTimeFormat('th-TH', opts).format(new Date(d)),
  };
}
