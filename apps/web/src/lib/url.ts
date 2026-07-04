/**
 * Read a query-string parameter from the current URL, client-side only. Used to seed a page's search/filter
 * box from a deep-link (e.g. the ⌘K spotlight linking to `/pos?q=SALE-123` so the list opens pre-filtered to
 * that record). Safe during SSR (returns '' when `window` is absent) and never throws.
 *
 * Only use this for non-sensitive params (`q`, `tab`, …). Reading sensitive-named params (`token`, `code`,
 * `id_token`, …) from the URL is flagged by CodeQL `js/sensitive-get-query` — don't.
 */
export function readQueryParam(key: string): string {
  if (typeof window === 'undefined') return '';
  try {
    return new URLSearchParams(window.location.search).get(key) ?? '';
  } catch {
    return '';
  }
}
