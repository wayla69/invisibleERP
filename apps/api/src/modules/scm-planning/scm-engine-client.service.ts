import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  SCM_ENGINE_CONTRACT_VERSION, SCM_ENGINE_HEADERS,
  zForecastResponse, zOptimizeResponse, zOptimizeNetworkResponse,
  type ScmForecastRequest, type ScmForecastResponse,
  type ScmOptimizeRequest, type ScmOptimizeResponse,
  type ScmOptimizeNetworkRequest, type ScmOptimizeNetworkResponse,
} from '@ierp/shared';
import { hmacSha256Hex } from '../../common/crypto';
import { captureOpsAlert } from '../../observability/instrumentation';

// docs/54 — HTTP client for the Python forecast engine (services/forecast-engine).
//
// OPT-IN: both SCM_ENGINE_URL and SCM_ENGINE_SECRET must be set. With either unset the API never
// makes an outbound call and the caller runs its in-process fallback planner — the same env-gated,
// degrade-gracefully shape as the demand-ml weather overlay. Exactly ONE set is a misconfiguration:
// we stay in fallback and raise a one-time ops alert rather than failing closed on a planning run.
//
// The SSRF guard (common/net-guard assertPublicUrl) is deliberately NOT applied here: this URL is
// operator config like DATABASE_URL, and the correct topology is a private-network sidecar that the
// guard would reject. It must never be set from tenant input.

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_SERIES = 200;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

@Injectable()
export class ScmEngineClientService {
  private readonly log = new Logger(ScmEngineClientService.name);
  private warnedMisconfigured = false;
  /** Engine build version from the last successful response — persisted on the plan run. */
  lastVersion: string | null = null;

  private url(): string | null {
    return (process.env.SCM_ENGINE_URL ?? '').trim() || null;
  }

  private secret(): string | null {
    return (process.env.SCM_ENGINE_SECRET ?? '').trim() || null;
  }

  enabled(): boolean {
    const url = this.url();
    const secret = this.secret();
    if (url && secret) return true;
    if ((url || secret) && !this.warnedMisconfigured) {
      this.warnedMisconfigured = true;
      captureOpsAlert('scm_engine_misconfigured', {
        has_url: !!url, has_secret: !!secret,
        degraded: 'planning runs use the in-process fallback planner until BOTH vars are set',
      });
    }
    return false;
  }

  maxSeries(): number {
    const raw = Number(process.env.SCM_ENGINE_MAX_SERIES);
    return Number.isFinite(raw) && raw > 0 ? Math.min(raw, DEFAULT_MAX_SERIES) : DEFAULT_MAX_SERIES;
  }

  private timeoutMs(): number {
    const raw = Number(process.env.SCM_ENGINE_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  }

  /**
   * Sign + POST + validate. Retries transient failures only (network / 429 / 5xx); a 4xx is a
   * contract or signature bug that will not heal, so it fails fast. Each retry re-signs with a
   * fresh timestamp over the identical body, and reuses the idempotency key so the engine's result
   * cache returns the original answer instead of re-solving.
   */
  private async post<T>(path: string, body: unknown, parse: (raw: unknown) => T): Promise<T> {
    const base = this.url();
    const secret = this.secret();
    if (!base || !secret) {
      throw new ServiceUnavailableException({
        code: 'SCM_ENGINE_DISABLED', message: 'The forecast engine is not configured',
        messageTh: 'ยังไม่ได้ตั้งค่าเครื่องมือพยากรณ์',
      });
    }
    const raw = JSON.stringify(body);
    const idempotencyKey = randomUUID();
    let lastErr: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const ts = Math.floor(Date.now() / 1000);
      try {
        const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [SCM_ENGINE_HEADERS.timestamp]: String(ts),
            [SCM_ENGINE_HEADERS.signature]: hmacSha256Hex(secret, `${ts}.${raw}`),
            [SCM_ENGINE_HEADERS.idempotency]: idempotencyKey,
          },
          body: raw,
          signal: AbortSignal.timeout(this.timeoutMs()),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const retriable = res.status === 429 || res.status >= 500;
          const err = new Error(`engine ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
          if (!retriable) throw Object.assign(err, { fatal: true });
          lastErr = err;
        } else {
          const json = await res.json();
          this.lastVersion = res.headers.get(SCM_ENGINE_HEADERS.version) ?? this.lastVersion;
          return parse(json);
        }
      } catch (e) {
        if ((e as { fatal?: boolean })?.fatal) throw e;
        lastErr = e;
      }
      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 250);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async forecast(req: ScmForecastRequest): Promise<ScmForecastResponse> {
    return this.post('/v1/forecast', req, (raw) => {
      const parsed = zForecastResponse.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`ENGINE_CONTRACT_MISMATCH (forecast): ${parsed.error.issues[0]?.message ?? 'schema'}`);
      }
      return parsed.data;
    });
  }

  async optimize(req: ScmOptimizeRequest): Promise<ScmOptimizeResponse> {
    return this.post('/v1/optimize', req, (raw) => {
      const parsed = zOptimizeResponse.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`ENGINE_CONTRACT_MISMATCH (optimize): ${parsed.error.issues[0]?.message ?? 'schema'}`);
      }
      return parsed.data;
    });
  }

  /** docs/57 Track B (B2) — two-echelon MEIO network optimization. One item across the whole network. */
  async optimizeNetwork(req: ScmOptimizeNetworkRequest): Promise<ScmOptimizeNetworkResponse> {
    return this.post('/v1/optimize-network', req, (raw) => {
      const parsed = zOptimizeNetworkResponse.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`ENGINE_CONTRACT_MISMATCH (optimize-network): ${parsed.error.issues[0]?.message ?? 'schema'}`);
      }
      return parsed.data;
    });
  }

  /** Split a series list into engine-sized chunks (callers keep one branch per chunk). */
  chunk<T>(rows: T[], size = this.maxSeries()): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
    return out;
  }

  /** Typed as the literal the request schemas demand, not a widened string. */
  contractVersion(): typeof SCM_ENGINE_CONTRACT_VERSION {
    return SCM_ENGINE_CONTRACT_VERSION;
  }
}
