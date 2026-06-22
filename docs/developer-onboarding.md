# Developer Onboarding

This repository is the Tennis Live Edge system: a private, local-first tennis
analytics and paper-trading platform. The current production direction is
budget live first, enterprise later.

## What The System Does

Tennis Live Edge collects tennis score state, odds ticks, provider health,
provider cursors, predictions, signals, paper orders, settlements and learning
metrics. It then decides whether a match is:

- `Entrada`: eligible paper entry with positive expected value and all risk/data
  gates passing.
- `Monitorar`: interesting but not actionable.
- `Sem valor` or `Bloqueado`: no valid edge, missing data, stale data,
  suspended market, unsupported coverage, replay-only state, or safety block.

The objective is ROI/CLV-positive decision quality, not forced picks and not raw
win rate. Abstention is a valid output.

## Canonical Branches

- `budget`: default public branch. It targets ATP main tour plus men's/women's
  Grand Slam singles with low-cost providers.
- `enterprise`: no-budget-limit branch. It keeps the same core but adds
  enterprise provider contracts, model-lab direction, Hermes Agent Ops, and
  deferred Betfair architecture.

Do not create more long-lived product branches unless the owner asks. Use short
feature branches for PRs.

## Runtime Profiles

Budget profile:

```env
TENNIS_EDGE_RUNTIME_PROFILE=lean_atp
TENNIS_EDGE_COVERAGE=atp_main,grand_slam_men,grand_slam_women
TENNIS_EDGE_MONTHLY_BUDGET_USD=500
ENTERPRISE_FEEDS_ENABLED=false
EXECUTION_ENABLED=false
REAL_EXECUTION_HARD_BLOCK=true
```

Enterprise profile:

```env
TENNIS_EDGE_RUNTIME_PROFILE=enterprise_roi_clv
TENNIS_EDGE_MONTHLY_BUDGET_USD=6000
ENTERPRISE_FEEDS_ENABLED=true
EXECUTION_ENABLED=false
EXECUTION_STAGE=paper
REAL_EXECUTION_HARD_BLOCK=true
```

Real financial execution is intentionally disabled in both profiles.

## Architecture Map

- `services/api`: FastAPI backend, provider adapters, canonical domain models,
  signal gates, replay engine, model lab, repository/persistence and execution
  safety.
- `apps/web`: Next.js dashboard for live board, provider health, replay lab,
  model lab, paper journal and risk state.
- `infra/schema.sql`: Postgres/Timescale operational truth schema.
- `infra/cloudflare`: private Cloudflare Tunnel/Access notes.
- `hermes`: local Agent Ops skill and read-only automation scripts.
- `docs`: operating docs, branch profiles, safety, provider access and strategy.

## Local Setup

```bash
cd /Users/ppfahd/Workspace/projects/tennis-live-edge
python3 -m venv .venv
.venv/bin/pip install -e "services/api[dev]"
npm install
npm --prefix apps/web install
cp .env.example .env
```

Edit `.env` locally only. Do not commit it.

Start local infrastructure:

```bash
docker compose up -d
docker compose exec -T postgres psql -U tennis -d tennis_edge < infra/schema.sql
```

Run API and dashboard:

```bash
npm run api:dev
npm run dev
```

Backend: `http://localhost:8000`

Dashboard: `http://localhost:3000`

## Data Modes

- `sample`: deterministic demo fixtures.
- `replay`: fake-provider rehearsal using local fixtures. No quota spend.
- `live`: real provider ingestion into Postgres/Timescale.

Live mode should not generate `Entrada` unless persistence, score state, odds,
provider cursor, freshness and risk gates are healthy.

## API Onboarding Sequence

1. Keep replay contracts green.
2. Add The Odds API for archive/comparison snapshots.
3. Add API-Tennis for fixtures and livescore.
4. Add Odds-API.io WebSocket for live odds.
5. Keep Betfair, Sportradar, Betradar and TXODDS deferred until paper evidence
   proves the budget stack is the bottleneck.

Use [API access purchasing guide](api-access-purchasing-guide.md) for direct
links and exact variables.

## Validation Commands

Run the smallest relevant checks before every commit:

```bash
npm run api:test
npm --prefix apps/web run build
python3 scripts/check_private_runtime.py
npm run api:check:operational-truth -- --pretty
git diff --check
```

For provider-contract work, include:

```bash
npm run api:test -- --quiet tests/test_enterprise_providers.py
```

## Safety Rules

- Never commit `.env`, `.env.*`, `.secrets/`, certificates, keys, database
  dumps, provider licensed exports, logs with tokens, or local run artifacts.
- No browser automation on sportsbooks.
- No scraping restricted score/odds pages.
- No geolocation bypass.
- No LLM-initiated betting.
- No real orders while `REAL_EXECUTION_HARD_BLOCK=true`.
- Provider calls must be explicit smoke/ingestion actions, not hidden side
  effects of tests or dashboard loading.

## Useful Docs

- [Architecture](architecture.md)
- [Budget profile](budget-profile.md)
- [Enterprise profile](enterprise-profile.md)
- [Enterprise accuracy track](enterprise-accuracy-track.md)
- [Execution safety](execution-safety.md)
- [Provider access runbook](provider-access-runbook.md)
- [Hermes Agent Ops](hermes-agent-ops.md)
- [Hermes operating model](hermes-operating-model.md)
