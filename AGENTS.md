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
- `ENTERPRISE_FEEDS_ENABLED=false`
- `EXECUTION_ENABLED=false`
- `REAL_EXECUTION_HARD_BLOCK=true`

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
npm run api:test
npm --prefix apps/web run build
python3 scripts/check_private_runtime.py
```

When the local API is running:

```bash
npm run openclaw:briefing
curl -s http://localhost:8000/api/v1/execution/status
curl -s http://localhost:8000/api/v1/cost-profile
```
