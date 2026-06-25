/**
 * Self-contained menu-item placeholder images for the Oshinei demo.
 *
 * No object storage / network needed: each item gets a category-themed SVG
 * (gradient + food glyph + dish name) returned as a `data:image/svg+xml,…`
 * URI, stored directly in menu_items.image_url and rendered by any <img>.
 */
const CAT_COLOR: Record<string, string> = {
  APP: '#f59e0b', DON: '#ef4444', PCK: '#a855f7', ROL: '#10b981', SLD: '#84cc16',
  SAS: '#06b6d4', SHB: '#f97316', SOB: '#8b5cf6', STK: '#dc2626', SUS: '#0ea5e9', YUM: '#ec4899',
};
const CAT_GLYPH: Record<string, string> = {
  APP: '🍤', DON: '🍚', PCK: '🥢', ROL: '🍣', SLD: '🥗',
  SAS: '🐟', SHB: '🍲', SOB: '🍜', STK: '🥩', SUS: '🍣', YUM: '🌶️',
};

function darken(hex: string, f: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const r = Math.round(((v >> 16) & 255) * f);
  const g = Math.round(((v >> 8) & 255) * f);
  const b = Math.round((v & 255) * f);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// strip the buffet/à-la-carte "(B)"/"(A)" prefix and trim to a card-sized label
function cleanLabel(name: string): string {
  const s = name.replace(/^\s*\([AB]\)\s*/i, '').trim();
  return s.length > 26 ? s.slice(0, 25).trimEnd() + '…' : s;
}

/** Category-themed SVG data URI for a menu item (suitable for menu_items.image_url). */
export function menuImageDataUri(catCode: string, name: string): string {
  const color = CAT_COLOR[catCode] ?? '#64748b';
  const glyph = CAT_GLYPH[catCode] ?? '🍽️';
  const label = xml(cleanLabel(name));
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 300'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'>` +
    `<stop offset='0' stop-color='${color}'/><stop offset='1' stop-color='${darken(color, 0.6)}'/>` +
    `</linearGradient></defs>` +
    `<rect width='400' height='300' fill='url(#g)'/>` +
    `<circle cx='200' cy='126' r='84' fill='#ffffff' fill-opacity='0.16'/>` +
    `<text x='200' y='126' font-size='92' text-anchor='middle' dominant-baseline='central'>${glyph}</text>` +
    `<rect x='0' y='236' width='400' height='64' fill='#0f172a' fill-opacity='0.45'/>` +
    `<text x='200' y='270' font-family='system-ui,-apple-system,Segoe UI,Roboto,sans-serif' font-size='21' font-weight='600' fill='#ffffff' text-anchor='middle'>${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
