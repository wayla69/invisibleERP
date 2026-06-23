'use client';

// Lightweight client-side i18n for the web app (Phase 9). A LanguageProvider keeps the chosen UI language
// (th | en) in localStorage and exposes `useLang()` → { lang, setLang, t }. `t(key)` looks the key up in the
// catalog for the active language and falls back to Thai, then to the key itself. Per-screen coverage is
// incremental: screens opt in by calling `t(...)`; untranslated strings simply render their Thai default.
import * as React from 'react';

export type Lang = 'th' | 'en';
const KEY = 'ierp_lang';

// Seed catalog — common chrome + actions. Extend per screen as translations are added.
const MESSAGES: Record<string, { th: string; en: string }> = {
  'common.search': { th: 'ค้นหา…', en: 'Search…' },
  'common.save': { th: 'บันทึก', en: 'Save' },
  'common.cancel': { th: 'ยกเลิก', en: 'Cancel' },
  'common.language': { th: 'ภาษา', en: 'Language' },
  'common.logout': { th: 'ออกจากระบบ', en: 'Log out' },
  'common.settings': { th: 'ตั้งค่า', en: 'Settings' },
  'ws.erp': { th: 'ระบบหลังร้าน (ERP)', en: 'Back office (ERP)' },
  'ws.pos': { th: 'หน้าร้าน (POS)', en: 'Storefront (POS)' },
};

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (key: string, fallback?: string) => string };
const LangContext = React.createContext<Ctx | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = React.useState<Lang>('th');
  React.useEffect(() => {
    const saved = (typeof window !== 'undefined' && window.localStorage.getItem(KEY)) as Lang | null;
    if (saved === 'th' || saved === 'en') setLangState(saved);
  }, []);
  React.useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
  }, [lang]);
  const setLang = React.useCallback((l: Lang) => {
    setLangState(l);
    if (typeof window !== 'undefined') window.localStorage.setItem(KEY, l);
  }, []);
  const t = React.useCallback((key: string, fallback?: string) => {
    const m = MESSAGES[key];
    return m ? m[lang] : (fallback ?? key);
  }, [lang]);
  return <LangContext.Provider value={{ lang, setLang, t }}>{children}</LangContext.Provider>;
}

// Safe outside a provider (returns Thai default) so screens/components never crash if unwrapped.
export function useLang(): Ctx {
  return React.useContext(LangContext) ?? { lang: 'th', setLang: () => {}, t: (k, f) => (MESSAGES[k]?.th ?? f ?? k) };
}
