'use client';

import { Languages } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLang } from '@/lib/i18n';

// Header toggle that flips the UI language (TH ⇄ EN), persisted in localStorage by the LanguageProvider.
export function LanguageToggle() {
  const { lang, setLang, t } = useLang();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t('common.language')}
      title={t('common.language')}
      onClick={() => setLang(lang === 'th' ? 'en' : 'th')}
    >
      <span className="relative flex items-center">
        <Languages className="size-4" />
        <span className="ml-1 text-[10px] font-semibold uppercase">{lang}</span>
      </span>
    </Button>
  );
}
