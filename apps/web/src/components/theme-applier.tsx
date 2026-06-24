'use client';

import { useEffect } from 'react';
import { api, getToken } from '@/lib/api';

// E4 (Platform Phase 29) — applies the tenant's white-label theme tokens as CSS variables on the document
// root, so the brand hue + corner radius re-skin the whole app shell. Renders nothing; best-effort (keeps
// defaults when offline/unauthenticated). Tokens are in the app's oklch format, so they stay in-gamut.
export function ThemeApplier() {
  useEffect(() => {
    if (!getToken()) return;
    api<{ theme: { primary_css?: string; radius_css?: string } }>('/api/tenant/theme')
      .then((r) => {
        const el = document.documentElement;
        if (r?.theme?.primary_css) el.style.setProperty('--primary', r.theme.primary_css);
        if (r?.theme?.radius_css) el.style.setProperty('--radius', r.theme.radius_css);
      })
      .catch(() => { /* offline/unauth — keep the built-in defaults */ });
  }, []);
  return null;
}
