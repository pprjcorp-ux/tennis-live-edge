# Tennis Live Edge

Private local-first tennis trading analytics system. It ingests scores/odds,
estimates fair probabilities, records paper outcomes, and recommends only
positive-EV signals with abstention and risk gates.

## Canonical Branches

- `budget`: default public branch. Same core system with ATP main-tour plus
  men's/women's Grand Slam singles defaults, approximately `$500/mo` vendor
  target, and enterprise feeds disabled.
- `enterprise`: complete enterprise profile with ROI/CLV paper trading,
  Betfair execution architecture hard-blocked by default, OpenClaw Autopilot,
  provider health, replay/backtest lab, and private runtime docs.

This branch is the `budget` profile. It keeps the complete core architecture,
but defaults to ATP main-tour plus men's/women's Grand Slam singles coverage,
cheaper feeds, strict abstention, and enterprise feeds disabled.

## Quick Start

```bash
cd /Users/ppfahd/Workspace/projects/tennis-live-edge
python3 -m venv .venv
.venv/bin/pip install -e "services/api[dev]"
npm install
npm --prefix apps/web install
npm run api:test
npm --prefix apps/web run build
npm run dev
```

Backend: `http://localhost:8000`  
Dashboard: `http://localhost:3000`

Without paid keys the system runs in `TENNIS_EDGE_DATA_MODE=sample` for demo
fixtures or `TENNIS_EDGE_DATA_MODE=replay` for fake-provider rehearsal. In
`replay`, budget providers use local fixture/snapshot contracts only; they do
not spend quota, call REST endpoints, or open live websockets even if keys are
present.

For live budget mode, keep Docker running and use Postgres/Timescale as the
operational cache:

```bash
docker compose up -d
docker compose exec -T postgres psql -U tennis -d tennis_edge < infra/schema.sql
TENNIS_EDGE_DATA_MODE=live npm run api:dev
```

Live mode persists matches, score ticks, odds ticks, feature snapshots,
predictions, signals, provider cursors, provider latency, and paper orders.
Paper entries stay blocked until `TENNIS_EDGE_PERSISTENCE_ENABLED=true`,
`DATABASE_URL` is configured, and the store reports no persistence error.

## Local Verification

```bash
npm run api:test
npm --prefix apps/web run build
python3 scripts/check_private_runtime.py
npm run api:check:operational-truth -- --pretty
```

`check_private_runtime.py` also verifies the API-last core contract: provider
adapter protocols, budget replay fixtures, provider runtime modes, signal safety
gates, paper settlement, Model Lab `training_examples` readiness, and the
dashboard-visible provider mode matrix plus Replay Lab/API onboarding sequence.
Replay Lab also has to surface per-scenario persistence evidence from the last
`replay_contract_run`, including raw payload, score tick, odds tick, cursor, and
provider latency counts.
`api:check:operational-truth` is the integrated local runtime proof: it uses the
repo venv automatically, validates the Postgres schema, runs fake-provider
replay contracts, checks the dashboard persisted source summary, confirms real
execution is hard-blocked, and can create a rehearsal-only paper training
example without any live API calls.

## Documentation

- [Common architecture](docs/architecture.md)
- [Strategic refactor plan](docs/strategic-refactor-plan.md)
- [Budget profile](docs/budget-profile.md)
- [Enterprise profile](docs/enterprise-profile.md)
- [Execution safety](docs/execution-safety.md)
- [Provider access runbook](docs/provider-access-runbook.md)
- [OpenClaw Autopilot](docs/openclaw-autopilot.md)
- [Cloudflare private access](infra/cloudflare/README.md)

## Budget Defaults

Use `.env.example` as the contract. The important budget defaults are:

- `TENNIS_EDGE_RUNTIME_PROFILE=lean_atp`
- `TENNIS_EDGE_COVERAGE=atp_main,grand_slam_men,grand_slam_women`
- `TENNIS_EDGE_MONTHLY_BUDGET_USD=500`
- `TENNIS_EDGE_PERSISTENCE_ENABLED=true`
- `TENNIS_EDGE_MAX_ODDS_STALENESS_MS=2500`
- `TENNIS_EDGE_MAX_AUTO_SETTLEMENT_CLOSING_AGE_MS=600000`
- `ENTERPRISE_FEEDS_ENABLED=false`
- `EXECUTION_ENABLED=false`
- `EXECUTION_STAGE=paper`
- `REAL_EXECUTION_HARD_BLOCK=true`
- `OPENCLAW_CRITICAL_MODEL=gpt-5.5`

The system is analytical software, not betting advice or a profit guarantee.
No browser automation, scraping, geolocation bypass, or direct LLM-initiated
betting is allowed.

## API Onboarding Order

Keep the core frozen before adding live APIs. The dashboard Data Health tab shows
this same sequence from `/api/v1/dashboard/live-state`:

1. Budget replay fixtures as the fake API layer for score, odds, gap, and resync
   contracts.
2. TheOddsAPI REST/archive and comparison. Use the protected
   `POST /api/v1/ingestion/the-odds-api/archive-sync` smoke first; it persists
   archive raw payloads and `odds/archive` latency, but it cannot create live
   entries by itself. Local CLI equivalent: `npm run api:ingest:archive-odds -- --pretty`.
3. API-Tennis fixtures/livescore. Use protected
   `POST /api/v1/ingestion/api-tennis/score-sync` as the score-only smoke; it
   persists fixture/score payloads and canonical state without calling archive
   odds. Local CLI equivalent: `npm run api:ingest:api-tennis -- --pretty`.
4. Odds-API.io websocket live odds, only after `seq`/`lastSeq` replay and resync
   gates are healthy. Use protected
   `POST /api/v1/ingestion/odds-api-io/stream-smoke` with a small timeout before
   enabling the combined live loop. Local CLI equivalent:
   `npm run api:ingest:odds-stream -- --max-messages 1 --timeout-seconds 5 --pretty`.
5. Sportradar/Betradar/TXODDS enterprise feeds, deferred until budget paper data
   proves a real coverage or latency bottleneck.

In live mode, replay does not silently use sample data. The dashboard's Replay
Lab sends `use_fixture_seed=true` explicitly when the operator wants to rehearse
provider contracts without consuming live provider quota. Before adding or
debugging any paid key, run the aggregate contract rehearsal through
`POST /api/v1/replay/contracts/run`; it exercises healthy, gap, and
`resync_required` scenarios for API-Tennis, Odds-API.io, and TheOddsAPI, then
returns the adapter, input, and output contracts proven by each scenario.
Replay evidence separates `provider_cursors_replayed` from `cursors_saved` so
fixture runs can prove cursor parsing without overwriting an active live cursor.

For the daily paper-first operational loop, run `npm run api:ops:daily` or call
the protected `POST /api/v1/ops/daily` endpoint. This executes replay contracts,
paper auto-settlement, and the Model Lab `training_examples` backtest path while
reporting `live_api_calls=0`, so it is safe to run before provider credentials
are configured. Auto-settlement returns structured `decisions` for each
candidate order, so operators and OpenClaw can audit why an order settled,
skipped, failed, or did not produce a ready `training_example`.
