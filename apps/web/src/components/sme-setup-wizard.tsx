// SME first-run setup wizard (docs/49 v1.3, item 4) — a short guided flow that appears ONCE for a
// control_profile='sme' tenant whose setup is incomplete, walking the solo owner from a fresh company to a
// productive state in a few minutes: (1) what "SME mode" means, (2) the load-bearing company/tax identity
// (the four fields behind `setup_complete`), (3) the remaining first-run checklist + finish.
//
// NO 'use client' directive on purpose: this island is imported only from app-shell.tsx (already a client
// file), so it inherits the client boundary — adding the directive would trip the check-use-client ratchet
// (same pattern as sme-reason-dialog.tsx / getting-started.tsx).
import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Building2, CheckCircle2, Circle, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { useLang } from '@/lib/i18n';
import { notifyError } from '@/lib/notify';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface OnboardingStatus {
  steps: { key: string; label_th: string; done: boolean }[];
  done: number; total: number; percent: number; complete: boolean; next: string | null;
}
interface TenantProfile {
  legal_name: string | null; tax_id: string | null; address_line1: string | null; province: string | null;
  pending_change?: { req_no: string; fields: string[] };
}

// Client-side format check for the one strictly-formatted field (mirrors setup/page.tsx validate()).
const taxIdOk = (v: string) => !v.trim() || /^\d{13}$/.test(v.trim());

export function SmeSetupWizard() {
  const { t } = useLang();
  const qc = useQueryClient();
  const me = useMe();
  const isSme = me.data?.control_profile === 'sme';

  const prefs = useQuery<{ sme_wizard_done?: boolean }>({
    queryKey: ['user-prefs'], queryFn: () => api('/api/user-prefs'), enabled: isSme,
  });
  const onboarding = useQuery<OnboardingStatus>({
    queryKey: ['onboarding-status'], queryFn: () => api('/api/tenant/onboarding-status'), enabled: isSme,
  });

  const dismissed = prefs.data?.sme_wizard_done === true;
  const setupIncomplete = onboarding.data ? !onboarding.data.complete : false;
  // Show ONCE: an SME tenant that hasn't dismissed the wizard AND still has an incomplete checklist.
  const shouldShow = isSme && !dismissed && setupIncomplete && !!onboarding.data;

  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState(0);
  const [form, setForm] = React.useState({ legal_name: '', tax_id: '', address_line1: '', province: '' });
  const [seeded, setSeeded] = React.useState(false);

  // Open automatically the first time the gate turns true; seed the form from any values already on file.
  React.useEffect(() => {
    if (shouldShow && !open && !seeded) { setOpen(true); setSeeded(true); }
  }, [shouldShow, open, seeded]);
  React.useEffect(() => {
    if (open && onboarding.data && !form.legal_name && !form.tax_id) {
      // Prefill from the current profile so an owner who partly filled it doesn't retype.
      api<TenantProfile>('/api/tenant/profile').then((p) => setForm((f) => ({
        legal_name: f.legal_name || p.legal_name || '', tax_id: f.tax_id || p.tax_id || '',
        address_line1: f.address_line1 || p.address_line1 || '', province: f.province || p.province || '',
      }))).catch(() => { /* keep blank */ });
    }
  }, [open, onboarding.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const markDone = useMutation({
    mutationFn: () => api('/api/user-prefs', { method: 'PUT', body: JSON.stringify({ sme_wizard_done: true }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['user-prefs'] }); setOpen(false); },
  });

  // Save the company/tax identity. tax_id is a G15 maker-checker field: setting it returns a staged
  // `pending_change` — for an SME company we immediately self-approve it (allowed, evidence-logged via
  // SME-01) with a setup reason, so the wizard completes without a second person.
  const saveProfile = useMutation({
    mutationFn: async () => {
      const res = await api<TenantProfile>('/api/tenant/profile', { method: 'PATCH', body: JSON.stringify(form) });
      if (res.pending_change?.req_no) {
        await api(`/api/tenant/profile-approvals/${res.pending_change.req_no}/approve`, {
          method: 'POST', body: JSON.stringify({ self_approval_reason: t('sme.wizard_setup_reason') }),
        });
      }
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['onboarding-status'] });
      qc.invalidateQueries({ queryKey: ['tenant-profile'] });
      setStep(2);
    },
    onError: (e: any) => notifyError(e?.message ?? String(e)),
  });

  const starterPack = useMutation({
    mutationFn: () => api('/api/tenant/starter-pack', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['onboarding-status'] }),
    onError: (e: any) => notifyError(e?.message ?? String(e)),
  });

  if (!shouldShow && !open) return null;

  const identityValid = form.legal_name.trim() && taxIdOk(form.tax_id) && form.address_line1.trim() && form.province.trim();

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) markDone.mutate(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BadgeCheck className="size-5 text-sky-600 dark:text-sky-400" />
            {t('sme.wizard_title')}
          </DialogTitle>
          <DialogDescription>{t('sme.wizard_step_of', { n: step + 1, total: 3 })}</DialogDescription>
        </DialogHeader>

        {step === 0 && (
          <div className="space-y-3 text-sm">
            <p className="flex items-start gap-2"><Sparkles className="mt-0.5 size-4 shrink-0 text-sky-500" /><span>{t('sme.wizard_welcome_1')}</span></p>
            <p className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-sky-500" /><span>{t('sme.wizard_welcome_2')}</span></p>
            <p className="flex items-start gap-2"><Building2 className="mt-0.5 size-4 shrink-0 text-sky-500" /><span>{t('sme.wizard_welcome_3')}</span></p>
          </div>
        )}

        {step === 1 && (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">{t('sme.wizard_identity_desc')}</p>
            <div className="grid gap-1"><Label>{t('mx.setup_f_legal_name')}</Label>
              <Input value={form.legal_name} onChange={(e) => setForm({ ...form, legal_name: e.target.value })} placeholder={t('sme.wizard_legal_ph')} /></div>
            <div className="grid gap-1"><Label>{t('mx.setup_f_tax_id')}</Label>
              <Input value={form.tax_id} onChange={(e) => setForm({ ...form, tax_id: e.target.value })} placeholder="0-0000-00000-00-0" inputMode="numeric" />
              {!taxIdOk(form.tax_id) && <p className="text-xs text-destructive">{t('mx.setup_err_tax_id')}</p>}</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1"><Label>{t('mx.setup_f_address1')}</Label>
                <Input value={form.address_line1} onChange={(e) => setForm({ ...form, address_line1: e.target.value })} /></div>
              <div className="grid gap-1"><Label>{t('mx.setup_f_province')}</Label>
                <Input value={form.province} onChange={(e) => setForm({ ...form, province: e.target.value })} /></div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{t('sme.wizard_next_desc')}</p>
            <ul className="space-y-2">
              {(onboarding.data?.steps ?? []).map((s) => (
                <li key={s.key} className="flex items-center gap-2">
                  {s.done ? <CheckCircle2 className="size-4 shrink-0 text-emerald-500" /> : <Circle className="size-4 shrink-0 text-muted-foreground" />}
                  <span className={s.done ? 'text-muted-foreground line-through' : ''}>{s.label_th}</span>
                  {s.key === 'branch' && !s.done && (
                    <Button size="sm" variant="outline" className="ml-auto" onClick={() => starterPack.mutate()} disabled={starterPack.isPending}>
                      {starterPack.isPending ? <Loader2 className="size-3.5 animate-spin" /> : t('sme.wizard_create_hq')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <Button variant="ghost" size="sm" onClick={() => markDone.mutate()} disabled={markDone.isPending}>{t('sme.wizard_skip')}</Button>
          <div className="flex gap-2">
            {step > 0 && <Button variant="outline" onClick={() => setStep(step - 1)}>{t('sme.wizard_back')}</Button>}
            {step === 0 && <Button onClick={() => setStep(1)}>{t('sme.wizard_start')}</Button>}
            {step === 1 && (
              <Button onClick={() => saveProfile.mutate()} disabled={!identityValid || saveProfile.isPending}>
                {saveProfile.isPending ? <Loader2 className="size-4 animate-spin" /> : t('sme.wizard_save_next')}
              </Button>
            )}
            {step === 2 && <Button onClick={() => markDone.mutate()} disabled={markDone.isPending}>{t('sme.wizard_finish')}</Button>}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
