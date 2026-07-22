import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SCM_ENGINE_CONTRACT_VERSION,
  zForecastRequest,
  zForecastResponse,
  zOptimizeItemPlan,
  zOptimizeRequest,
  zOptimizeResponse,
} from '@ierp/shared';

// docs/54 — TS half of the contract-parity gate. The SAME fixture files are validated by pytest
// against the pydantic mirror (services/forecast-engine/tests/test_contract_fixtures.py), so a
// change to either schema that the other side can't parse fails one of the two CI jobs.
// packages/shared/src/scm-engine.ts is the source of truth; app/contracts.py mirrors it.

const FIXTURES = join(__dirname, '../../../services/forecast-engine/tests/fixtures');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

describe('scm-engine contract — shared fixtures parse with the zod schemas', () => {
  it('forecast request', () => {
    const req = zForecastRequest.parse(fixture('forecast_request.json'));
    expect(req.contract_version).toBe(SCM_ENGINE_CONTRACT_VERSION);
    expect(req.series).toHaveLength(2);
    // The censored/closed days the extractor must mark are present in the pinned fixture.
    expect(req.series[0]!.history.some((p) => p.stockout)).toBe(true);
    expect(req.closures).toContain('2026-07-06');
    expect(req.holidays.some((h) => h.upper_window === 2)).toBe(true); // Songkran spans forward
  });

  it('forecast response', () => {
    const res = zForecastResponse.parse(fixture('forecast_response.json'));
    expect(res.results).toHaveLength(2);
    for (const r of res.results) {
      expect(r.sample_paths.length).toBeGreaterThan(0);
      const width = r.sample_paths[0]!.length;
      expect(r.sample_paths.every((p) => p.length === width)).toBe(true);
      expect(r.points).toHaveLength(width); // one point per horizon day
    }
    expect(res.errors[0]?.code).toBe('SERIES_TOO_SHORT'); // per-series failure, not a batch failure
  });

  it('optimize request', () => {
    const req = zOptimizeRequest.parse(fixture('optimize_request.json'));
    expect(req.start_ds).toBe('2026-07-01');
    const chicken = req.items.find((i) => i.item_code === 'ING-CHICKEN')!;
    expect(chicken.current_inventory.map((l) => l.remaining_days)).toEqual([1, 2]); // FEFO layers
    expect(chicken.pack_size).toBe(5);
    expect(req.joint?.budget).toBe(25_000);
  });

  it('optimize response', () => {
    const res = zOptimizeResponse.parse(fixture('optimize_response.json'));
    expect(res.plans.map((p) => p.method).sort()).toEqual(['milp', 'newsvendor']);
    for (const p of res.plans) {
      expect(p.order_up_to).toHaveLength(p.safety_stock.length);
      expect(p.expected.fill_rate).toBeGreaterThanOrEqual(0);
      expect(p.expected.fill_rate).toBeLessThanOrEqual(1);
    }
  });
});

describe('scm-engine contract — guardrails the API relies on', () => {
  it('applies the documented defaults so a minimal request is still complete', () => {
    const req = zForecastRequest.parse({
      contract_version: '2',
      request_id: 'r1',
      horizon_days: 7,
      holidays: [],
      series: [{ series_id: 's', history: [{ ds: '2026-06-01', y: 1 }] }],
    });
    expect(req.scenario_count).toBe(50);
    expect(req.quantiles).toEqual([0.1, 0.5, 0.9]);
    expect(req.closures).toEqual([]);
    expect(req.payday_regressor).toBe(true);
    expect(req.promo_regressor).toBe(true);
    expect(req.price_regressor).toBe(true);
    expect(req.scenario).toBe(false);
    expect(req.series[0]!.class_hint).toBe('auto');
  });

  it('rejects a foreign contract version', () => {
    expect(() => zForecastRequest.parse({ ...fixture('forecast_request.json'), contract_version: '1' })).toThrow();
  });

  it('rejects malformed business days and negative demand', () => {
    const base = fixture('forecast_request.json');
    const bad = structuredClone(base);
    bad.series[0].history[0].ds = '01/06/2026'; // must be YYYY-MM-DD (bizYmd)
    expect(() => zForecastRequest.parse(bad)).toThrow();

    const negative = structuredClone(base);
    negative.series[0].history[0].y = -5;
    expect(() => zForecastRequest.parse(negative)).toThrow();
  });

  it('bounds batch sizes so a 33-branch run must chunk rather than send one huge payload', () => {
    const base = fixture('forecast_request.json');
    const tooMany = { ...base, series: Array.from({ length: 201 }, () => base.series[0]) };
    expect(() => zForecastRequest.parse(tooMany)).toThrow();

    const optimizeBase = fixture('optimize_request.json');
    const tooManyItems = { ...optimizeBase, items: Array.from({ length: 301 }, () => optimizeBase.items[0]) };
    expect(() => zOptimizeRequest.parse(tooManyItems)).toThrow();
  });

  it('accepts a same-day lead time (morning market run)', () => {
    const req = fixture('optimize_request.json');
    req.items[0].lead_time = { mean_days: 0, std_days: 0 };
    expect(() => zOptimizeRequest.parse(req)).not.toThrow();
  });

  it('ignores unknown fields so the engine can add optional outputs without breaking the API', () => {
    const plan = zOptimizeItemPlan.parse({
      ...fixture('optimize_response.json').plans[0],
      future_field: { anything: true },
    });
    expect(plan.item_code).toBe('ING-CHICKEN');
  });
});
