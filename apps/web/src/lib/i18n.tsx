'use client';

// C1 (Platform Phase 20) — client-side i18n framework. A LanguageProvider keeps the chosen UI locale,
// resolved on mount from the server (user override → tenant default → 'th') with a localStorage cache, and
// exposes useLang() → { lang, setLang, t, fmtNumber, fmtDate, locales }. `t(key, vars?)` does {var}
// interpolation and falls back to the Thai value then the key. setLang persists to the server (best-effort)
// + localStorage. Catalogs live in messages.ts. Per-screen coverage stays incremental (opt in via t()).
import * as React from 'react';
import { MESSAGES, type Lang } from './messages';
import { api, hasSession } from './api';

export type { Lang };
const KEY = 'ierp_lang';
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

function interpolate(s: string, vars?: Record<string, string | number>) {
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`)) : s;
}
function lookup(key: string, lang: Lang, fallback?: string) {
  const m = MESSAGES[key];
  return m?.[lang] ?? m?.th ?? fallback ?? key;
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = React.useState<Lang>('th');

  // Initial locale: localStorage cache first (instant), then the server-resolved value (user → tenant → th).
  React.useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem(KEY) : null;
    if (isLang(saved)) setLangState(saved);
    if (hasSession()) {
      api<{ locale: string }>('/api/i18n/me')
        .then((r) => { if (isLang(r?.locale)) { setLangState(r.locale); try { window.localStorage.setItem(KEY, r.locale); } catch { /* ignore */ } } })
        .catch(() => { /* unauthenticated or offline — keep the cached/default locale */ });
    }
  }, []);
  React.useEffect(() => { if (typeof document !== 'undefined') document.documentElement.lang = lang; }, [lang]);

  const setLang = React.useCallback((l: Lang) => {
    if (!isLang(l)) return;
    setLangState(l);
    try { window.localStorage.setItem(KEY, l); } catch { /* ignore */ }
    if (hasSession()) api('/api/i18n/me', { method: 'PUT', body: JSON.stringify({ locale: l }) }).catch(() => { /* best-effort */ });
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
