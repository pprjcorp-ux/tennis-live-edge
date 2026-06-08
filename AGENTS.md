# Tennis Live Edge - Agent Handoff

## Canonical Branches

- `budget`: default public branch, ATP main-tour plus men's/women's Grand Slam
  singles profile, approximately `$500/mo` vendor target, enterprise feeds
  disabled.
- `enterprise`: full enterprise profile, ROI/CLV paper trading, Betfair
  architecture hard-blocked by default, OpenClaw Autopilot, private runtime docs.

Do not create more long-lived product branches without explicit request. Older
`codex/*` branches are archive-only after consolidation.

## Working Directory

Use `/Users/ppfahd/Workspace/projects/tennis-live-edge` as the project root.
The user home directory is a broader macOS workspace and git root; keep edits
scoped to this repo.

Do not commit `.env`, `.logs/`, `.venv/`, `.next/`, `node_modules/`,
`.DS_Store`, secrets, or machine-specific files.

## Architecture

- `services/api`: FastAPI backend, provider adapters, feature/model/signal
  engines, replay/backtest, execution gates, and Agent Ops.
- `apps/web`: Next.js dashboard.
- `infra/schema.sql`: Postgres/Timescale event-sourced schema.
- `infra/cloudflare`: Cloudflare Tunnel/Access docs.
- `openclaw`: local-only OpenClaw skill/config examples.
- `docs`: shared architecture plus branch-specific operating docs.
- `docs/strategic-refactor-plan.md`: current product objective, best v2
  direction, refactor order, and OpenClaw/Cloudflare/provider strategy.

## Runtime Defaults

Enterprise branch:

- `TENNIS_EDGE_RUNTIME_PROFILE=enterprise_roi_clv`
- `TENNIS_EDGE_MONTHLY_BUDGET_USD=6000`
- `TENNIS_EDGE_COVERAGE=atp_main,grand_slam_men,grand_slam_women`
- `EXECUTION_ENABLED=false`
- `EXECUTION_STAGE=paper`
- `REAL_EXECUTION_HARD_BLOCK=true`
- `OPENCLAW_CRITICAL_MODEL=gpt-5.5`

Budget branch:

- `TENNIS_EDGE_RUNTIME_PROFILE=lean_atp`
- `TENNIS_EDGE_MONTHLY_BUDGET_USD=500`
- `TENNIS_EDGE_COVERAGE=atp_main,grand_slam_men,grand_slam_women`
- `TENNIS_EDGE_PERSISTENCE_ENABLED=true`
- `ENTERPRISE_FEEDS_ENABLED=false`
- `EXECUTION_ENABLED=false`
- `REAL_EXECUTION_HARD_BLOCK=true`

Live paper entries require durable operational truth: in `TENNIS_EDGE_DATA_MODE=live`,
`DATABASE_URL` must be configured and Postgres/Timescale must be healthy before
`can_generate_entries=true`.

## Safety Rules

- The system can abstain; no forced picks.
- No real-money execution is enabled by default in any branch.
- No LLM, OpenClaw agent, Cloudflare Agent, browser automation, scraping, or
  geolocation workaround may place bets directly.
- Agents may only explain, monitor, review, or call internal APIs that enforce
  deterministic backend gates.
- Real execution requires a separate compliance/account/API activation task.

## Verification

Run from the repo root:

```bash
docker compose up -d
docker compose exec -T postgres psql -U tennis -d tennis_edge < infra/schema.sql
npm run api:test
npm run api:ingest
printf '{"event_id":"smoke-event","seq":1,"timestamp":"2026-06-07T20:00:00Z","data":{"bookmaker":"SmokeBook","market":"h2h","selections":[{"player_id":"p1","odds":1.8},{"player_id":"p2","odds":2.1}]}}' | TENNIS_EDGE_DATA_MODE=sample TENNIS_EDGE_PERSISTENCE_ENABLED=false npm run api:ingest:odds-message
npm --prefix apps/web run build
python3 scripts/check_private_runtime.py
```

When the local API is running:

```bash
npm run openclaw:briefing
curl -s http://localhost:8000/api/v1/execution/status
curl -s http://localhost:8000/api/v1/cost-profile
```
