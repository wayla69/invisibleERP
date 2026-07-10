// FIN-3 (BUD-02) — budget-availability chip for the PR/PO approval surfaces. Asks the server to evaluate
// the document exactly as the approval gate will (`GET /api/budget/availability?doc_type=&doc_no=`) and
// renders a compact chip: hidden when the tenant's budget-control policy is 'off' (the default) or the doc
// has no gate-relevant lines; green when the spend fits the available budget; red when it would exceed it.
// NB: no 'use client' here — this island is only imported by already-'use client' pages (approvals surfaces),
// so it inherits the boundary (keeps the check-use-client ratchet flat; pattern: components/state-view.tsx).
import { useQuery } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { baht } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { Badge } from '@/components/ui/badge';

export interface BudgetCheck {
  account_code: string; period: string; has_budget: boolean;
  budget_ytd: number; actual_ytd: number; open_commitments: number; available: number;
  doc_amount: number; exceeded: boolean;
}
export interface BudgetPreview { policy: 'off' | 'advise' | 'warn' | 'block'; checks: BudgetCheck[]; exceeded: boolean }

export function BudgetChip({ docType, docNo, enabled = true }: { docType: 'PR' | 'PO'; docNo: string; enabled?: boolean }) {
  const { t } = useLang();
  const q = useQuery<BudgetPreview>({
    queryKey: ['budget-availability', docType, docNo],
    queryFn: () => api(`/api/budget/availability?doc_type=${docType}&doc_no=${encodeURIComponent(docNo)}`),
    enabled,
    staleTime: 30_000,
    retry: false, // a viewer without the availability duty just sees no chip
  });
  const d = q.data;
  if (!d || d.policy === 'off' || !d.checks.length) return null;
  const gated = d.checks.filter((c) => c.has_budget);
  if (!gated.length) return <Badge variant="secondary" title={t('pb.bctl_chip_no_budget_hint')}><Wallet className="size-3" /> {t('pb.bctl_chip_no_budget')}</Badge>;
  const worst = gated.reduce((a, c) => ((c.available - c.doc_amount) < (a.available - a.doc_amount) ? c : a));
  const detail = gated.map((c) => `${c.account_code}: ${t('pb.bctl_chip_available')} ${baht(c.available)} · ${t('pb.bctl_chip_doc')} ${baht(c.doc_amount)}`).join(' | ');
  return (
    <Badge variant={d.exceeded ? 'destructive' : 'success'} title={detail}>
      <Wallet className="size-3" /> {d.exceeded
        ? t('pb.bctl_chip_over', { amt: baht(Math.max(0, worst.doc_amount - Math.max(0, worst.available))) })
        : t('pb.bctl_chip_ok', { amt: baht(worst.available) })}
    </Badge>
  );
}

// Shared decide-error handler for the approval surfaces: turns the gate's machine-readable rejections into
// the confirm/override interaction (warn → confirm dialog; block → exec override reason prompt). Returns the
// extra body fields to retry the approval with, or null when the user backed out / the error isn't the gate's.
export function budgetRetryFields(err: unknown, msgs: { confirm: string; overridePrompt: string }): Record<string, unknown> | null {
  const code = (err as { code?: string })?.code;
  if (code === 'BUDGET_CONFIRM_REQUIRED') {
    return window.confirm(msgs.confirm) ? { confirm_over_budget: true } : null;
  }
  if (code === 'BUDGET_EXCEEDED') {
    const reason = window.prompt(msgs.overridePrompt);
    return reason && reason.trim() ? { override_budget: true, override_reason: reason.trim() } : null;
  }
  return null;
}
