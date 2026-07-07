// Thai province autocomplete (master-data audit Phase 7). A text input backed by a <datalist> of the 77
// canonical provinces (GET /api/geo/provinces), so a user picks the canonical name instead of free-typing a
// variant. The server still normalises on save — this is the convenience/steering layer. No 'use client':
// imported only by already-'use client' pages (address dialogs), inherits their boundary.
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';

interface Province { th: string; en: string }

export function ProvinceInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const q = useQuery<{ provinces: Province[] }>({ queryKey: ['geo-provinces'], queryFn: () => api('/api/geo/provinces'), staleTime: Infinity });
  return (
    <>
      <Input list="th-provinces-list" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      <datalist id="th-provinces-list">
        {(q.data?.provinces ?? []).map((p) => <option key={p.th} value={p.th}>{p.en}</option>)}
      </datalist>
    </>
  );
}
