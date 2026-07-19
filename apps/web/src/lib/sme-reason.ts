// SME self-approval reason bridge (docs/49 H2). Plain module — NO React — so `lib/api.ts` can import
// `requestSmeReason` without pulling a component into the API client. The `SmeReasonDialog` component
// (components/sme-reason-dialog.tsx, mounted once in AppShell) registers itself here as the host; when a
// mutation hits 400 SELF_APPROVAL_REASON_REQUIRED, api() awaits this function, which shows the dialog and
// resolves with the typed reason (or null on cancel). Pages that never mount AppShell (portal/diner) have
// no host registered, so we FALL BACK to the legacy window.prompt behaviour — the retry flow is identical.

import { ts } from './i18n-static';

export type SmeReasonHost = (serverMsg: string) => Promise<string | null>;

let host: SmeReasonHost | null = null;

/** Called by the dialog component on mount. Returns nothing; pair with unregisterSmeReasonHost on unmount. */
export function registerSmeReasonHost(h: SmeReasonHost): void {
  host = h;
}

/** Unregister only if `h` is still the active host (a newer mount must not be clobbered by an old unmount). */
export function unregisterSmeReasonHost(h: SmeReasonHost): void {
  if (host === h) host = null;
}

/**
 * Ask the user for a self-approval justification. Dialog-hosted when AppShell is mounted; otherwise the
 * legacy window.prompt fallback. Resolves the trimmed reason, or null when cancelled/empty.
 */
export function requestSmeReason(serverMsg: string): Promise<string | null> {
  if (host) return host(serverMsg);
  if (typeof window === 'undefined') return Promise.resolve(null);
  const answer = window.prompt(`${serverMsg}\n\n${ts('err.sme_reason_prompt')}`);
  const reason = (answer ?? '').trim();
  return Promise.resolve(reason || null);
}
