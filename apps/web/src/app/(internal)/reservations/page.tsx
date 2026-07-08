'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Users, Hourglass, BellRing, UserRound, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { num, thaiDate } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { ModulePage } from '@/components/module-page';
import { StatCard } from '@/components/stat-card';
import { DataTable } from '@/components/data-table';
import { FormField } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { notifySuccess, notifyError } from '@/lib/notify';

// B1 — table reservations + walk-in waitlist for a fine-casual house (buffet + à la carte in one venue).
// Book a table for a time or queue a walk-in; a booking carries its service mode (buffet may pre-pick a
// tier) and occasion; notify the guest (LINE/SMS) when ready; seat them; cancel / no-show. Linking a
// loyalty member unlocks the PDPA-consented guest dining profile (favourites / allergies / companions).
interface Resv {
  id: number; kind: string; table_id: number | null; reserved_for: string | null; party_size: number;
  customer_name: string | null; customer_phone: string | null; member_id: number | null; status: string;
  quoted_wait_min: number | null; notes: string | null; notified_at: string | null; created_at: string;
  service_mode: string; buffet_package_id: number | null; buffet_package_name: string | null; occasion: string | null;
}
interface Resp {
  reservations: Resv[]; count: number; waiting: number; booked: number;
  covers_pending: number; covers_buffet: number; covers_a_la_carte: number;
}
interface BuffetPkg { id: number; name: string }
interface Companion { id: number; name: string; relationship: string | null; allergies: string[]; preferences: string | null; notes: string | null }
interface GuestProfile {
  member_id: number; member_code: string; name: string | null; consent_granted: boolean;
  profile: {
    favorite_menus: string[]; favorite_ingredients: string[]; allergies: string[]; dietary: string | null;
    seating_preference: string | null; typical_party_size: number | null; service_notes: string | null;
  } | null;
  companions: Companion[];
  top_menus: { name: string; times: number }[];
  visit_stats: { visits: number; avg_party_size: number | null; last_visit: string | null } | null;
}

const STATUS: Record<string, { tone: 'success' | 'warning' | 'info' | 'muted' | 'destructive' }> = {
  booked: { tone: 'info' }, waiting: { tone: 'warning' }, ready: { tone: 'success' },
  seated: { tone: 'muted' }, cancelled: { tone: 'muted' }, no_show: { tone: 'destructive' },
};
const KNOWN_ACTIONS = ['notify', 'seat', 'cancel', 'no-show'];
const splitList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export default function ReservationsPage() {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<Resp>({ queryKey: ['reservations'], queryFn: () => api('/api/restaurant/reservations'), refetchInterval: 30_000 });
  const pkgsQ = useQuery<{ packages: BuffetPkg[] }>({ queryKey: ['buffet-packages'], queryFn: () => api('/api/restaurant/buffet/packages') });
  const d = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['reservations'] });

  const [kind, setKind] = useState<'reservation' | 'waitlist'>('waitlist');
  const [mode, setMode] = useState<'a_la_carte' | 'buffet'>('a_la_carte');
  const [form, setForm] = useState({ customer_name: '', customer_phone: '', party_size: '2', reserved_for: '', table_id: '', quoted_wait_min: '', buffet_package_id: '', occasion: '' });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  // linked loyalty member (by phone) → unlocks the guest-profile panel
  const [member, setMember] = useState<{ id: number; name: string | null } | null>(null);
  const [profileFor, setProfileFor] = useState<number | null>(null);

  const findMember = async () => {
    if (!form.customer_phone) return;
    try {
      const m: { id: number; name?: string | null } = await api(`/api/loyalty/members/lookup?phone=${encodeURIComponent(form.customer_phone)}`);
      setMember({ id: m.id, name: m.name ?? null });
      setProfileFor(m.id);
      if (!form.customer_name && m.name) set('customer_name', m.name);
    } catch { setMember(null); notifyError(t('px.resv_member_notfound')); }
  };

  const create = useMutation({
    mutationFn: () => api('/api/restaurant/reservations', { method: 'POST', body: JSON.stringify({
      kind,
      customer_name: form.customer_name || undefined,
      customer_phone: form.customer_phone || undefined,
      party_size: Number(form.party_size) || 2,
      reserved_for: kind === 'reservation' && form.reserved_for ? new Date(form.reserved_for).toISOString() : undefined,
      table_id: form.table_id ? Number(form.table_id) : undefined,
      quoted_wait_min: kind === 'waitlist' && form.quoted_wait_min ? Number(form.quoted_wait_min) : undefined,
      member_id: member?.id,
      service_mode: mode,
      buffet_package_id: mode === 'buffet' && form.buffet_package_id ? Number(form.buffet_package_id) : undefined,
      occasion: form.occasion || undefined,
    }) }),
    onSuccess: () => {
      notifySuccess(kind === 'waitlist' ? t('px.resv_added_queue') : t('px.resv_booked_ok'));
      setForm({ customer_name: '', customer_phone: '', party_size: '2', reserved_for: '', table_id: '', quoted_wait_min: '', buffet_package_id: '', occasion: '' });
      setMember(null); refresh();
    },
    onError: (e: any) => notifyError(e.message),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: number; action: string }) => api(`/api/restaurant/reservations/${id}/${action}`, { method: 'POST' }),
    onSuccess: (_r, v) => { notifySuccess(KNOWN_ACTIONS.includes(v.action) ? t(`px.resv_act_${v.action}`) : t('px.resv_updated')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  const open = (r: Resv) => ['booked', 'waiting', 'ready'].includes(r.status);

  return (
    <ModulePage
      title={t('px.resv_title')}
      description={t('px.resv_desc')}
      query={q}
      stats={d && (
        <>
          <StatCard label={t('px.resv_stat_waiting')} value={num(d.waiting)} icon={Hourglass} tone={d.waiting > 0 ? 'warning' : 'default'} />
          <StatCard label={t('px.resv_stat_booked')} value={num(d.booked)} icon={CalendarClock} tone="primary" />
          <StatCard label={t('px.resv_stat_covers')} value={num(d.covers_pending)} icon={Users} tone="default" hint={t('px.resv_stat_covers_hint', { b: num(d.covers_buffet ?? 0), a: num(d.covers_a_la_carte ?? 0) })} />
          <StatCard label={t('px.resv_stat_total')} value={num(d.count)} icon={BellRing} tone="default" />
        </>
      )}
      statsClassName="xl:grid-cols-4"
    >
      {/* create form */}
      <div className="mb-4 rounded-xl border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border p-0.5 text-sm">
            {(['waitlist', 'reservation'] as const).map((k) => (
              <button key={k} type="button" onClick={() => setKind(k)}
                className={`rounded-md px-3 py-1.5 font-medium transition-colors ${kind === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                {k === 'waitlist' ? t('px.resv_tab_waitlist') : t('px.resv_tab_reservation')}
              </button>
            ))}
          </div>
          {/* fine-casual: the same floor serves buffet and à-la-carte parties — book the mode up front */}
          <div className="inline-flex rounded-lg border p-0.5 text-sm">
            {(['a_la_carte', 'buffet'] as const).map((m) => (
              <button key={m} type="button" onClick={() => { setMode(m); if (m === 'a_la_carte') set('buffet_package_id', ''); }}
                className={`rounded-md px-3 py-1.5 font-medium transition-colors ${mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                {m === 'buffet' ? t('px.resv_mode_buffet') : t('px.resv_mode_alc')}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FormField label={t('px.resv_name')}><Input value={form.customer_name} onChange={(e) => set('customer_name', e.target.value)} placeholder={t('px.resv_name_ph')} /></FormField>
          <FormField label={t('px.resv_phone')}>
            <div className="flex gap-1.5">
              <Input value={form.customer_phone} onChange={(e) => { set('customer_phone', e.target.value); setMember(null); }} placeholder="08x-xxx-xxxx" />
              <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" onClick={findMember} title={t('px.resv_member_find')}><UserRound className="h-4 w-4" /></Button>
            </div>
          </FormField>
          <FormField label={t('px.resv_party')}><Input type="number" min={1} value={form.party_size} onChange={(e) => set('party_size', e.target.value)} /></FormField>
          <FormField label={t('px.resv_table')}><Input type="number" value={form.table_id} onChange={(e) => set('table_id', e.target.value)} placeholder={t('px.resv_table_ph')} /></FormField>
          {kind === 'reservation'
            ? <FormField label={t('px.resv_time')}><Input type="datetime-local" value={form.reserved_for} onChange={(e) => set('reserved_for', e.target.value)} /></FormField>
            : <FormField label={t('px.resv_wait_est')}><Input type="number" min={0} value={form.quoted_wait_min} onChange={(e) => set('quoted_wait_min', e.target.value)} placeholder="20" /></FormField>}
          {mode === 'buffet' && (
            <FormField label={t('px.resv_pkg')}>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.buffet_package_id} onChange={(e) => set('buffet_package_id', e.target.value)}>
                <option value="">{t('px.resv_pkg_none')}</option>
                {(pkgsQ.data?.packages ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </FormField>
          )}
          <FormField label={t('px.resv_occasion')}><Input value={form.occasion} onChange={(e) => set('occasion', e.target.value)} placeholder={t('px.resv_occasion_ph')} /></FormField>
          <div className="flex items-end gap-2">
            <Button disabled={create.isPending} onClick={() => create.mutate()}>{kind === 'waitlist' ? t('px.resv_queue_btn') : t('px.resv_book_btn')}</Button>
            {member && <Badge variant="outline" className="mb-2">{t('px.resv_member_linked', { name: member.name ?? `#${member.id}` })}</Badge>}
          </div>
        </div>
      </div>

      {/* PDPA-consented guest dining profile for the linked / selected member */}
      {profileFor != null && <GuestProfileCard memberId={profileFor} onClose={() => setProfileFor(null)} />}

      {d && (
        <DataTable
          rows={d.reservations}
          rowKey={(r) => r.id}
          emptyState={{ icon: CalendarClock, title: t('px.resv_empty_title'), description: t('px.resv_empty_desc') }}
          columns={[
            { key: 'kind', label: t('px.resv_col_kind'), render: (r) => (
              <div className="flex flex-wrap gap-1">
                <Badge variant="outline">{r.kind === 'waitlist' ? t('px.resv_kind_waitlist') : t('px.resv_kind_reservation')}</Badge>
                <Badge variant={r.service_mode === 'buffet' ? 'warning' : 'muted'}>{r.service_mode === 'buffet' ? (r.buffet_package_name || t('px.resv_mode_buffet')) : t('px.resv_mode_alc')}</Badge>
              </div>
            ) },
            { key: 'customer_name', label: t('fin.col_customer'), render: (r) => (
              <div>
                <div className="font-medium">{r.customer_name || '—'}</div>
                <div className="text-xs text-muted-foreground">{[r.customer_phone, r.occasion].filter(Boolean).join(' · ')}</div>
              </div>
            ) },
            { key: 'party_size', label: t('px.resv_col_party'), align: 'right', render: (r) => num(r.party_size) },
            { key: 'reserved_for', label: t('px.resv_col_time'), render: (r) => r.reserved_for ? thaiDate(r.reserved_for) : (r.quoted_wait_min != null ? t('px.resv_wait_min', { min: r.quoted_wait_min }) : '—') },
            { key: 'table_id', label: t('px.resv_col_table'), render: (r) => r.table_id ?? '—' },
            { key: 'status', label: t('fin.col_status'), render: (r) => <Badge variant={STATUS[r.status]?.tone ?? 'muted'}>{STATUS[r.status] ? t(`px.resv_st_${r.status}`) : r.status}</Badge> },
            { key: 'actions', label: '', align: 'right', render: (r) => (
              <div className="flex justify-end gap-1.5">
                {r.member_id != null && <Button size="sm" variant="ghost" onClick={() => setProfileFor(r.member_id)}>{t('px.resv_profile_btn')}</Button>}
                {open(r) && (
                  <>
                    {r.status !== 'ready' && <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: 'notify' })}>{t('px.resv_notify_btn')}</Button>}
                    <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: 'seat' })}>{t('px.resv_seat_btn')}</Button>
                    <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: r.kind === 'reservation' ? 'no-show' : 'cancel' })}>{r.kind === 'reservation' ? t('px.resv_noshow_btn') : t('px.resv_leave_btn')}</Button>
                  </>
                )}
              </div>
            ) },
          ]}
        />
      )}
    </ModulePage>
  );
}

// Guest dining profile (Michelin-style guest CRM) — everything here is PDPA consent-gated server-side:
// no granted 'dining_profile' consent ⇒ the API returns no preference data and rejects writes unless this
// save explicitly captures consent (the checkbox below, recorded in the member_consents ledger).
function GuestProfileCard({ memberId, onClose }: { memberId: number; onClose: () => void }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<GuestProfile>({ queryKey: ['guest-profile', memberId], queryFn: () => api(`/api/restaurant/guests/${memberId}/profile`) });
  const g = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['guest-profile', memberId] });

  const [consent, setConsent] = useState(false);
  const [f, setF] = useState({ favorite_menus: '', favorite_ingredients: '', allergies: '', dietary: '', seating_preference: '', typical_party_size: '', service_notes: '' });
  const [comp, setComp] = useState({ name: '', relationship: '', notes: '' });
  useEffect(() => {
    const p = g?.profile;
    setF({
      favorite_menus: (p?.favorite_menus ?? []).join(', '), favorite_ingredients: (p?.favorite_ingredients ?? []).join(', '),
      allergies: (p?.allergies ?? []).join(', '), dietary: p?.dietary ?? '', seating_preference: p?.seating_preference ?? '',
      typical_party_size: p?.typical_party_size != null ? String(p.typical_party_size) : '', service_notes: p?.service_notes ?? '',
    });
    setConsent(false);
  }, [g?.profile, g?.consent_granted]);
  const sf = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));

  const save = useMutation({
    mutationFn: () => api(`/api/restaurant/guests/${memberId}/profile`, { method: 'PUT', body: JSON.stringify({
      consent: consent || undefined,
      favorite_menus: splitList(f.favorite_menus), favorite_ingredients: splitList(f.favorite_ingredients),
      allergies: splitList(f.allergies), dietary: f.dietary || undefined,
      seating_preference: f.seating_preference || undefined,
      typical_party_size: f.typical_party_size ? Number(f.typical_party_size) : undefined,
      service_notes: f.service_notes || undefined,
    }) }),
    onSuccess: () => { notifySuccess(t('px.gp_saved')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const addComp = useMutation({
    mutationFn: () => api(`/api/restaurant/guests/${memberId}/companions`, { method: 'POST', body: JSON.stringify({
      name: comp.name, relationship: comp.relationship || undefined, notes: comp.notes || undefined,
    }) }),
    onSuccess: () => { notifySuccess(t('px.gp_comp_added')); setComp({ name: '', relationship: '', notes: '' }); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });
  const delComp = useMutation({
    mutationFn: (id: number) => api(`/api/restaurant/guests/${memberId}/companions/${id}`, { method: 'DELETE' }),
    onSuccess: () => { notifySuccess(t('px.gp_comp_removed')); refresh(); },
    onError: (e: any) => notifyError(e.message),
  });

  if (!g) return null;
  return (
    <div className="mb-4 rounded-xl border bg-card p-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 font-semibold"><UserRound className="h-4 w-4" />{t('px.gp_title')} — {g.name || g.member_code}</div>
          <p className="text-xs text-muted-foreground">{t('px.gp_desc')}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>✕</Button>
      </div>

      {!g.consent_granted && (
        <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-sm">{t('px.gp_consent_missing')}</div>
      )}
      {g.consent_granted && g.visit_stats && g.visit_stats.visits > 0 && (
        <p className="mb-2 text-xs text-muted-foreground">{t('px.gp_visits', { n: num(g.visit_stats.visits), avg: g.visit_stats.avg_party_size != null ? String(g.visit_stats.avg_party_size) : '—' })}</p>
      )}
      {g.consent_granted && g.top_menus.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">{t('px.gp_top_menus')}</div>
          <div className="flex flex-wrap gap-1">{g.top_menus.map((m) => <Badge key={m.name} variant="outline">{m.name} ×{m.times}</Badge>)}</div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <FormField label={t('px.gp_fav_menus')} hint={t('px.gp_comma_hint')}><Input value={f.favorite_menus} onChange={(e) => sf('favorite_menus', e.target.value)} /></FormField>
        <FormField label={t('px.gp_fav_ingredients')} hint={t('px.gp_comma_hint')}><Input value={f.favorite_ingredients} onChange={(e) => sf('favorite_ingredients', e.target.value)} /></FormField>
        <FormField label={t('px.gp_allergies')} hint={t('px.gp_comma_hint')}><Input value={f.allergies} onChange={(e) => sf('allergies', e.target.value)} /></FormField>
        <FormField label={t('px.gp_dietary')}><Input value={f.dietary} onChange={(e) => sf('dietary', e.target.value)} /></FormField>
        <FormField label={t('px.gp_seating')}><Input value={f.seating_preference} onChange={(e) => sf('seating_preference', e.target.value)} /></FormField>
        <FormField label={t('px.gp_party')}><Input type="number" min={1} value={f.typical_party_size} onChange={(e) => sf('typical_party_size', e.target.value)} /></FormField>
        <FormField label={t('px.gp_notes')} className="sm:col-span-2 lg:col-span-3"><Input value={f.service_notes} onChange={(e) => sf('service_notes', e.target.value)} /></FormField>
      </div>

      {!g.consent_granted && (
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span className="inline-flex items-center gap-1"><ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" />{t('px.gp_consent_check')}</span>
        </label>
      )}
      <div className="mt-3">
        <Button size="sm" disabled={save.isPending || (!g.consent_granted && !consent)} onClick={() => save.mutate()}>{t('px.gp_save')}</Button>
      </div>

      {g.consent_granted && (
        <div className="mt-4 border-t pt-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">{t('px.gp_companions')}</div>
          {g.companions.length > 0 && (
            <ul className="mb-2 space-y-1">
              {g.companions.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                  <span>
                    <span className="font-medium">{c.name}</span>
                    <span className="text-muted-foreground">{[c.relationship, c.preferences, c.notes].filter(Boolean).map((x) => ` · ${x}`).join('')}</span>
                  </span>
                  <Button size="sm" variant="ghost" disabled={delComp.isPending} onClick={() => delComp.mutate(c.id)} aria-label={t('px.gp_comp_removed')}><Trash2 className="h-3.5 w-3.5" /></Button>
                </li>
              ))}
            </ul>
          )}
          <div className="grid gap-2 sm:grid-cols-4">
            <Input placeholder={t('px.gp_comp_name')} value={comp.name} onChange={(e) => setComp((x) => ({ ...x, name: e.target.value }))} />
            <Input placeholder={t('px.gp_comp_rel')} value={comp.relationship} onChange={(e) => setComp((x) => ({ ...x, relationship: e.target.value }))} />
            <Input placeholder={t('px.gp_comp_notes')} value={comp.notes} onChange={(e) => setComp((x) => ({ ...x, notes: e.target.value }))} />
            <Button size="sm" variant="outline" disabled={!comp.name || addComp.isPending} onClick={() => addComp.mutate()}>{t('px.gp_comp_add')}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
