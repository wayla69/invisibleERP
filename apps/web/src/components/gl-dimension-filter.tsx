// FIN-7a — GL reporting dimension filter (project / department / branch / cost centre) over the in-use
// dimension values (`GET /api/ledger/dimensions`). Shared by the trial-balance / GL-detail / P&L islands.
// NB: intentionally NO 'use client' directive — this component is only imported by pages that are already
// client islands, so it inherits the boundary (see `state-view.tsx`; adding the directive would trip the
// check-use-client ratchet for no reason).
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/form-controls';

export type GlDims = { project: string; dept: string; branch: string; cc: string };
export const emptyGlDims = (): GlDims => ({ project: '', dept: '', branch: '', cc: '' });

/** Query-string fragment (leading '&') for the selected dimensions — '' when nothing is selected. */
export function glDimQuery(d: GlDims): string {
  return (
    (d.cc ? `&cost_center=${encodeURIComponent(d.cc)}` : '') +
    (d.project ? `&project_id=${encodeURIComponent(d.project)}` : '') +
    (d.dept ? `&dept_id=${encodeURIComponent(d.dept)}` : '') +
    (d.branch ? `&branch_id=${encodeURIComponent(d.branch)}` : '')
  );
}

type DimRow = { id: number; code: string | null; name: string | null };

export function GlDimensionFilter({
  dims,
  onChange,
  idPrefix,
  showCostCenter = true,
}: {
  dims: GlDims;
  onChange: (d: GlDims) => void;
  idPrefix: string;
  /** account-ledger has no cost_center param — its filter hides the cost-centre select. */
  showCostCenter?: boolean;
}) {
  const { t } = useLang();
  const q = useQuery<{ cost_centers: string[]; branches: DimRow[]; projects: DimRow[]; departments: DimRow[] }>({
    queryKey: ['gl-dimensions'],
    queryFn: () => api('/api/ledger/dimensions'),
  });
  const d = q.data;
  const label = (r: DimRow) => (r.code ? `${r.code}${r.name ? ` · ${r.name}` : ''}` : r.name ?? `#${r.id}`);
  const pick = (key: keyof GlDims, title: string, id: string, options: ReactNode) => (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{title}</Label>
      <Select id={id} className="min-w-[150px]" value={dims[key]} onChange={(e) => onChange({ ...dims, [key]: e.target.value })}>
        <option value="">{t('acct.dim_all')}</option>
        {options}
      </Select>
    </div>
  );
  return (
    <>
      {pick('project', t('acct.dim_project'), `${idPrefix}-dim-project`, (d?.projects ?? []).map((r) => <option key={r.id} value={String(r.id)}>{label(r)}</option>))}
      {pick('dept', t('acct.dim_dept'), `${idPrefix}-dim-dept`, (d?.departments ?? []).map((r) => <option key={r.id} value={String(r.id)}>{label(r)}</option>))}
      {pick('branch', t('acct.dim_branch'), `${idPrefix}-dim-branch`, (d?.branches ?? []).map((r) => <option key={r.id} value={String(r.id)}>{label(r)}</option>))}
      {showCostCenter &&
        pick('cc', t('acct.dim_cc'), `${idPrefix}-dim-cc`, (d?.cost_centers ?? []).map((c) => <option key={c} value={c}>{c}</option>))}
    </>
  );
}
