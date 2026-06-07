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

Without paid keys the system runs in `TENNIS_EDGE_DATA_MODE=sample`.

For live budget mode, keep Docker running and use Postgres/Timescale as the
operational cache:

```bash
docker compose up -d
docker compose exec -T postgres psql -U tennis -d tennis_edge < infra/schema.sql
TENNIS_EDGE_DATA_MODE=live npm run api:dev
```

Live mode persists matches, score ticks, odds ticks, feature snapshots,
predictions, signals, provider cursors, provider latency, and paper orders when
`DATABASE_URL` is configured.

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
- `ENTERPRISE_FEEDS_ENABLED=false`
- `EXECUTION_ENABLED=false`
- `EXECUTION_STAGE=paper`
- `REAL_EXECUTION_HARD_BLOCK=true`
- `OPENCLAW_CRITICAL_MODEL=gpt-5.5`

The system is analytical software, not betting advice or a profit guarantee.
No browser automation, scraping, geolocation bypass, or direct LLM-initiated
betting is allowed.
