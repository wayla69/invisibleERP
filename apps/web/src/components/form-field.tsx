'use client';

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';

/**
 * A labelled form-control wrapper: label (with an optional **required** marker), the control, and either a
 * muted **hint** or a destructive **error** line below. Standardises the `<div className="grid gap-2">
 * <Label/><Input/></div>` idiom repeated in every dialog and adds friendlier affordances (required `*`,
 * helper text, inline validation with `role="alert"`).
 *
 * Pass the control as `children` (an `<Input/>`, `<select>`, etc.). Wire `htmlFor` to the control's `id`.
 */
export function FormField({
  label,
  htmlFor,
  required,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  hint?: ReactNode;
  /** When set, replaces the hint and is announced to assistive tech. */
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('grid gap-2', className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="text-destructive" aria-hidden="true">
            *
          </span>
        )}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
