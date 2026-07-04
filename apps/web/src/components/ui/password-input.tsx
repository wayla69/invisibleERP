'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Input } from './input';

// Password field with a show/hide (unmask) toggle so a user can verify what they typed. Forwards every
// native input prop to the underlying <Input>; the `type` is controlled internally by the toggle, so
// callers must NOT pass a `type`. The reveal state is local and never leaves the component.
function PasswordInput({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type'>) {
  const [show, setShow] = React.useState(false);
  return (
    <div className="relative">
      <Input
        {...props}
        type={show ? 'text' : 'password'}
        className={cn('pr-10', className)}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        disabled={props.disabled}
        tabIndex={-1}
        aria-pressed={show}
        aria-label={show ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
        title={show ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 absolute inset-y-0 right-0 flex items-center rounded-r-md px-3 outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50"
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export { PasswordInput };
