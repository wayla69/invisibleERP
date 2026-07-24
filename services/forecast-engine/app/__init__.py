"""Invisible ERP forecast-engine (docs/54) — stateless FastAPI compute service.

No database access, no tenant identifiers, no PII: the NestJS API extracts everything under tenant
RLS and sends self-contained JSON payloads (see app/contracts.py, mirroring the zod source of truth
in packages/shared/src/scm-engine.ts).
"""

ENGINE_VERSION = "1.2.0"  # docs/56 A2 — own-price elasticity estimation (log-log, identifiability floor)
