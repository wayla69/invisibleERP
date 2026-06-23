#!/usr/bin/env sh
# API container entrypoint. Optionally applies DB migrations before starting the server so a deploy
# can be a single step. Set RUN_MIGRATIONS=1 (default in compose; on Railway use its preDeployCommand
# instead so migrations run once per release, not once per replica).
set -e

if [ "${RUN_MIGRATIONS:-0}" = "1" ]; then
  echo "[entrypoint] applying database migrations (drizzle-kit migrate)…"
  pnpm --filter @ierp/api db:migrate
fi

echo "[entrypoint] starting API…"
exec "$@"
