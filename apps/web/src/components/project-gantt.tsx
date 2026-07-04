'use client';

import { cn } from '@/lib/utils';
import { useLang } from '@/lib/i18n';

export type GanttTask = {
  id: number;
  name: string;
  es: number;
  ef: number;
  duration_days: number;
  slack: number;
  on_critical_path: boolean;
  pct_complete: number;
  status: string;
  assignee?: string | null;
  depends_on: number[];
};

/**
 * Dependency-aware Gantt built on the CPM schedule (early start/finish in day-offsets). No external Gantt
 * library — a CSS grid track per task, the bar positioned by es→ef across the project duration, the
 * critical path in primary, slack tasks in a calmer tone, and an inner fill for % complete. Sleek + native
 * to the design tokens.
 */
export function ProjectGantt({ tasks, totalDays }: { tasks: GanttTask[]; totalDays: number }) {
  const { t } = useLang();
  const span = Math.max(1, totalDays);
  // Month-ish gridlines every ~ceil(span/8) days so a long plan stays readable.
  const step = Math.max(1, Math.ceil(span / 8));
  const ticks = Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => i * step);

  if (!tasks.length) {
    return <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">{t('mx.gantt_empty')}</div>;
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="grid grid-cols-[minmax(9rem,16rem)_1fr] border-b bg-muted/40 text-xs font-medium text-muted-foreground">
        <div className="px-3 py-2">{t('mx.gantt_task_col')}</div>
        <div className="relative px-3 py-2">
          {t('mx.gantt_schedule', { span })}
        </div>
      </div>
      <div className="divide-y">
        {tasks.map((task) => {
          const left = (task.es / span) * 100;
          const width = Math.max(1.5, (task.duration_days / span) * 100);
          const done = Math.max(0, Math.min(100, task.pct_complete));
          return (
            <div key={task.id} className="grid grid-cols-[minmax(9rem,16rem)_1fr] items-center hover:bg-muted/30">
              <div className="min-w-0 px-3 py-2">
                <div className="flex items-center gap-1.5">
                  {task.on_critical_path && <span className="inline-block size-1.5 shrink-0 rounded-full bg-primary" title={t('mx.gantt_critical')} />}
                  <span className="truncate text-sm font-medium text-foreground" title={task.name}>{task.name}</span>
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {t('mx.gantt_days', { days: task.duration_days })} · {done}%{task.assignee ? ` · ${task.assignee}` : ''}{task.slack > 0 ? ` · slack ${task.slack}d` : ''}
                </div>
              </div>
              <div className="relative h-9 px-3">
                {/* gridlines */}
                <div className="absolute inset-0">
                  {ticks.map((d) => (
                    <span key={d} className="absolute top-0 h-full border-l border-border/50" style={{ left: `calc(${(d / span) * 100}% )` }} />
                  ))}
                </div>
                {/* bar */}
                <div
                  className={cn(
                    'absolute top-1/2 h-4 -translate-y-1/2 overflow-hidden rounded-md shadow-xs ring-1',
                    task.status === 'cancelled'
                      ? 'bg-muted ring-border opacity-60'
                      : task.on_critical_path
                        ? 'bg-primary/25 ring-primary/40'
                        : 'bg-[var(--chart-2)]/20 ring-[var(--chart-2)]/40',
                  )}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={t('mx.gantt_bar_title', { name: task.name, es: task.es, ef: task.ef, done })}
                >
                  <div
                    className={cn('h-full', task.on_critical_path ? 'bg-primary' : 'bg-[var(--chart-2)]')}
                    style={{ width: `${done}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
