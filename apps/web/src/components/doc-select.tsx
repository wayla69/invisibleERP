import { useState } from 'react';
import { PencilLine, ListChecks } from 'lucide-react';
import { useLang } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';

// Canonical "pick a referenced document" dropdown (docs/39): every screen that used to make the user
// TYPE another document's number (PO on a GR, invoice on a receipt, original doc on a credit note, …)
// renders this instead, fed by the module's pending-list GET. Same Radix Select the GrForm PO picker
// established; NO 'use client' — it inherits the importing page's client boundary (use-client ratchet).
export interface DocOption {
  value: string;
  /** Optional human context rendered after the number, e.g. supplier or amount. */
  label?: string;
}

const MANUAL = '__manual__';

export function DocSelect({ id, value, onValueChange, options, placeholder, emptyText, invalid, className, disabled, allowManual, manualPlaceholder }: {
  id?: string;
  value: string;
  onValueChange: (v: string) => void;
  options: DocOption[];
  placeholder: string;
  /** Shown inside the open list when there is nothing pending. */
  emptyText: string;
  invalid?: boolean;
  className?: string;
  disabled?: boolean;
  /** Escape hatch for docs outside the pending list (or when the list GET is not permitted to this role). */
  allowManual?: boolean;
  manualPlaceholder?: string;
}) {
  const { t } = useLang();
  const [manual, setManual] = useState(false);

  if (allowManual && manual) {
    return (
      <div className={`flex gap-1 ${className ?? 'w-full'}`}>
        <Input id={id} value={value} aria-invalid={invalid} placeholder={manualPlaceholder ?? placeholder} onChange={(e) => onValueChange(e.target.value)} />
        <Button type="button" variant="ghost" size="icon" title={t('common.doc_back_to_list')} aria-label={t('common.doc_back_to_list')} onClick={() => { setManual(false); onValueChange(''); }}>
          <ListChecks className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <Select
      value={value || undefined}
      onValueChange={(v) => {
        if (v === MANUAL) { setManual(true); onValueChange(''); return; }
        onValueChange(v);
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} className={className ?? 'w-full'} aria-invalid={invalid}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.length === 0 && <div className="px-2 py-1.5 text-sm text-muted-foreground">{emptyText}</div>}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label ? `${o.value} — ${o.label}` : o.value}
          </SelectItem>
        ))}
        {allowManual && (
          <SelectItem value={MANUAL}>
            <span className="flex items-center gap-1.5 text-muted-foreground"><PencilLine className="size-3.5" /> {t('common.doc_manual')}</span>
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}
