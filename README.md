# Tennis Live Edge

Dashboard e backend para analisar jogos ATP/WTA, estimar probabilidade justa, comparar com odds de mercado e recomendar apenas sinais com edge positivo.

## O que a v1 entrega

- API FastAPI com fixtures de exemplo e clientes prontos para API-Tennis e Odds-API.io.
- Motor de features, modelo baseline, remocao de vig, threshold por contexto live/pre-match e stake Kelly fracionado.
- Dashboard Next.js para jogos do dia, odds, probabilidade modelo, edge, confianca e status do sinal.
- Modo enterprise local-first com adaptadores para Sportradar/Betradar, TXODDS, API-Tennis e Odds-API.io.
- Perfil `lean_atp` para reduzir custo: ATP main-tour + Grand Slam masculino, API-Tennis, Odds-API.io WebSocket e TheOddsAPI archive, com Sportradar/TXODDS desativados ate prova de valor.
- Replay deterministico, backtest com gate de promocao de modelo e endpoints administrativos protegidos por `ADMIN_API_TOKEN`.
- Schema Postgres/TimescaleDB event-sourced para payloads brutos, score/odds ticks, point events, suspensoes, latencia, predicoes, sinais, paper orders e futura execucao.

## Rodando localmente

```bash
cd /Users/ppfahd/Workspace/projects/tennis-live-edge
python3 -m venv .venv
.venv/bin/pip install -e "services/api[dev]"
npm install
npm --prefix apps/web install
npm run api:test
npm run dev
```

Backend: `http://localhost:8000`  
Dashboard: `http://localhost:3000`

Sem chaves, o sistema usa `TENNIS_EDGE_DATA_MODE=sample`. Para dados reais, preencha `.env` com feeds pagos e defina:

- `SPORTRADAR_API_KEY`, `BETRADAR_UOF_TOKEN`, `TXODDS_USER`, `TXODDS_PASSWORD`
- `API_TENNIS_KEY`, `ODDS_API_IO_KEY`, `THE_ODDS_API_KEY` para o perfil lean
- `ADMIN_API_TOKEN` para replay/backtest/promocao
- `TENNIS_EDGE_RUNTIME_PROFILE=lean_atp`, `TENNIS_EDGE_COVERAGE=atp_main,grand_slam_men`
- `SCORE_PRIMARY=api_tennis`, `ODDS_PRIMARY=odds_api_io_ws`, `ODDS_ARCHIVE=theoddsapi`
- `ENTERPRISE_FEEDS_ENABLED=false`
- `TENNIS_EDGE_CORS_ORIGIN=http://localhost:3000,https://edge.<domain>`
- `EXECUTION_ENABLED=false`

Para acesso privado, use Cloudflare Tunnel + Access conforme `infra/cloudflare/README.md`. O dashboard envia cookies do Cloudflare Access com `credentials: include`; o backend nao deve ser aberto publicamente fora do tunel protegido.

## Regra de sinal

O sistema pode e deve se abster. `ENTRY` so aparece quando:

- odds validas existem para os dois lados;
- probabilidade do modelo supera a probabilidade justa do mercado;
- edge passa o threshold: 4% pre-match, 3% live normal, 6% live volatil;
- stake Kelly fracionado fica positivo e dentro do cap de 1.5% da banca.

Isto nao e promessa de lucro nem conselho de aposta. A qualidade deve ser medida por ROI, CLV, Brier score, log loss, calibracao e drawdown.

Auto-betting fica desativado na v1 enterprise. Qualquer modulo de execucao precisa de revisao legal, revisao de conta/API e feature flag separada antes de sair do modo paper.
