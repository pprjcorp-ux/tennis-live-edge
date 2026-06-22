# Private Cloudflare Runtime

Target topology:

- `edge.<domain>` -> local Next.js dashboard at `http://localhost:3000`
- `api.edge.<domain>` -> local FastAPI backend at `http://localhost:8000`
- Both hostnames must be protected by Cloudflare Access email allowlist.
- Backend ports stay local; the public path is only the Cloudflare Tunnel.

## Install

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create tennis-live-edge
```

Copy `tunnel-config.example.yml` to `~/.cloudflared/tennis-live-edge.yml`, replace:

- `edge.example.com`
- `api.edge.example.com`
- `credentials-file`

Validate the repository example:

```bash
npm run cloudflare:check:example
```

Validate your real local tunnel config after replacing hostnames and setting
`PRIVATE_ALLOWED_EMAILS`, `ADMIN_API_TOKEN`, and `TENNIS_EDGE_CORS_ORIGIN`:

```bash
npm run cloudflare:check
```

Then route DNS:

```bash
cloudflared tunnel route dns tennis-live-edge edge.<domain>
cloudflared tunnel route dns tennis-live-edge api.edge.<domain>
cloudflared tunnel --config ~/.cloudflared/tennis-live-edge.yml run tennis-live-edge
```

## Access policy

In Cloudflare Zero Trust:

1. Access -> Applications -> Add self-hosted application.
2. Protect `edge.<domain>` and `api.edge.<domain>`.
3. Policy: Allow only emails listed in `PRIVATE_ALLOWED_EMAILS`.
4. Session duration: 24h.

Set the backend CORS list to the Access hostname:

```bash
TENNIS_EDGE_CORS_ORIGIN=http://localhost:3000,https://edge.<domain>
ADMIN_API_TOKEN="$(openssl rand -hex 32)"
```

Replay, backtest and model-promotion calls require `x-admin-token`; the dashboard asks for this token only inside the replay/backtest lab.

Do not expose Postgres, Redis, NATS, or model/admin ports through the tunnel.
