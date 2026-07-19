// Thai address block with postal-code-driven เขต/แขวง autofill (geo-ref audit follow-up). The user types a
// 5-digit รหัสไปรษณีย์ and picks the matching ตำบล/แขวง from a dropdown; the อำเภอ/เขต and จังหวัด then fill in
// automatically (one postal code usually spans several sub-districts). A "กรอกเอง" escape falls back to the
// free-text fields (province via the canonical <datalist>) for the rare code the dataset misses. Owns only the
// four geographic fields; the parent form keeps line1/line2/type. No 'use client': imported only by already-
// 'use client' address dialogs, so it inherits their boundary (mirrors province-input.tsx).
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { FormField } from '@/components/form-field';
import { Input } from '@/components/ui/input';
import { ProvinceInput } from '@/components/province-input';

export interface ThaiAddressValue {
  postal_code: string;
  sub_district: string;
  district: string;
  province: string;
}

interface Subdistrict {
  postalCode: string;
  provinceTh: string; provinceEn: string;
  districtTh: string; districtEn: string;
  subdistrictTh: string; subdistrictEn: string;
}

const SELECT_CLS =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export function ThaiAddressFields({
  value,
  onChange,
  className,
}: {
  value: ThaiAddressValue;
  onChange: (patch: Partial<ThaiAddressValue>) => void;
  className?: string;
}) {
  const { t, lang } = useLang();
  const [manual, setManual] = useState(false);
  const code = value.postal_code.trim();
  const isCode = /^\d{5}$/.test(code);

  const q = useQuery<{ matches: Subdistrict[] }>({
    queryKey: ['geo-postal', code],
    queryFn: () => api(`/api/geo/postal/${code}`),
    enabled: isCode && !manual,
    staleTime: Infinity,
  });
  const matches = q.data?.matches ?? [];
  const multiDistrict = useMemo(() => new Set(matches.map((m) => m.districtTh)).size > 1, [matches]);
  const usePicker = !manual && isCode && matches.length > 0;

  const selectedIdx = usePicker
    ? matches.findIndex((m) => m.subdistrictTh === value.sub_district && m.districtTh === value.district)
    : -1;
  const label = (m: Subdistrict) =>
    (lang === 'th' ? m.subdistrictTh : m.subdistrictEn) + (multiDistrict ? ` · ${lang === 'th' ? m.districtTh : m.districtEn}` : '');

  return (
    <div className={className ?? 'grid gap-4 sm:grid-cols-2'}>
      <FormField label={t('geo.postal')} className="sm:col-span-2" hint={t('geo.postal_hint')}>
        <Input
          inputMode="numeric"
          maxLength={5}
          value={value.postal_code}
          onChange={(e) => onChange({ postal_code: e.target.value.replace(/\D/g, '') })}
          placeholder="10230"
        />
      </FormField>

      {usePicker ? (
        <>
          <FormField label={t('geo.subdistrict')}>
            <select
              className={SELECT_CLS}
              value={selectedIdx >= 0 ? String(selectedIdx) : ''}
              onChange={(e) => {
                const m = matches[Number(e.target.value)];
                if (m) onChange({ sub_district: m.subdistrictTh, district: m.districtTh, province: m.provinceTh });
              }}
            >
              <option value="">{t('geo.subdistrict_ph')}</option>
              {matches.map((m, i) => (
                <option key={`${m.subdistrictTh}-${m.districtTh}-${i}`} value={i}>{label(m)}</option>
              ))}
            </select>
          </FormField>
          <FormField label={t('geo.district')}>
            <Input value={value.district} readOnly placeholder="—" />
          </FormField>
          <FormField label={t('geo.province')} className="sm:col-span-2">
            <div className="flex items-center gap-3">
              <Input value={value.province} readOnly placeholder="—" />
              <button type="button" className="shrink-0 text-xs text-primary hover:underline" onClick={() => setManual(true)}>
                {t('geo.manual')}
              </button>
            </div>
          </FormField>
        </>
      ) : (
        <>
          <FormField label={t('geo.subdistrict')}>
            <Input value={value.sub_district} onChange={(e) => onChange({ sub_district: e.target.value })} />
          </FormField>
          <FormField label={t('geo.district')}>
            <Input value={value.district} onChange={(e) => onChange({ district: e.target.value })} />
          </FormField>
          <FormField
            label={t('geo.province')}
            hint={isCode && !manual && matches.length === 0 && !q.isLoading ? t('geo.no_match') : undefined}
          >
            <ProvinceInput value={value.province} onChange={(v) => onChange({ province: v })} placeholder={t('geo.province_ph')} />
          </FormField>
          {manual && (
            <FormField label=" ">
              <button type="button" className="text-xs text-primary hover:underline" onClick={() => setManual(false)}>
                {t('geo.by_postal')}
              </button>
            </FormField>
          )}
        </>
      )}
    </div>
  );
}
