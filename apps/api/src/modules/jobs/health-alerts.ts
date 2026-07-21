// Wave D4 — first-class alert thresholds over the ops-metrics surface. The endpoint always said its
// fields are "the inputs to an external alert rule"; these env-tunable rules make the evaluation
// server-side so the Platform Console (and any poller) gets a ready alerts[] instead of re-deriving
// thresholds client-side. Pure function → exhaustively unit-tested.

export interface HealthAlert {
  key: string;
  message: string; // operator-facing (EN — the console renders its own localized labels off `key`)
  value: number | string;
  threshold: number | string;
}

export interface HealthMetricsInput {
  pool: { saturation_pct: number };
  jobs: { queued: number; failed: number; stuck: number };
  scheduler?: { status?: string }; // HeartbeatStatus — 'never' | 'ok' | 'stale'
}

const num = (raw: string | undefined, dflt: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

// Defaults: pool ≥80% saturated, ANY dead-letter/stuck job, ≥500 queued backlog, stale scheduler.
export function evaluateHealthAlerts(m: HealthMetricsInput, env: NodeJS.ProcessEnv = process.env): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  const poolPct = num(env.PLATFORM_ALERT_POOL_PCT, 80);
  const failedAt = num(env.PLATFORM_ALERT_JOBS_FAILED, 1);
  const stuckAt = num(env.PLATFORM_ALERT_JOBS_STUCK, 1);
  const queuedAt = num(env.PLATFORM_ALERT_JOBS_QUEUED, 500);
  if (m.pool.saturation_pct >= poolPct) alerts.push({ key: 'pool_saturation', message: `DB pool ${m.pool.saturation_pct}% saturated`, value: m.pool.saturation_pct, threshold: poolPct });
  if (m.jobs.failed >= failedAt) alerts.push({ key: 'jobs_failed', message: `${m.jobs.failed} dead-lettered job(s)`, value: m.jobs.failed, threshold: failedAt });
  if (m.jobs.stuck >= stuckAt) alerts.push({ key: 'jobs_stuck', message: `${m.jobs.stuck} stuck job(s)`, value: m.jobs.stuck, threshold: stuckAt });
  if (m.jobs.queued >= queuedAt) alerts.push({ key: 'jobs_backlog', message: `${m.jobs.queued} queued job(s)`, value: m.jobs.queued, threshold: queuedAt });
  if (m.scheduler?.status === 'stale') alerts.push({ key: 'scheduler_stale', message: 'due-sweep scheduler heartbeat is stale', value: 'stale', threshold: 'ok' });
  return alerts;
}
