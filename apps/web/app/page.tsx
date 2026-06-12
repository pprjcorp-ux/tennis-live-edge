"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  CircleDollarSign,
  Cpu,
  DatabaseZap,
  GitCompareArrows,
  LineChart,
  LockKeyhole,
  MessageCircle,
  Play,
  RefreshCcw,
  ShieldCheck,
  Timer,
  TrendingUp,
  Zap
} from "lucide-react";
import { DataHealthPanel } from "@/app/components/data-health-panel";
import {
  autoSettlePaperOrders,
  createPaperOrder,
  getAgentAnomalies,
  getAgentBriefing,
  getAgentPreflightSafe,
  getAgentRuns,
  getCalibrationReport,
  getBankroll,
  getChampionModel,
  getEntityConflicts,
  getExecutionStatus,
  getLiveDashboard,
  getModelRegistry,
  getOrders,
  getPaperPerformance,
  promoteFromLearning,
  runAgentAutopilot,
  runBacktest,
  runDailyOperationalLoop,
  runReplay,
  runReplayContracts,
  settlePaperOrder,
  setKillSwitch,
  submitOrder
} from "@/lib/api";
import type {
  AgentAnomaly,
  AgentAutopilotResult,
  AgentBriefing,
  AgentPreflight,
  AgentRun,
  ApiOnboardingSnapshot,
  AutoPaperSettleResult,
  BacktestMetrics,
  BankrollSnapshot,
  CalibrationReport,
  CanonicalEntityConflict,
  CostProfile,
  DailyMetrics,
  DailyCostReport,
  DailyOperationalRunResult,
  DataQualitySnapshot,
  ExecutionOrder,
  ExecutionStatus,
  IngestionRunRecord,
  LiveReadinessSnapshot,
  MatchAnalysis,
  ModelLabReadinessSnapshot,
  ModelRegistryEntry,
  ModelPromotionDecision,
  OperationalStateSnapshot,
  PaperPerformance,
  ProviderCursor,
  ProviderHealth,
  ProviderModeStep,
  ReplayContractRunResult,
  ReplayLabSnapshot,
  ReplayOddsScenario,
  ReplayRunResult,
  Signal
} from "@/lib/types";

type FreshnessSource = NonNullable<MatchAnalysis["freshness"]>["source"];

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function usd(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return `$${value.toFixed(0)}`;
}

function ageLabel(valueMs: number | null | undefined) {
  if (valueMs === null || valueMs === undefined) return "n/a";
  if (valueMs < 1000) return `${valueMs}ms`;
  if (valueMs < 60_000) return `${Math.round(valueMs / 1000)}s`;
  if (valueMs < 3_600_000) return `${Math.round(valueMs / 60_000)}m`;
  return `${Math.round(valueMs / 3_600_000)}h`;
}

function statusClass(status: Signal["status"]) {
  if (status === "Entrada") return "status statusEntry";
  if (status === "Monitorar") return "status statusMonitor";
  if (status === "Bloqueado") return "status statusBlocked";
  return "status statusMuted";
}

function preflightStatusClass(
  status:
    | AgentPreflight["status"]
    | AgentPreflight["checks"][number]["status"]
    | ModelLabReadinessSnapshot["status"]
) {
  if (status === "ready" || status === "pass") return "status statusEntry";
  if (status === "degraded" || status === "warn" || status === "collecting") return "status statusMonitor";
  return "status statusBlocked";
}

function providerModeClass(mode: OperationalStateSnapshot["provider_mode"]) {
  if (mode === "live_with_keys") return "status statusEntry";
  if (mode === "replay") return "status statusMonitor";
  if (mode === "live_without_keys") return "status statusBlocked";
  return "status statusMuted";
}

function providerModeLabel(mode: OperationalStateSnapshot["provider_mode"]) {
  return mode;
}

function freshnessClass(source: FreshnessSource | undefined) {
  if (source === "provider_live") return "status statusEntry";
  if (source === "persisted_fallback") return "status statusMonitor";
  if (source === "empty") return "status statusBlocked";
  return "status statusMuted";
}

function cursorClass(cursor: ProviderCursor | undefined) {
  if (!cursor) return "status statusBlocked";
  if (cursor.resync_required || cursor.status === "gap_detected" || cursor.status === "resync_required") {
    return "status statusBlocked";
  }
  if (cursor.status === "resynced") return "status statusMonitor";
  return "status statusEntry";
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
  const [dataQuality, setDataQuality] = useState<DataQualitySnapshot[]>([]);
  const [ingestionRuns, setIngestionRuns] = useState<IngestionRunRecord[]>([]);
  const [providerCursors, setProviderCursors] = useState<ProviderCursor[]>([]);
  const [apiOnboarding, setApiOnboarding] = useState<ApiOnboardingSnapshot>({
    core_ready: false,
    current_step: "loading",
    steps: [],
    warnings: ["Awaiting operational state."]
  });
  const [modelLab, setModelLab] = useState<ModelLabReadinessSnapshot>({
    status: "blocked",
    source: "training_examples",
    model_version: "prematch_ensemble_v1",
    feature_set: "live_budget_v1",
    training_examples: 0,
    can_run_live_backtest: false,
    reasons: ["Awaiting operational state."]
  });
  const [providerModeMatrix, setProviderModeMatrix] = useState<ProviderModeStep[]>([]);
  const [replayLab, setReplayLab] = useState<ReplayLabSnapshot>({
    status: "collecting",
    source: "budget_replay_fixtures",
    providers: [],
    scenarios: ["healthy", "gap", "resync_required"],
    last_contract_run_id: null,
    last_contract_status: null,
    last_contract_passed: false,
    last_contract_scenarios: [],
    last_replay_run_id: null,
    last_replay_status: null,
    last_replay_events: 0,
    last_replay_score_ticks: 0,
    last_replay_odds_ticks: 0,
    last_replay_resync_required: false,
    can_validate_without_live_keys: true,
    notes: ["Awaiting operational state."]
  });
  const [providerMode, setProviderMode] =
    useState<OperationalStateSnapshot["provider_mode"]>("sample");
  const [providerModeReason, setProviderModeReason] = useState("Awaiting operational state.");
  const [modelRegistry, setModelRegistry] = useState<ModelRegistryEntry[]>([]);
  const [championModel, setChampionModel] = useState<ModelRegistryEntry | null>(null);
  const [calibration, setCalibration] = useState<CalibrationReport | null>(null);
  const [paperPerformance, setPaperPerformance] = useState<PaperPerformance | null>(null);
  const [autoSettlement, setAutoSettlement] = useState<AutoPaperSettleResult | null>(null);
  const [dailyOperationalRun, setDailyOperationalRun] = useState<DailyOperationalRunResult | null>(null);
  const [agentBriefing, setAgentBriefing] = useState<AgentBriefing | null>(null);
  const [agentPreflight, setAgentPreflight] = useState<AgentPreflight | null>(null);
  const [agentAnomalies, setAgentAnomalies] = useState<AgentAnomaly[]>([]);
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [autopilotResult, setAutopilotResult] = useState<AgentAutopilotResult | null>(null);
  const [entityConflicts, setEntityConflicts] = useState<CanonicalEntityConflict[]>([]);
  const [executionStatus, setExecutionStatus] = useState<ExecutionStatus | null>(null);
  const [readiness, setReadiness] = useState<LiveReadinessSnapshot | null>(null);
  const [bankroll, setBankroll] = useState<BankrollSnapshot | null>(null);
  const [orders, setOrders] = useState<ExecutionOrder[]>([]);
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [replayOddsScenario, setReplayOddsScenario] = useState<ReplayOddsScenario>("healthy");
  const [replay, setReplay] = useState<ReplayRunResult | null>(null);
  const [replayContract, setReplayContract] = useState<ReplayContractRunResult | null>(null);
  const [replayContractBusy, setReplayContractBusy] = useState(false);
  const [dailyOpsBusy, setDailyOpsBusy] = useState(false);
  const [backtest, setBacktest] = useState<BacktestMetrics | null>(null);
  const [promotion, setPromotion] = useState<ModelPromotionDecision | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adminToken, setAdminToken] = useState("");
  const [activeDesk, setActiveDesk] = useState<
    "data" | "models" | "paper" | "agent" | "resolution" | "risk"
  >("data");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  async function load() {
    setError(null);
    try {
      const [
        nextDashboard,
        nextModelRegistry,
        nextChampionModel,
        nextPaperPerformance,
        nextAgentBriefing,
        nextAgentPreflight,
        nextAgentAnomalies,
        nextAgentRuns,
        nextEntityConflicts,
        nextBankroll,
        nextOrders
      ] = await Promise.all([
        getLiveDashboard(),
        getModelRegistry(),
        getChampionModel(),
        getPaperPerformance(),
        getAgentBriefing(),
        getAgentPreflightSafe(),
        getAgentAnomalies(),
        getAgentRuns(),
        getEntityConflicts(),
        getBankroll(),
        getOrders()
      ]);
      const nextOperational = nextDashboard.operational_state;
      setMatches(nextDashboard.matches);
      setMetrics(nextDashboard.metrics);
      setCostProfile(nextOperational.cost_profile);
      setCostReport(nextOperational.daily_cost_report);
      setDataQuality(nextOperational.data_quality);
      setIngestionRuns(nextOperational.ingestion_runs);
      setProviderCursors(nextOperational.provider_cursors);
      setApiOnboarding(nextOperational.api_onboarding);
      setModelLab(nextOperational.model_lab);
      setProviderModeMatrix(nextOperational.provider_mode_matrix);
      setReplayLab(nextOperational.replay_lab);
      setProviderMode(nextOperational.provider_mode);
      setProviderModeReason(nextOperational.provider_mode_reason);
      setModelRegistry(nextModelRegistry);
      setChampionModel(nextChampionModel);
      setPaperPerformance(nextPaperPerformance);
      setAgentBriefing(nextAgentBriefing);
      setAgentPreflight(nextAgentPreflight);
      setAgentAnomalies(nextAgentAnomalies);
      setAgentRuns(nextAgentRuns);
      setEntityConflicts(nextEntityConflicts);
      setExecutionStatus(nextOperational.execution_status);
      setReadiness(nextDashboard.readiness);
      setBankroll(nextBankroll);
      setOrders(nextOrders);
      setHealth(nextOperational.provider_health);
      setSignals(nextDashboard.signals);
      setSelectedMatchId((current) => current ?? nextDashboard.matches[0]?.match.id ?? null);
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
      setReplay(await runReplay(selectedMatchId, adminToken.trim(), replayOddsScenario));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Replay failed");
    } finally {
      setBusy(false);
    }
  }

  async function triggerReplayContracts() {
    const token = requireAdminToken();
    if (!token) return;
    setBusy(true);
    setReplayContractBusy(true);
    setError(null);
    try {
      const result = await runReplayContracts(selectedMatchId ?? "match_atp_002", token);
      setReplayContract(result);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Replay contract failed");
    } finally {
      setReplayContractBusy(false);
      setBusy(false);
    }
  }

  async function triggerDailyOperationalRun() {
    const token = requireAdminToken();
    if (!token) return;
    setBusy(true);
    setDailyOpsBusy(true);
    setError(null);
    try {
      const result = await runDailyOperationalLoop(token, selectedMatchId ?? "match_atp_002", 100);
      setDailyOperationalRun(result);
      setReplayContract(result.replay_contracts);
      setAutoSettlement(result.paper_auto_settlement);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Daily operational run failed");
    } finally {
      setDailyOpsBusy(false);
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
      const result = await runBacktest(adminToken.trim());
      setBacktest(result);
      setCalibration(await getCalibrationReport(result.run_id));
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
      setPaperPerformance(await getPaperPerformance());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Paper order failed");
    } finally {
      setBusy(false);
    }
  }

  async function triggerAgentAutopilot() {
    const token = requireAdminToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runAgentAutopilot(token, {
        source: "dashboard",
        create_paper_orders: true,
        request_real_execution: false,
        max_paper_orders: 3,
        notes: "dashboard manual openclaw autopilot"
      });
      setAutopilotResult(result);
      const [
        nextOrders,
        nextBankroll,
        nextPaperPerformance,
        nextBriefing,
        nextPreflight,
        nextRuns,
        nextAnomalies
      ] = await Promise.all([
          getOrders(),
          getBankroll(),
          getPaperPerformance(),
          getAgentBriefing(),
          getAgentPreflightSafe(),
          getAgentRuns(),
          getAgentAnomalies()
        ]);
      setOrders(nextOrders);
      setBankroll(nextBankroll);
      setPaperPerformance(nextPaperPerformance);
      setAgentBriefing(nextBriefing);
      setAgentPreflight(nextPreflight);
      setAgentRuns(nextRuns);
      setAgentAnomalies(nextAnomalies);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent autopilot failed");
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
      setPaperPerformance(await getPaperPerformance());
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

  async function triggerPaperSettlement(order: ExecutionOrder, resultWin: boolean) {
    const token = requireAdminToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const closingOdds = Math.max(1.01, order.requested_odds - 0.03);
      await settlePaperOrder(order.id, resultWin, closingOdds, token);
      setOrders(await getOrders());
      setBankroll(await getBankroll());
      setPaperPerformance(await getPaperPerformance());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Paper settlement failed");
    } finally {
      setBusy(false);
    }
  }

  async function triggerAutoPaperSettlement() {
    const token = requireAdminToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const result = await autoSettlePaperOrders(token, selectedMatchId ?? undefined, 100);
      setAutoSettlement(result);
      setOrders(await getOrders());
      setBankroll(await getBankroll());
      setPaperPerformance(await getPaperPerformance());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auto paper settlement failed");
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
  const readinessMessages =
    readiness && readiness.blockers.length > 0
      ? readiness.blockers
      : readiness?.warnings.length
        ? readiness.warnings
        : ["Paper-first readiness checks passing."];
  const readinessPanelMessages = [providerModeReason, ...readinessMessages].filter(Boolean);
  const oddsCursor = providerCursors.find((cursor) => cursor.provider === "odds_api_io");
  const selectedFreshness = selected?.freshness;
  const selectedLineage = selectedFreshness?.provider_lineage.join(", ") || "-";

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

      <section className="operationalStrip" aria-label="Estado operacional dos dados">
        <div className="opsCell">
          <div>
            <span>Provider mode</span>
            <strong className={providerModeClass(providerMode)}>{providerModeLabel(providerMode)}</strong>
          </div>
          <p>{providerModeReason}</p>
        </div>
        <div className="opsCell">
          <div>
            <span>Readiness</span>
            <strong className={preflightStatusClass(readiness?.status ?? "blocked")}>
              {readiness?.status ?? "blocked"}
            </strong>
          </div>
          <p>
            analyze {readiness?.can_analyze_live ? "yes" : "no"} · entries{" "}
            {readiness?.can_generate_entries ? "ready" : "blocked"} · real{" "}
            {readiness?.can_submit_real_orders ? "enabled" : "hard-blocked"}
          </p>
        </div>
        <div className="opsCell">
          <div>
            <span>Odds cursor</span>
            <strong className={cursorClass(oddsCursor)}>
              {oddsCursor?.status ?? "missing"}
            </strong>
          </div>
          <p>
            seq {oddsCursor?.last_seq ?? "none"} · next{" "}
            {oddsCursor?.expected_next_seq ?? "none"} · gaps {oddsCursor?.gap_count ?? 0}
          </p>
        </div>
        <div className="opsCell">
          <div>
            <span>Selected freshness</span>
            <strong className={freshnessClass(selectedFreshness?.source)}>
              {selectedFreshness?.source ?? "empty"}
            </strong>
          </div>
          <p>
            score {ageLabel(selectedFreshness?.score_age_ms)} · odds{" "}
            {ageLabel(selectedFreshness?.odds_age_ms)} · {selectedLineage}
          </p>
        </div>
      </section>

      <section className="enterpriseTabs" aria-label="Enterprise operations">
        {[
          ["data", "Data Health"],
          ["models", "Model Lab"],
          ["paper", "Paper Trading"],
          ["agent", "OpenClaw Autopilot"],
          ["resolution", "Entity Resolution"],
          ["risk", "Risk/Bankroll"]
        ].map(([id, label]) => (
          <button
            key={id}
            className={activeDesk === id ? "activeTab" : ""}
            onClick={() => setActiveDesk(id as typeof activeDesk)}
          >
            {label}
          </button>
        ))}
      </section>

      <section className="enterprisePanel">
        {activeDesk === "data" ? (
          <DataHealthPanel
            apiOnboarding={apiOnboarding}
            dataQuality={dataQuality}
            dailyOperationalRun={dailyOperationalRun}
            dailyOpsBusy={dailyOpsBusy}
            ingestionRuns={ingestionRuns}
            onRunDailyOperational={triggerDailyOperationalRun}
            onRunReplayContracts={triggerReplayContracts}
            providerModeMatrix={providerModeMatrix}
            providerModeReason={providerModeReason}
            providerCursors={providerCursors}
            replayContractBusy={replayContractBusy}
            replayLab={replayLab}
          />
        ) : null}

        {activeDesk === "models" ? (
          <div className="enterpriseGrid">
            <div className="panel wide">
              <div className="panelHeader">
                <div>
                  <p className="eyebrow">Training Dataset</p>
                  <h2>{modelLab.source}</h2>
                </div>
                <DatabaseZap size={20} />
              </div>
              <div className="modelLabDataset">
                <span className={preflightStatusClass(modelLab.status)}>{modelLab.status}</span>
                <span>{modelLab.training_examples} settled examples</span>
                <span>{modelLab.model_version}</span>
                <span>{modelLab.feature_set}</span>
                <span>{modelLab.can_run_live_backtest ? "live backtest ready" : "live backtest blocked"}</span>
              </div>
              <div className="executionWarnings">
                {modelLab.reasons.length ? (
                  modelLab.reasons.map((reason) => <span key={reason}>{reason}</span>)
                ) : (
                  <span>Model Lab is reading persisted training_examples for this feature set.</span>
                )}
              </div>
            </div>
            <div className="panel">
              <div className="panelHeader">
                <div>
                  <p className="eyebrow">Model Lab</p>
                  <h2>Champion vs challengers</h2>
                </div>
                <LineChart size={20} />
              </div>
              <div className="modelRows">
                {modelRegistry.map((model) => (
                  <div className="modelRow" key={model.model_version}>
                    <div>
                      <strong>{model.model_version}</strong>
                      <span>{model.model_type}</span>
                    </div>
                    <span className={model.role === "champion" ? "status statusEntry" : "status statusMonitor"}>
                      {model.role}
                    </span>
                    <span>ROI {pct(model.metrics.roi)}</span>
                    <span>CLV {pct(model.metrics.clv)}</span>
                    <span>Brier {model.metrics.brier_score.toFixed(3)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel">
              <div className="panelHeader">
                <div>
                  <p className="eyebrow">Calibration</p>
                  <h2>{calibration?.model_version ?? championModel?.model_version ?? "baseline_v0"}</h2>
                </div>
                <BarChart3 size={20} />
              </div>
              {calibration ? (
                <div className="calibrationRows">
                  {calibration.buckets.map((bucket) => (
                    <div className="calibrationRow" key={bucket.bucket}>
                      <span>{bucket.bucket}</span>
                      <span>pred {pct(bucket.average_prediction)}</span>
                      <span>obs {pct(bucket.observed_win_rate)}</span>
                      <span>{bucket.predictions} picks</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="empty">Rode um backtest para gerar curva de calibracao.</p>
              )}
            </div>
          </div>
        ) : null}

        {activeDesk === "paper" ? (
          <div className="enterpriseGrid">
            <div className="panel">
              <div className="panelHeader">
                <div>
                  <p className="eyebrow">Paper Trading</p>
                  <h2>ROI, CLV e readiness</h2>
                </div>
                <CircleDollarSign size={20} />
              </div>
              <div className="paperStats">
                <span>Orders</span>
                <strong>{paperPerformance?.orders ?? 0}</strong>
                <span>Settled</span>
                <strong>{paperPerformance?.settled_orders ?? 0}</strong>
                <span>ROI</span>
                <strong>{paperPerformance?.roi === null || paperPerformance?.roi === undefined ? "-" : pct(paperPerformance.roi)}</strong>
                <span>CLV</span>
                <strong>{paperPerformance?.clv === null || paperPerformance?.clv === undefined ? "-" : pct(paperPerformance.clv)}</strong>
              </div>
              <div className="executionWarnings">
                {paperPerformance?.readiness_reasons.map((reason) => (
                  <span key={reason}>{reason}</span>
                ))}
              </div>
              <div className="paperAutoSettle">
                <button onClick={triggerAutoPaperSettlement} disabled={busy}>
                  Auto-settle paper
                </button>
                <span>
                  Uses persisted final score and pre-result closing odds for{" "}
                  {selectedMatchId ? selectedMatchId : "all matches"}.
                </span>
              </div>
              {autoSettlement ? (
                <div className="autoSettlementResult">
                  <span>evaluated {autoSettlement.evaluated_orders}</span>
                  <span>settled {autoSettlement.settled_orders}</span>
                  <span>skipped {autoSettlement.skipped_orders}</span>
                  <span>{autoSettlement.training_examples_ready} training examples ready</span>
                  {autoSettlement.reasons.slice(0, 3).map((reason) => (
                    <span key={reason}>{reason}</span>
                  ))}
                </div>
              ) : null}
              <div className="segmentTable">
                {(paperPerformance?.segments ?? []).slice(0, 12).map((segment) => (
                  <div className="segmentRow" key={`${segment.segment_type}-${segment.segment}`}>
                    <span>{segment.segment_type}</span>
                    <strong>{segment.segment}</strong>
                    <span>{segment.settled_orders} settled</span>
                    <span>ROI {segment.roi === null ? "-" : pct(segment.roi)}</span>
                    <span>CLV {segment.clv === null ? "-" : pct(segment.clv)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel">
              <div className="panelHeader">
                <div>
                  <p className="eyebrow">CLV/ROI Journal</p>
                  <h2>Latest paper fills</h2>
                </div>
                <Activity size={20} />
              </div>
              <div className="orderJournal">
                {orders.slice(0, 6).map((order) => (
                  <div className="orderRow" key={order.id}>
                    <div>
                      <strong>{order.player_name}</strong>
                      <span>
                        {order.status} · matched {order.matched_stake.toFixed(0)} · CLV{" "}
                        {order.clv === null || order.clv === undefined ? "-" : pct(order.clv)}
                      </span>
                    </div>
                    {order.status !== "settled" ? (
                      <div className="settleActions">
                        <button onClick={() => triggerPaperSettlement(order, true)} disabled={busy}>
                          Win
                        </button>
                        <button onClick={() => triggerPaperSettlement(order, false)} disabled={busy}>
                          Loss
                        </button>
                      </div>
                    ) : (
                      <strong>{usd(order.pnl)}</strong>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {activeDesk === "agent" ? (
          <div className="enterpriseGrid">
            <div className="panel">
              <div className="panelHeader">
                <div>
                  <p className="eyebrow">OpenClaw Autopilot</p>
                  <h2>Dashboard + Telegram paper ops</h2>
                </div>
                <Bot size={20} />
              </div>
              <div className="agentStats">
                {[
                  ["Status", agentBriefing?.autopilot_enabled ? "enabled" : "disabled"],
                  ["Preflight", agentPreflight?.status ?? "unknown"],
                  ["Channel", agentBriefing?.channel ?? "dashboard,telegram"],
                  ["Triage", agentBriefing?.triage_model ?? "gpt-5.4-mini"],
                  ["Critical", agentBriefing?.critical_model ?? "gpt-5.5"],
                  ["Alerts", String(agentBriefing?.provider_alerts ?? agentAnomalies.length)],
                  ["Paper orders", String(agentBriefing?.paper_orders ?? 0)]
                ].map(([label, value]) => (
                  <div className="agentStat" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              <div className="agentSummary">
                <p>{agentBriefing?.summary ?? "OpenClaw aguardando briefing da API local."}</p>
                <div className="agentActionBar">
                  <button onClick={triggerAgentAutopilot} disabled={busy}>
                    <Play size={15} />
                    Run paper autopilot
                  </button>
                  <span>
                    <Cpu size={14} />
                    Router {agentBriefing?.router_policy ?? "cost_optimized"}
                  </span>
                  <span>
                    <MessageCircle size={14} />
                    Telegram allowlist only
                  </span>
                </div>
              </div>
              <div className="preflightRows">
                {agentPreflight?.checks.map((check) => (
                  <div className="preflightRow" key={check.name}>
                    <div>
                      <strong>{check.name.replaceAll("_", " ")}</strong>
                      <span>{check.detail ? `${check.summary} ${check.detail}` : check.summary}</span>
                    </div>
                    <span className={preflightStatusClass(check.status)}>{check.status}</span>
                  </div>
                )) ?? <p className="empty">Preflight operacional aguardando API local.</p>}
              </div>
              <div className="agentAllowed">
                {agentBriefing?.allowed_actions.map((action) => (
                  <span key={action}>{action}</span>
                ))}
              </div>
              {autopilotResult ? (
                <div className="agentResult">
                  <strong>{autopilotResult.run.summary}</strong>
                  <span>
                    created {autopilotResult.paper_orders_created} · skipped{" "}
                    {autopilotResult.paper_orders_skipped} · real blocked{" "}
                    {autopilotResult.real_execution_blocked ? "yes" : "no"}
                  </span>
                </div>
              ) : null}
            </div>

            <div className="panel">
              <div className="panelHeader">
                <div>
                  <p className="eyebrow">Agent Ops</p>
                  <h2>Anomalies and audit runs</h2>
                </div>
                <AlertTriangle size={20} />
              </div>
              <div className="anomalyRows">
                {agentAnomalies.length ? (
                  agentAnomalies.slice(0, 5).map((anomaly) => (
                    <div className="anomalyRow" key={anomaly.id}>
                      <div>
                        <strong>{anomaly.summary}</strong>
                        <span>{anomaly.detail}</span>
                      </div>
                      <span className={anomaly.severity === "critical" ? "status statusBlocked" : "status statusMonitor"}>
                        {anomaly.severity}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="empty">Nenhuma anomalia operacional ativa.</p>
                )}
              </div>
              <div className="runRows">
                {(agentRuns.length ? agentRuns : agentBriefing?.latest_run ? [agentBriefing.latest_run] : []).slice(0, 4).map((run) => (
                  <div className="runRow" key={run.id}>
                    <div>
                      <strong>{run.run_type}</strong>
                      <span>{run.summary}</span>
                    </div>
                    <span>{run.source}</span>
                    <span>{run.model_routes.map((route) => route.model).join(", ")}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {activeDesk === "resolution" ? (
          <div className="enterpriseGrid">
            <div className="panel wide">
              <div className="panelHeader">
                <div>
                  <p className="eyebrow">Entity Resolution</p>
                  <h2>Provider conflicts queue</h2>
                </div>
                <GitCompareArrows size={20} />
              </div>
              <div className="conflictRows">
                {entityConflicts.map((conflict) => (
                  <div className="conflictRow" key={conflict.id}>
                    <div>
                      <strong>{conflict.entity_type}: {conflict.candidate_id}</strong>
                      <span>{conflict.reason}</span>
                    </div>
                    <span>{conflict.provider}</span>
                    <span>{conflict.confidence}</span>
                    <span>{pct(conflict.similarity)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {activeDesk === "risk" ? (
          <div className="enterpriseGrid">
            <div className="panel">
              <div className="panelHeader">
                <div>
                  <p className="eyebrow">Risk/Bankroll</p>
                  <h2>Hard-block state</h2>
                </div>
                <ShieldCheck size={20} />
              </div>
              <div className="executionGrid">
                <span>Hard block</span>
                <strong>{executionStatus?.real_execution_hard_block ? "on" : "off"}</strong>
                <span>Can submit real</span>
                <strong>{executionStatus?.can_submit_real_orders ? "yes" : "no"}</strong>
                <span>Daily cap</span>
                <strong>{bankroll ? pct(bankroll.daily_loss_limit_fraction) : "-"}</strong>
                <span>Weekly cap</span>
                <strong>{bankroll ? pct(bankroll.weekly_drawdown_limit_fraction) : "-"}</strong>
              </div>
            </div>
            <div className="panel">
              <div className="panelHeader">
                <div>
                  <p className="eyebrow">Signal reasons</p>
                  <h2>Allow, block, abstain</h2>
                </div>
                <ShieldCheck size={20} />
              </div>
              <div className="entryList">
                {signals.slice(0, 5).map((signal) => (
                  <div className="entry" key={signal.id}>
                    <div>
                      <strong>{signal.player_name}</strong>
                      <span>{signal.reason}</span>
                    </div>
                    <span className={statusClass(signal.status)}>{signal.status}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
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
                    <span className={analysis.freshness?.source === "provider_live" ? "freshPill" : "stalePill"}>
                      {analysis.freshness?.source ?? "sample"} · odds {ageLabel(analysis.freshness?.odds_age_ms)}
                    </span>
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
                <p className="eyebrow">Live readiness</p>
                <h2>{readiness?.status ?? "unknown"}</h2>
              </div>
              <ShieldCheck size={20} />
            </div>
            <div className="executionGrid">
              <span>Analyze live</span>
              <strong>{readiness?.can_analyze_live ? "yes" : "no"}</strong>
              <span>Paper entries</span>
              <strong>{readiness?.can_generate_entries ? "ready" : "blocked"}</strong>
              <span>Real orders</span>
              <strong>{readiness?.can_submit_real_orders ? "enabled" : "hard-blocked"}</strong>
              <span>Status</span>
              <strong className={preflightStatusClass(readiness?.status ?? "blocked")}>
                {readiness?.status ?? "blocked"}
              </strong>
              <span>Provider mode</span>
              <strong className={providerModeClass(providerMode)}>
                {providerModeLabel(providerMode)}
              </strong>
            </div>
            <div className="executionWarnings">
              {readinessPanelMessages.slice(0, 4).map((reason) => (
                <span key={reason}>{reason}</span>
              ))}
            </div>
          </section>

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
                <span>State source</span>
                <strong>{selected.freshness?.source ?? "sample"}</strong>
                <span>Score age</span>
                <strong>{ageLabel(selected.freshness?.score_age_ms)}</strong>
                <span>Odds age</span>
                <strong>{ageLabel(selected.freshness?.odds_age_ms)}</strong>
                <span>Lineage</span>
                <strong>{selected.freshness?.provider_lineage.join(", ") || "-"}</strong>
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
            <select
              aria-label="Odds replay scenario"
              onChange={(event) => setReplayOddsScenario(event.target.value as ReplayOddsScenario)}
              value={replayOddsScenario}
            >
              <option value="healthy">healthy odds</option>
              <option value="gap">odds gap</option>
              <option value="resync_required">resync required</option>
            </select>
            <button onClick={triggerReplay} disabled={busy || !selectedMatchId}>
              Run replay
            </button>
            <button onClick={triggerReplayContracts} disabled={busy}>
              Run contracts
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
                <span>
                  persisted {replay.raw_payloads_saved} raw · {replay.score_ticks_saved} score ·{" "}
                  {replay.odds_ticks_saved} odds · {replay.cursors_saved} cursors
                </span>
                <span
                  className={
                    replay.resync_required ? "status statusBlocked" : "status statusEntry"
                  }
                >
                  {replay.final_status}
                </span>
                {replay.provider_cursors[0] ? (
                  <span>
                    {replay.provider_cursors[0].provider}/{replay.provider_cursors[0].stream}:{" "}
                    {replay.provider_cursors[0].status} seq{" "}
                    {replay.provider_cursors[0].last_seq ?? "none"} next{" "}
                    {replay.provider_cursors[0].expected_next_seq ?? "none"} gaps{" "}
                    {replay.provider_cursors[0].gap_count}
                  </span>
                ) : null}
                {replay.notes.map((note) => (
                  <span key={note}>{note}</span>
                ))}
              </div>
            ) : null}
            {replayContract ? (
              <div className="labCard">
                <strong>
                  {replayContract.passed ? "replay contracts passed" : "replay contracts blocked"}
                </strong>
                <span>
                  {replayContract.scenarios.length} scenarios · match {replayContract.match_id}
                </span>
                <span>
                  {replayContract.scenarios
                    .map((scenario) => `${scenario.scenario}:${scenario.passed ? "pass" : "block"}`)
                    .join(" · ")}
                </span>
                <span className={replayContract.passed ? "status statusEntry" : "status statusBlocked"}>
                  {replayContract.passed ? "ready for API onboarding" : "keep API onboarding blocked"}
                </span>
                {replayContract.notes.map((note) => (
                  <span key={note}>{note}</span>
                ))}
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
