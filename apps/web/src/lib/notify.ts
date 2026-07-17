import { toast } from 'sonner';
import { ts } from './i18n-static';

/**
 * Standard action-feedback toasts. Sonner's `<Toaster richColors position="top-right" />` is already
 * mounted in `app/layout.tsx`, so these render consistent, non-blocking, auto-dismissing toasts.
 *
 * Use these for the **result of a user action** (save, sync, approve, reject) instead of the inline
 * `<Msg>` banner — feedback no longer shifts the page and is visible even after a dialog closes. Keep
 * inline `<Msg>`/field text for **field-level validation** that must stay next to the input.
 *
 * Pass the human message WITHOUT the old "✅ /❌" emoji prefix — richColors conveys success/error.
 */
export const notifySuccess = (message: string, description?: string) => toast.success(message, { description });
export const notifyError = (message: string, description?: string) => toast.error(message, { description });
export const notifyInfo = (message: string, description?: string) => toast(message, { description });

/** Bridge a thrown Error (our API wraps as `{ error: { message } }`) to an error toast. */
export const notifyFromError = (e: unknown, fallback?: string) =>
  notifyError((e as Error)?.message || fallback || ts('err.generic'));
