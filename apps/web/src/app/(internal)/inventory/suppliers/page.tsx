'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchX, Truck } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { ModulePage } from '@/components/module-page';
import { SearchInput } from '@/components/search-input';
import { DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';

interface Supplier { Supplier_ID: string; Supplier_Name?: string; Contact_Person?: string; Phone?: string; Payment_Terms?: string }

export default function SuppliersPage() {
  const { t } = useLang();
  const q = useQuery<{ suppliers: Supplier[] }>({ queryKey: ['suppliers'], queryFn: () => api('/api/inventory/suppliers') });
  const rows = q.data?.suppliers ?? [];
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) => [r.Supplier_ID, r.Supplier_Name, r.Contact_Person, r.Phone].some((v) => (v ?? '').toLowerCase().includes(term)));
  }, [rows, search]);

  return (
    <ModulePage
      title={t('inv.suppliers_title')}
      description={t('inv.suppliers_subtitle')}
      query={q}
      toolbar={
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t('inv.suppliers_search_ph')}
          ariaLabel={t('inv.suppliers_search_aria')}
          count={
            q.data
              ? (search && filtered.length !== rows.length
                  ? t('inv.suppliers_count_of', { n: num(filtered.length), total: num(rows.length) })
                  : t('inv.suppliers_count', { n: num(filtered.length) }))
              : undefined
          }
        />
      }
    >
      {q.data && (
        <DataTable
          rows={filtered}
          rowKey={(r) => r.Supplier_ID}
          emptyState={
            search
              ? {
                  icon: SearchX,
                  title: t('inv.no_match_suppliers'),
                  description: t('inv.no_match_desc'),
                  action: (
                    <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                      {t('inv.clear_filter')}
                    </Button>
                  ),
                }
              : { icon: Truck, title: t('inv.suppliers_empty_title'), description: t('inv.suppliers_empty_desc') }
          }
          columns={[
            { key: 'Supplier_ID', label: t('inv.col_code') },
            { key: 'Supplier_Name', label: t('inv.col_name2'), render: (r) => r.Supplier_Name || '—' },
            { key: 'Contact_Person', label: t('inv.col_contact'), render: (r) => r.Contact_Person || '—' },
            { key: 'Phone', label: t('inv.col_phone'), render: (r) => r.Phone || '—' },
            { key: 'Payment_Terms', label: t('inv.col_terms'), render: (r) => r.Payment_Terms || '—' },
          ]}
        />
      )}
    </ModulePage>
  );
}
