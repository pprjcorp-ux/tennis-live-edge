"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CircleDollarSign,
  DatabaseZap,
  LockKeyhole,
  Play,
  RefreshCcw,
  ShieldCheck,
  Timer,
  TrendingUp,
  Zap
} from "lucide-react";
import {
  createPaperOrder,
  getCostProfile,
  getBankroll,
  getDailyMetrics,
  getDailyCostReport,
  getExecutionStatus,
  getLiveSignals,
  getOrders,
  getProviderHealth,
  getTodayMatches,
  promoteFromLearning,
  runBacktest,
  runReplay,
  setKillSwitch,
  submitOrder
} from "@/lib/api";
import type {
  BacktestMetrics,
  BankrollSnapshot,
  CostProfile,
  DailyMetrics,
  DailyCostReport,
  ExecutionOrder,
  ExecutionStatus,
  MatchAnalysis,
  ModelPromotionDecision,
  ProviderHealth,
  ReplayRunResult,
  Signal
} from "@/lib/types";

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function usd(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return `$${value.toFixed(0)}`;
}

function statusClass(status: Signal["status"]) {
  if (status === "Entrada") return "status statusEntry";
  if (status === "Monitorar") return "status statusMonitor";
  if (status === "Bloqueado") return "status statusBlocked";
  return "status statusMuted";
}

function playerProbability(analysis: MatchAnalysis, playerId: string) {
  return playerId === analysis.match.player1.id
    ? analysis.prediction.p1_win_prob
    : analysis.prediction.p2_win_prob;
}

function bestSignal(analysis: MatchAnalysis) {
  return analysis.signals[0];
}

export default function Page() {
  const [matches, setMatches] = useState<MatchAnalysis[]>([]);
  const [metrics, setMetrics] = useState<DailyMetrics | null>(null);
  const [costProfile, setCostProfile] = useState<CostProfile | null>(null);
  const [costReport, setCostReport] = useState<DailyCostReport | null>(null);
  const [executionStatus, setExecutionStatus] = useState<ExecutionStatus | null>(null);
  const [bankroll, setBankroll] = useState<BankrollSnapshot | null>(null);
  const [orders, setOrders] = useState<ExecutionOrder[]>([]);
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [replay, setReplay] = useState<ReplayRunResult | null>(null);
  const [backtest, setBacktest] = useState<BacktestMetrics | null>(null);
  const [promotion, setPromotion] = useState<ModelPromotionDecision | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adminToken, setAdminToken] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  async function load() {
    setError(null);
    try {
      const [nextMatches, nextMetrics, nextHealth, nextSignals] = await Promise.all([
        getTodayMatches(),
        getDailyMetrics(),
        getProviderHealth(),
        getLiveSignals()
      ]);
      const [nextCostProfile, nextCostReport] = await Promise.all([
        getCostProfile(),
        getDailyCostReport()
      ]);
      const [nextExecutionStatus, nextBankroll, nextOrders] = await Promise.all([
        getExecutionStatus(),
        getBankroll(),
        getOrders()
      ]);
      setMatches(nextMatches);
      setMetrics(nextMetrics);
      setCostProfile(nextCostProfile);
      setCostReport(nextCostReport);
      setExecutionStatus(nextExecutionStatus);
      setBankroll(nextBankroll);
      setOrders(nextOrders);
      setHealth(nextHealth);
      setSignals(nextSignals);
      setSelectedMatchId((current) => current ?? nextMatches[0]?.match.id ?? null);
      setUpdatedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar API");
    } finally {
      setLoading(false);
    }
  }

  async function triggerReplay() {
    if (!selectedMatchId) return;
    if (!adminToken.trim()) {
      setError("Informe o ADMIN_API_TOKEN para rodar replay operacional.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setReplay(await runReplay(selectedMatchId, adminToken.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Replay failed");
    } finally {
      setBusy(false);
    }
  }

  async function triggerBacktest() {
    if (!adminToken.trim()) {
      setError("Informe o ADMIN_API_TOKEN para rodar backtest operacional.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setBacktest(await runBacktest(adminToken.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backtest failed");
    } finally {
      setBusy(false);
    }
  }

  function requireAdminToken() {
    if (!adminToken.trim()) {
      setError("Informe o ADMIN_API_TOKEN para acoes operacionais.");
      return null;
    }
    return adminToken.trim();
  }

  async function triggerPaperOrder() {
    const token = requireAdminToken();
    const signal = selected ? bestSignal(selected) : null;
    if (!token || !signal) return;
    setBusy(true);
    setError(null);
    try {
      const order = await createPaperOrder(signal.id, token);
      setOrders((current) => [order, ...current]);
      setBankroll(await getBankroll());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Paper order failed");
    } finally {
      setBusy(false);
    }
  }

  async function triggerSubmitOrder() {
    const token = requireAdminToken();
    const signal = selected ? bestSignal(selected) : null;
    if (!token || !signal) return;
    setBusy(true);
    setError(null);
    try {
      const order = await submitOrder(signal.id, token);
      setOrders((current) => [order, ...current]);
      setExecutionStatus(await getExecutionStatus());
      setBankroll(await getBankroll());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit order failed");
    } finally {
      setBusy(false);
    }
  }

  async function triggerKillSwitch(enabled: boolean) {
    const token = requireAdminToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      setExecutionStatus(await setKillSwitch(enabled, token));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kill switch update failed");
    } finally {
      setBusy(false);
    }
  }

  async function triggerLearningPromotion() {
    const token = requireAdminToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      setPromotion(await promoteFromLearning(token));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Learning promotion failed");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    const id = window.setInterval(load, 15000);
    return () => window.clearInterval(id);
  }, []);

  const selected = useMemo(
    () => matches.find((analysis) => analysis.match.id === selectedMatchId) ?? matches[0],
    [matches, selectedMatchId]
  );

  const entries = useMemo(
    () => signals.filter((signal) => signal.status === "Entrada"),
    [signals]
  );

  const selectedSignal = selected ? bestSignal(selected) : null;

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Private enterprise tennis trading desk</p>
          <h1>Tennis Live Edge</h1>
        </div>
        <div className="topActions">
          <span className="timestamp">
            <LockKeyhole size={16} />
            Private domain path
          </span>
          <span className="timestamp">
            <Timer size={16} />
            {updatedAt ? updatedAt.toLocaleTimeString("pt-BR") : "aguardando"}
          </span>
          <button className="iconButton" onClick={load} aria-label="Atualizar dashboard">
            <RefreshCcw size={18} />
          </button>
        </div>
      </section>

      {error ? (
        <section className="notice">
          <AlertTriangle size={18} />
          <span>{error}</span>
        </section>
      ) : null}

      <section className="metricsGrid">
        <div className="metric">
          <Activity size={18} />
          <span>Jogos</span>
          <strong>{metrics?.matches ?? (loading ? "-" : matches.length)}</strong>
        </div>
        <div className="metric">
          <TrendingUp size={18} />
          <span>Entradas</span>
          <strong>{metrics?.entry_signals ?? entries.length}</strong>
        </div>
        <div className="metric">
          <CircleDollarSign size={18} />
          <span>Edge medio</span>
          <strong>{metrics ? pct(metrics.average_edge) : "-"}</strong>
        </div>
        <div className="metric">
          <ShieldCheck size={18} />
          <span>Conf. modelo</span>
          <strong>{metrics ? pct(metrics.average_model_confidence) : "-"}</strong>
        </div>
        <div className="metric">
          <CircleDollarSign size={18} />
          <span>Perfil custo</span>
          <strong>{costProfile ? usd(costProfile.estimated_monthly_spend_usd) : "-"}</strong>
        </div>
      </section>

      <section className="contentGrid">
        <div className="panel wide">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Live board</p>
              <h2>Probabilidade, mercado e signal gate</h2>
            </div>
            <BarChart3 size={20} />
          </div>

          <div className="matchList">
            {matches.map((analysis) => {
              const signal = bestSignal(analysis);
              const p1 = analysis.match.player1;
              const p2 = analysis.match.player2;
              const isSelected = selected?.match.id === analysis.match.id;
              return (
                <button
                  className={isSelected ? "matchRow selectedMatch" : "matchRow"}
                  key={analysis.match.id}
                  onClick={() => setSelectedMatchId(analysis.match.id)}
                >
                  <div className="matchMeta">
                    <span>{analysis.match.competition_level}</span>
                    <span>{analysis.match.tournament}</span>
                    <span>{analysis.match.round}</span>
                    <span>{analysis.match.surface}</span>
                    <span>DQ {pct(analysis.features.data_quality)}</span>
                    <span>{analysis.features.provider_count} feeds</span>
                  </div>
                  <div className="scoreLine">
                    <strong>
                      {analysis.match.state.status === "live"
                        ? `${analysis.match.state.p1_sets}-${analysis.match.state.p2_sets} sets · ${analysis.match.state.p1_games}-${analysis.match.state.p2_games} games · ${analysis.match.state.point_score}`
                        : new Date(analysis.match.scheduled_at).toLocaleTimeString("pt-BR", {
                            hour: "2-digit",
                            minute: "2-digit"
                          })}
                    </strong>
                    <span className={analysis.match.state.status === "live" ? "liveDot" : "preDot"} />
                  </div>
                  <div className="players">
                    {[p1, p2].map((player) => (
                      <div className="playerLine" key={player.id}>
                        <div>
                          <strong>{player.name}</strong>
                          <span>
                            #{player.ranking ?? "-"} · hold {pct(player.hold_rate)} · break{" "}
                            {pct(player.break_rate)}
                          </span>
                        </div>
                        <div className="probBlock">
                          <strong>{pct(playerProbability(analysis, player.id))}</strong>
                          <span>modelo</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  {signal ? (
                    <div className="signalLine">
                      <span className={statusClass(signal.status)}>{signal.status}</span>
                      <span>{signal.player_name}</span>
                      <span>odd {signal.best_odds.toFixed(2)}</span>
                      <span>edge {pct(signal.edge)}</span>
                      <span>thr {pct(signal.threshold)}</span>
                      <span>stake {pct(signal.stake_fraction)}</span>
                    </div>
                  ) : (
                    <div className="signalLine muted">Sem mercado ML completo</div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <aside className="sideStack">
          <section className="panel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Cost profile</p>
                <h2>{costProfile?.active_plan ?? "lean_atp"}</h2>
              </div>
              <CircleDollarSign size={20} />
            </div>
            <div className="costGrid">
              <span>Budget</span>
              <strong>{costProfile ? usd(costProfile.monthly_budget_usd) : "-"}</strong>
              <span>Projected</span>
              <strong>{costProfile ? usd(costProfile.estimated_monthly_spend_usd) : "-"}</strong>
              <span>Skipped</span>
              <strong>{costReport?.matches_skipped_by_coverage ?? "-"}</strong>
              <span>WS uptime</span>
              <strong>{costReport ? pct(costReport.websocket_uptime_pct) : "-"}</strong>
              <span>Signals</span>
              <strong>{costReport?.signals_generated ?? "-"}</strong>
              <span>Cost/signal</span>
              <strong>{costReport ? usd(costReport.cost_per_signal_usd) : "-"}</strong>
            </div>
            <div className="providerChips">
              {costProfile?.enabled_providers.map((provider) => (
                <span key={provider}>{provider}</span>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Betfair execution</p>
                <h2>{executionStatus?.stage ?? "paper"}</h2>
              </div>
              <ShieldCheck size={20} />
            </div>
            <div className="executionGrid">
              <span>Venue</span>
              <strong>{executionStatus?.venue ?? "betfair"}</strong>
              <span>Real enabled</span>
              <strong>{executionStatus?.can_submit_real_orders ? "ready" : "blocked"}</strong>
              <span>Bankroll</span>
              <strong>
                {bankroll ? `${bankroll.base_currency} ${bankroll.bankroll_amount.toFixed(0)}` : "-"}
              </strong>
              <span>Open exposure</span>
              <strong>
                {bankroll ? `${bankroll.base_currency} ${bankroll.open_exposure.toFixed(0)}` : "-"}
              </strong>
              <span>CLV</span>
              <strong>{bankroll?.clv === null || bankroll?.clv === undefined ? "-" : pct(bankroll.clv)}</strong>
            </div>
            <div className="executionWarnings">
              {executionStatus?.reasons.slice(0, 3).map((reason) => (
                <span key={reason}>{reason}</span>
              ))}
            </div>
            <div className="executionActions">
              <button onClick={triggerPaperOrder} disabled={busy || !selectedSignal}>
                Paper order
              </button>
              <button onClick={triggerSubmitOrder} disabled={busy || !selectedSignal}>
                Submit Betfair
              </button>
              <button
                className={executionStatus?.kill_switch_enabled ? "dangerGhost" : ""}
                onClick={() => triggerKillSwitch(!executionStatus?.kill_switch_enabled)}
                disabled={busy}
              >
                {executionStatus?.kill_switch_enabled ? "Reset kill" : "Kill switch"}
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Provider health</p>
                <h2>Feeds enterprise</h2>
              </div>
              <DatabaseZap size={20} />
            </div>
            <div className="healthList">
              {health.map((provider) => (
                <div className="healthRow" key={provider.provider}>
                  <div>
                    <strong>{provider.provider}</strong>
                    <span>{provider.status}</span>
                  </div>
                  <span className={provider.healthy ? "status statusEntry" : "status statusBlocked"}>
                    {provider.configured ? "live" : provider.cost_tier.includes("deferred") ? "off" : "sample"}
                  </span>
                  <span>{provider.quota_limit ? `${provider.quota_used ?? 0}/${provider.quota_limit}` : provider.cost_tier}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Risk</p>
                <h2>Entradas ativas</h2>
              </div>
              <ShieldCheck size={20} />
            </div>
            <div className="entryList">
              {entries.length ? (
                entries.map((signal) => (
                  <div className="entry" key={signal.id}>
                    <div>
                      <strong>{signal.player_name}</strong>
                      <span>{signal.reason}</span>
                    </div>
                    <div className="entryNumbers">
                      <span>EV {pct(signal.edge)}</span>
                      <span>Stake {pct(signal.stake_fraction)}</span>
                    </div>
                  </div>
                ))
              ) : (
                <p className="empty">Nenhuma entrada acima do threshold agora.</p>
              )}
            </div>
          </section>
        </aside>
      </section>

      <section className="lowerGrid">
        <section className="panel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Match detail</p>
              <h2>{selected ? `${selected.match.player1.name} vs ${selected.match.player2.name}` : "Selecione jogo"}</h2>
            </div>
            <Zap size={20} />
          </div>
          {selected ? (
            <div className="detailBody">
              <div className="detailGrid">
                <span>Data quality</span>
                <strong>{pct(selected.features.data_quality)}</strong>
                <span>Odds latency</span>
                <strong>{selected.features.odds_latency_ms ?? "-"}ms</strong>
                <span>Market volatility</span>
                <strong>{pct(selected.features.market_volatility)}</strong>
                <span>Live pressure</span>
                <strong>{selected.features.live_score_pressure.toFixed(3)}</strong>
              </div>
              <div className="explainList">
                {selected.prediction.explanations.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
              <div className="oddsStrip">
                {selected.match.odds.map((quote) => (
                  <span key={`${quote.bookmaker}-${quote.player_id}-${quote.decimal_odds}`}>
                    {quote.bookmaker} {quote.player_id}: {quote.decimal_odds.toFixed(2)}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Replay lab</p>
              <h2>Backtest e determinismo</h2>
            </div>
            <Play size={20} />
          </div>
          <div className="labActions">
            <input
              aria-label="Admin API token"
              autoComplete="off"
              onChange={(event) => setAdminToken(event.target.value)}
              placeholder="Admin token"
              type="password"
              value={adminToken}
            />
            <button onClick={triggerReplay} disabled={busy || !selectedMatchId}>
              Run replay
            </button>
            <button onClick={triggerBacktest} disabled={busy}>
              Run backtest
            </button>
            <button onClick={triggerLearningPromotion} disabled={busy}>
              Promote learning
            </button>
          </div>
          <div className="labResults">
            {replay ? (
              <div className="labCard">
                <strong>{replay.run_id}</strong>
                <span>
                  {replay.events_replayed} events · {replay.score_ticks} score ticks ·{" "}
                  {replay.odds_ticks} odds ticks
                </span>
              </div>
            ) : null}
            {backtest ? (
              <div className="labCard">
                <strong>{backtest.model_version}</strong>
                <span>
                  ROI {pct(backtest.roi)} · CLV {pct(backtest.clv)} · Brier{" "}
                  {backtest.brier_score.toFixed(3)}
                </span>
                <span className={backtest.promoted ? "status statusEntry" : "status statusBlocked"}>
                  {backtest.promoted ? "promotion-ready" : "blocked"}
                </span>
              </div>
            ) : null}
            {promotion ? (
              <div className="labCard">
                <strong>{promotion.candidate_model_version}</strong>
                <span>
                  ROI {pct(promotion.metrics.roi)} · CLV {pct(promotion.metrics.clv)} ·
                  Drawdown {pct(promotion.metrics.max_drawdown)}
                </span>
                <span className={promotion.promoted ? "status statusEntry" : "status statusBlocked"}>
                  {promotion.promoted ? "learning-promoted" : "learning-blocked"}
                </span>
              </div>
            ) : null}
            <div className="orderJournal">
              {orders.slice(0, 5).map((order) => (
                <div className="orderRow" key={order.id}>
                  <div>
                    <strong>{order.player_name}</strong>
                    <span>
                      {order.venue} · {order.side} · odd {order.requested_odds.toFixed(2)}
                    </span>
                  </div>
                  <span className={order.status === "execution_blocked" ? "status statusBlocked" : "status statusMonitor"}>
                    {order.status}
                  </span>
                  <strong>
                    {bankroll?.base_currency ?? "$"} {order.stake_amount.toFixed(0)}
                  </strong>
                </div>
              ))}
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
