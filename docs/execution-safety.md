# Execution Safety

Real-money betting is not enabled in either canonical branch.

## Hard Rules

- `EXECUTION_ENABLED=false` by default.
- `REAL_EXECUTION_HARD_BLOCK=true` overrides all other gates.
- `EXECUTION_STAGE=paper` by default.
- Only Betfair Exchange API is modeled for future execution.
- No browser automation, scraping, geolocation bypass, or sportsbook UI control.
- No LLM, OpenClaw agent, Cloudflare Agent, or browser tool may submit bets
  directly.

## Allowed in Current Phase

- Paper orders through backend risk gates.
- Bankroll snapshots, stake caps, persisted kill switch, audit events, partial-fill
  simulation, settlement, CLV, ROI, and calibration records.
- Readiness reports after at least 60 paper days or 500 settled paper signals.

## Future Activation Gate

Real execution requires a separate task that reviews legal availability, KYC,
approved Betfair live app key, account constraints, jurisdiction, risk caps,
and operational monitoring. The activation task must explicitly change the hard
block; no current code path should do that automatically.

Betfair onboarding steps and enterprise feed outreach are tracked in
[Provider access runbook](provider-access-runbook.md).
