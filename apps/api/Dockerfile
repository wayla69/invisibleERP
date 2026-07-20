# Invisible ERP — API (NestJS/Fastify) production image.
# Multi-stage: install workspace deps → build @ierp/shared + @ierp/api → slim runtime.
# Mirrors the Railway NIXPACKS build (apps/api/railway.json) so container + Railway stay in lock-step.

# ── deps ───────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
# Copy only manifests first for a cached install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

# ── build ──────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @ierp/shared build && pnpm --filter @ierp/api build

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
# Bring the resolved node_modules + built dist from earlier stages.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /repo/packages/shared ./packages/shared
COPY --from=build /repo/apps/api ./apps/api
COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
# Run as the unprivileged "node" user already present in the base image.
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]
