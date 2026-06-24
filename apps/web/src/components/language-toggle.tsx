'use client';

import { Languages } from 'lucide-react';
import { useLang } from '@/lib/i18n';

// Header locale picker (C1, Phase 20). Lists the supported locales; the LanguageProvider persists the choice
// to the server (per-user) + localStorage. Falls back gracefully when offline/unauthenticated.
export function LanguageToggle() {
  const { lang, setLang, t, locales } = useLang();
  return (
    <label className="inline-flex items-center gap-1" title={t('common.language')}>
      <Languages className="size-4" aria-hidden />
      <span className="sr-only">{t('common.language')}</span>
      <select
        aria-label={t('common.language')}
        value={lang}
        onChange={(e) => setLang(e.target.value as typeof lang)}
        className="h-8 rounded-md border bg-transparent px-1 text-xs font-semibold uppercase"
      >
        {locales.map((l) => <option key={l.code} value={l.code}>{l.code.toUpperCase()}</option>)}
      </select>
    </label>
  );
}
