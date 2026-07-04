'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { DataTable } from '@/components/data-table';
import { StateView } from '@/components/state-view';
import { Msg } from '@/components/tabs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';

export default function MyUsersPage() {
  const qc = useQueryClient();
  const list = useQuery<any>({ queryKey: ['my-users'], queryFn: () => api('/api/portal/my/users') });
  const [f, setF] = useState({ username: '', password: '' });
  const [msg, setMsg] = useState('');

  const create = useMutation({
    mutationFn: () => api('/api/portal/my/users', { method: 'POST', body: JSON.stringify({ username: f.username, password: f.password }) }),
    onSuccess: () => { setMsg(`✅ สร้างพนักงาน ${f.username}`); setF({ username: '', password: '' }); qc.invalidateQueries({ queryKey: ['my-users'] }); },
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });
  const del = useMutation({
    mutationFn: (u: string) => api(`/api/portal/my/users/${u}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-users'] }),
    onError: (e: any) => setMsg(`❌ ${e.message}`),
  });

  return (
    <div className="space-y-4">
      <PageHeader title="พนักงานของฉัน (My Users)" description="สร้างบัญชีให้พนักงานในร้านของคุณ" />
      <Card className="gap-3 p-5">
        <h3 className="text-base font-semibold">เพิ่มพนักงาน</h3>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="grid gap-1.5"><Label>Username</Label><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>Password</Label><PasswordInput value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
          <div className="flex items-end"><Button disabled={!f.username || f.password.length < 6 || create.isPending} onClick={() => create.mutate()}><UserPlus className="size-4" /> สร้างบัญชี</Button></div>
        </div>
        <Msg ok={msg.startsWith('✅')}>{msg}</Msg>
      </Card>
      <StateView q={list}>
        {list.data && (
          <DataTable
            rows={list.data.users}
            columns={[
              { key: 'username', label: 'Username' },
              { key: 'role', label: 'Role' },
              { key: 'del', label: '', render: (r: any) => <Button size="sm" variant="destructive" disabled={del.isPending} onClick={() => del.mutate(r.username)}>ลบ</Button> },
            ]}
            emptyText="ยังไม่มีพนักงาน"
          />
        )}
      </StateView>
    </div>
  );
}
