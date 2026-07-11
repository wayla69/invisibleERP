import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLang } from '@/lib/i18n';

export type PromptField = { key: string; label: string; default?: string; min?: number; max?: number; integer?: boolean };

/**
 * Validated numeric-input dialog — replaces `window.prompt()` + `Number()` for money / quantity inputs so a
 * non-numeric (or out-of-range) entry can never silently POST `NaN` as an amount. Confirm stays disabled
 * until every field parses to a finite number within its min/max (and integer, if required).
 *
 * NO 'use client' directive on purpose — it inherits the importing page's client boundary (docs/28 §4
 * ratchet pattern, same as confirm-dialog.tsx / state-view.tsx). Mount it when open (e.g.
 * `{pending && <NumberPromptDialog … onClose={() => setPending(null)} />}`).
 */
export function NumberPromptDialog({
  title, description, fields, confirmLabel, busy, onConfirm, onClose,
}: {
  title: ReactNode;
  description?: ReactNode;
  fields: PromptField[];
  confirmLabel?: ReactNode;
  busy?: boolean;
  /** Called with an accessor that returns each field's validated number (guaranteed finite + in range). */
  onConfirm: (get: (key: string) => number) => void;
  onClose: () => void;
}) {
  const { t } = useLang();
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.default ?? ''])));

  const parsed: Record<string, number> = {};
  let valid = true;
  for (const f of fields) {
    const raw = (vals[f.key] ?? '').trim();
    const num = Number(raw);
    const ok = raw !== '' && Number.isFinite(num)
      && (f.min == null || num >= f.min) && (f.max == null || num <= f.max)
      && (!f.integer || Number.isInteger(num));
    if (ok) parsed[f.key] = num; else valid = false;
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-3">
          {fields.map((f, i) => (
            <div key={f.key} className="grid gap-2">
              <Label htmlFor={`npd-${f.key}`}>{f.label}</Label>
              <Input
                id={`npd-${f.key}`}
                type="number"
                inputMode="decimal"
                min={f.min}
                max={f.max}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus={i === 0}
                value={vals[f.key] ?? ''}
                onChange={(e) => setVals((p) => ({ ...p, [f.key]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t('fin.cancel')}</Button>
          <Button disabled={!valid || busy} onClick={() => onConfirm((k) => parsed[k] ?? 0)}>{confirmLabel ?? t('mx.cfm_confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
