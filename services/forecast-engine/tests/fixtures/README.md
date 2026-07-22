# Shared contract fixtures (docs/54)

These JSON files are the **executable contract** between the TypeScript API and the Python engine.
They are parsed by BOTH suites, so a change on either side that breaks the other fails CI:

- **Python** — `tests/test_contract_fixtures.py` validates them with the pydantic models in
  `app/contracts.py`, and replays the request fixtures through the real endpoints.
- **TypeScript** — `apps/api/test/scm-contract.test.ts` validates the same files with the zod
  schemas in `packages/shared/src/scm-engine.ts` (the source of truth).

When you evolve the contract: change the zod schema, mirror it in `app/contracts.py`, then update
these fixtures. Additive optional fields need no fixture change (both sides ignore unknown keys);
anything else is a `contract_version` bump.

| File | What it pins |
|---|---|
| `forecast_request.json` | 2 series (smooth + intermittent), holidays with windows, a closure day, a stockout-censored day |
| `forecast_response.json` | K=2 sample paths, quantile map keyed by stringified quantiles, backtest accuracy, per-series error entry |
| `optimize_request.json` | perishable item (FEFO layers by remaining life, MOQ/pack/fixed cost) + a non-perishable one, in-transit arrival, joint budget |
| `optimize_response.json` | both tiers (`milp` + `newsvendor`), per-day order-up-to/safety stock, expected metrics, solver info |
