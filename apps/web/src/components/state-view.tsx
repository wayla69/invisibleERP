import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useLang } from '@/lib/i18n';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';

/** Loading / error / content gate. Skeleton while loading, Alert on error. */
export function StateView({
  q,
  children,
  skeleton,
  className,
}: {
  q: { isLoading: boolean; error: unknown };
  children: ReactNode;
  skeleton?: ReactNode;
  className?: string;
}) {
  const { t } = useLang();
  if (q.isLoading) {
    return (
      <div className={className}>
        {skeleton ?? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        )}
      </div>
    );
  }
  if (q.error) {
    return (
      <Alert variant="destructive" className={cn('max-w-2xl', className)}>
        <AlertCircle />
        <AlertTitle>{t('mx.stv_error')}</AlertTitle>
        <AlertDescription>{String((q.error as Error)?.message ?? q.error)}</AlertDescription>
      </Alert>
    );
  }
  return <>{children}</>;
}
