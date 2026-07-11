'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { GraduationCap, ShieldAlert, Plus, CalendarClock, BadgeCheck, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { notifySuccess, notifyError } from '@/lib/notify';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// HR-7 (docs/42, Wave 3) — training & certifications with the HR-07 mandatory-training / certification-
// compliance control. Reads gate hr/hr_admin/exec (own training also ess, own-scoped); writes hr/hr_admin.
// Completing a recert course mints a certification (expiry = completed_date + validity_months); a requires-score
// course cannot be completed without a score (SCORE_REQUIRED); the compliance tab lists expired/expiring certs.
export default function TrainingClient({ initialCourses }: { initialCourses?: any }) {
  const { t } = useLang();
  return (
    <div>
      <PageHeader title={t('hx.train.title')} description={t('hx.train.subtitle')} />
      <Tabs tabs={[
        { key: 'courses', label: t('hx.train.tab_courses'), content: <Courses initialCourses={initialCourses} /> },
        { key: 'sessions', label: t('hx.train.tab_sessions'), content: <Sessions /> },
        { key: 'certs', label: t('hx.train.tab_certs'), content: <Certifications /> },
      ]} />
    </div>
  );
}

function Courses({ initialCourses }: { initialCourses?: any }) {
  const { t } = useLang();
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['train-courses'], queryFn: () => api('/api/hcm/training/courses'), initialData: initialCourses });
  const [f, setF] = useState({ course_code: '', name: '', category: 'general', is_mandatory: false, requires_score: false, validity_months: '' });
  const add = useMutation({
    mutationFn: () => api('/api/hcm/training/courses', { method: 'POST', body: JSON.stringify({ course_code: f.course_code, name: f.name, category: f.category, is_mandatory: f.is_mandatory, requires_score: f.requires_score, validity_months: f.validity_months ? Number(f.validity_months) : undefined }) }),
    onSuccess: () => { notifySuccess(t('hx.train.course_saved')); setF({ course_code: '', name: '', category: 'general', is_mandatory: false, requires_score: false, validity_months: '' }); qc.invalidateQueries({ queryKey: ['train-courses'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.train.new_course')}</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.train.course_code')}</Label><Input value={f.course_code} onChange={(e) => setF({ ...f, course_code: e.target.value })} className="w-32" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.org.name')}</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="w-48" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.train.category')}</Label>
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {['safety', 'compliance', 'technical', 'general'].map((k) => <option key={k} value={k}>{t(`hx.train.cat_${k}`)}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5"><Label>{t('hx.train.validity_months')}</Label><Input type="number" value={f.validity_months} onChange={(e) => setF({ ...f, validity_months: e.target.value })} className="w-28" placeholder="12" /></div>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={f.is_mandatory} onChange={(e) => setF({ ...f, is_mandatory: e.target.checked })} /> {t('hx.train.is_mandatory')}</label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={f.requires_score} onChange={(e) => setF({ ...f, requires_score: e.target.checked })} /> {t('hx.train.requires_score')}</label>
        </div>
        <div><Button onClick={() => add.mutate()} disabled={!f.course_code || !f.name || add.isPending}><Plus className="size-4" /> {t('fin.save')}</Button></div>
      </Card>
      <StateView q={q}>{q.data && <DataTable rows={q.data.courses} columns={[
        { key: 'course_code', label: t('hx.train.course_code') }, { key: 'name', label: t('hx.org.name') },
        { key: 'category', label: t('hx.train.category'), render: (r: any) => t(`hx.train.cat_${r.category}`) },
        { key: 'is_mandatory', label: t('hx.train.mandatory'), render: (r: any) => r.is_mandatory ? <Badge variant="warning">{t('hx.train.mandatory')}</Badge> : '—' },
        { key: 'validity_months', label: t('hx.train.validity_months'), align: 'right', render: (r: any) => r.validity_months ?? '—' },
      ]} emptyState={{ icon: GraduationCap, title: t('hx.train.course_empty'), description: t('hx.train.new_course') }} />}</StateView>
    </div>
  );
}

function Sessions() {
  const { t } = useLang();
  const qc = useQueryClient();
  const sq = useQuery<any>({ queryKey: ['train-sessions'], queryFn: () => api('/api/hcm/training/sessions') });
  const eq_ = useQuery<any>({ queryKey: ['train-enrollments'], queryFn: () => api('/api/hcm/training/enrollments') });
  const [sf, setSf] = useState({ course_code: '', session_date: '', instructor: '', capacity: '' });
  const [ef, setEf] = useState({ session_id: '', emp_code: '' });
  const [cf, setCf] = useState<Record<number, string>>({});
  const addSession = useMutation({
    mutationFn: () => api('/api/hcm/training/sessions', { method: 'POST', body: JSON.stringify({ course_code: sf.course_code, session_date: sf.session_date || undefined, instructor: sf.instructor || undefined, capacity: sf.capacity ? Number(sf.capacity) : undefined }) }),
    onSuccess: () => { notifySuccess(t('hx.train.session_saved')); setSf({ course_code: '', session_date: '', instructor: '', capacity: '' }); qc.invalidateQueries({ queryKey: ['train-sessions'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const enroll = useMutation({
    mutationFn: () => api('/api/hcm/training/enrollments', { method: 'POST', body: JSON.stringify({ session_id: Number(ef.session_id), emp_code: ef.emp_code }) }),
    onSuccess: () => { notifySuccess(t('hx.train.enroll_saved')); setEf({ session_id: '', emp_code: '' }); qc.invalidateQueries({ queryKey: ['train-enrollments'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  const complete = useMutation({
    mutationFn: ({ id, score }: { id: number; score?: number }) => api(`/api/hcm/training/enrollments/${id}/complete`, { method: 'POST', body: JSON.stringify({ score }) }),
    onSuccess: (r: any) => { notifySuccess(r?.certification ? t('hx.train.cert_minted') : t('hx.common.update_status')); qc.invalidateQueries({ queryKey: ['train-enrollments'] }); qc.invalidateQueries({ queryKey: ['train-certs'] }); },
    onError: (e: any) => notifyError(e.message),
  });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.train.new_session')}</h3>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.train.course_code')}</Label><Input value={sf.course_code} onChange={(e) => setSf({ ...sf, course_code: e.target.value })} className="w-32" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.train.session_date')}</Label><Input type="date" value={sf.session_date} onChange={(e) => setSf({ ...sf, session_date: e.target.value })} className="w-40" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.train.instructor')}</Label><Input value={sf.instructor} onChange={(e) => setSf({ ...sf, instructor: e.target.value })} className="w-40" /></div>
          <div className="grid gap-1.5"><Label>{t('hx.train.capacity')}</Label><Input type="number" value={sf.capacity} onChange={(e) => setSf({ ...sf, capacity: e.target.value })} className="w-24" /></div>
        </div>
        <div><Button onClick={() => addSession.mutate()} disabled={!sf.course_code || addSession.isPending}><Plus className="size-4" /> {t('fin.save')}</Button></div>
      </Card>
      <StateView q={sq}>{sq.data && <DataTable rows={sq.data.sessions} columns={[
        { key: 'id', label: t('hx.train.session_id') },
        { key: 'course_code', label: t('hx.train.course_code'), render: (r: any) => r.course_code ?? '—' },
        { key: 'session_date', label: t('hx.train.session_date') },
        { key: 'instructor', label: t('hx.train.instructor'), render: (r: any) => r.instructor ?? '—' },
        { key: 'capacity', label: t('hx.train.capacity'), align: 'right', render: (r: any) => r.capacity ?? '—' },
      ]} emptyState={{ icon: CalendarClock, title: t('hx.train.session_empty'), description: t('hx.train.new_session') }} />}</StateView>

      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">{t('hx.train.new_enrollment')}</h3>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldAlert className="size-3.5" /> {t('hx.train.hr07_hint')}</p>
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.train.session_id')}</Label><Input type="number" value={ef.session_id} onChange={(e) => setEf({ ...ef, session_id: e.target.value })} className="w-24" /></div>
          <div className="grid gap-1.5"><Label>{t('hr.emp_code')}</Label><Input value={ef.emp_code} onChange={(e) => setEf({ ...ef, emp_code: e.target.value })} className="w-36" placeholder="EMP..." /></div>
        </div>
        <div><Button onClick={() => enroll.mutate()} disabled={!ef.session_id || !ef.emp_code || enroll.isPending}><Plus className="size-4" /> {t('hx.train.enroll_btn')}</Button></div>
      </Card>
      <StateView q={eq_}>{eq_.data && <DataTable rows={eq_.data.enrollments} columns={[
        { key: 'emp_code', label: t('hr.emp_code') },
        { key: 'course_code', label: t('hx.train.course_code'), render: (r: any) => r.course_code ?? '—' },
        { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'destructive' : 'muted'}>{t(`hx.train.st_${r.status}`)}</Badge> },
        { key: 'score', label: t('hx.train.score'), align: 'right', render: (r: any) => r.score ?? '—' },
        { key: 'actions', label: t('hx.common.actions'), render: (r: any) => (r.status === 'enrolled' || r.status === 'attended') ? (
          <div className="flex items-center gap-2">
            <Input type="number" value={cf[r.id] ?? ''} onChange={(e) => setCf({ ...cf, [r.id]: e.target.value })} className="w-20" placeholder={t('hx.train.score')} />
            <Button size="sm" variant="outline" onClick={() => complete.mutate({ id: r.id, score: cf[r.id] ? Number(cf[r.id]) : undefined })} disabled={complete.isPending}>{t('hx.train.complete_btn')}</Button>
          </div>
        ) : '—' },
      ]} emptyState={{ icon: BadgeCheck, title: t('hx.train.enroll_empty'), description: t('hx.train.new_enrollment') }} />}</StateView>
    </div>
  );
}

function Certifications() {
  const { t } = useLang();
  const [days, setDays] = useState('30');
  const cq = useQuery<any>({ queryKey: ['train-certs'], queryFn: () => api('/api/hcm/training/certifications') });
  const compQ = useQuery<any>({ queryKey: ['train-compliance', days], queryFn: () => api(`/api/hcm/training/compliance?days=${Number(days) || 30}`) });
  return (
    <div className="grid gap-5">
      <Card className="gap-3 p-5">
        <h3 className="flex items-center gap-1.5 text-base font-semibold"><AlertTriangle className="size-4 text-amber-500" /> {t('hx.train.compliance_title')}</h3>
        <p className="text-xs text-muted-foreground">{t('hx.train.compliance_hint')}</p>
        <div className="flex items-end gap-3">
          <div className="grid gap-1.5"><Label>{t('hx.train.window_days')}</Label><Input type="number" value={days} onChange={(e) => setDays(e.target.value)} className="w-24" /></div>
          {compQ.data && <div className="flex gap-3 pb-1 text-sm">
            <Badge variant="destructive">{t('hx.train.expired')}: {compQ.data.expired}</Badge>
            <Badge variant="warning">{t('hx.train.expiring')}: {compQ.data.expiring}</Badge>
          </div>}
        </div>
        <StateView q={compQ}>{compQ.data && <DataTable rows={compQ.data.items} columns={[
          { key: 'emp_code', label: t('hr.emp_code') },
          { key: 'cert_code', label: t('hx.train.cert_code') },
          { key: 'name', label: t('hx.org.name') },
          { key: 'expiry_date', label: t('hx.train.expiry_date') },
          { key: 'days_to_expiry', label: t('hx.train.days_to_expiry'), align: 'right' },
          { key: 'expired', label: t('fin.col_status'), render: (r: any) => <Badge variant={r.expired ? 'destructive' : 'warning'}>{r.expired ? t('hx.train.expired') : t('hx.train.expiring')}</Badge> },
        ]} emptyState={{ icon: BadgeCheck, title: t('hx.train.compliance_empty'), description: t('hx.train.compliance_hint') }} />}</StateView>
      </Card>
      <StateView q={cq}>{cq.data && <DataTable rows={cq.data.certifications} columns={[
        { key: 'emp_code', label: t('hr.emp_code') },
        { key: 'cert_code', label: t('hx.train.cert_code') },
        { key: 'name', label: t('hx.org.name') },
        { key: 'issued_date', label: t('hx.train.issued_date') },
        { key: 'expiry_date', label: t('hx.train.expiry_date'), render: (r: any) => r.expiry_date ?? t('hx.train.no_expiry') },
        { key: 'status', label: t('fin.col_status'), render: (r: any) => <Badge variant={r.status === 'active' ? 'success' : r.status === 'expired' ? 'destructive' : 'muted'}>{t(`hx.train.cst_${r.status}`)}</Badge> },
      ]} emptyState={{ icon: BadgeCheck, title: t('hx.train.cert_empty'), description: t('hx.train.compliance_hint') }} />}</StateView>
    </div>
  );
}
