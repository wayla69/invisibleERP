// Non-React translation for code that runs outside the LanguageProvider tree — the fetch-layer error
// messages (lib/api.ts), print/toast helpers, and other plain modules. Reads the persisted locale the
// provider maintains (localStorage `ierp_lang`); React screens should keep using useLang()'s t(), which
// re-renders on a language switch — ts() is evaluated at call time only, so use it for transient strings
// (thrown errors, toasts, prompts), never for rendered labels.
import { MESSAGES, type Lang } from './messages';

export const LANG_KEY = 'ierp_lang';
const CODES: readonly string[] = ['th', 'en', 'ms', 'vi', 'id'];

export function interpolate(s: string, vars?: Record<string, string | number>): string {
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`)) : s;
}

export function lookup(key: string, lang: Lang, fallback?: string): string {
  const m = MESSAGES[key];
  return m?.[lang] ?? m?.th ?? fallback ?? key;
}

export function currentLang(): Lang {
  try {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(LANG_KEY) : null;
    return v != null && CODES.includes(v) ? (v as Lang) : 'th';
  } catch {
    return 'th';
  }
}

/** Static translate: catalog lookup at the persisted locale, with {var} interpolation. */
export function ts(key: string, vars?: Record<string, string | number>): string {
  return interpolate(lookup(key, currentLang()), vars);
}
