# Security Policy

This is a public source repository for private local analysis. Secrets and
licensed provider data must never be committed.

## Never Commit

- `.env`, `.env.*`, `.secrets/`, credentials or local secret stores.
- API keys, passwords, tokens, session cookies or sportsbook account data.
- Betfair certificates/private keys.
- Cloudflare tunnel credentials.
- Database dumps, SQLite files, Timescale/Postgres exports or Redis dumps.
- Provider payload exports unless the license explicitly allows public sharing.
- Logs that contain credentials, full request headers or account identifiers.

## Execution Safety

Real financial execution is disabled by default:

```env
EXECUTION_ENABLED=false
EXECUTION_STAGE=paper
REAL_EXECUTION_HARD_BLOCK=true
```

Do not disable `REAL_EXECUTION_HARD_BLOCK` in normal development. A separate
legal/compliance and operator-readiness task is required before any real order
path is considered.

## Provider Safety

Provider integrations should fail closed:

- no hidden provider calls from tests;
- no quota spend from dashboard render;
- no browser automation on sportsbooks;
- no scraping restricted score or odds pages;
- no geolocation bypass;
- no LLM direct order placement.

## Reporting

For private vulnerabilities or accidental secret exposure, rotate the affected
credential immediately and open a private issue or contact the repository owner.
