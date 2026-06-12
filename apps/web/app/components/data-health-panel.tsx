import { Activity, DatabaseZap, GitCompareArrows, Timer } from "lucide-react";

import type {
  ApiOnboardingSnapshot,
  DailyOperationalRunResult,
  DataQualitySnapshot,
  IngestionRunRecord,
  LiveReadinessSnapshot,
  OperationalSourceSummary,
  ProviderCursor,
  ProviderModeStep,
  ReplayLabSnapshot
} from "@/lib/types";

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function ingestionStatusClass(status: IngestionRunRecord["status"]) {
  if (status === "completed") return "status statusEntry";
  if (status === "failed") return "status statusBlocked";
  return "status statusMonitor";
}

function cursorStatusClass(cursor: ProviderCursor) {
  if (cursor.resync_required || cursor.status === "gap_detected" || cursor.status === "resync_required") {
    return "status statusBlocked";
  }
  if (cursor.status === "resynced") return "status statusMonitor";
  return "status statusEntry";
}

function onboardingStatusClass(status: ApiOnboardingSnapshot["steps"][number]["status"]) {
  if (status === "configured") return "status statusEntry";
  if (status === "ready_next") return "status statusMonitor";
  if (status === "deferred") return "status statusMuted";
  return "status statusBlocked";
}

function replayStatusClass(status: ReplayLabSnapshot["status"] | ReplayLabSnapshot["providers"][number]["status"]) {
  if (status === "ready" || status === "covered") return "status statusEntry";
  if (status === "collecting") return "status statusMonitor";
  return "status statusBlocked";
}

function dailyOpsStatusClass(
  status: DailyOperationalRunResult["status"] | "failed" | "pending" | "skipped"
) {
  if (status === "completed") return "status statusEntry";
  if (status === "collecting") return "status statusMonitor";
  if (status === "pending" || status === "skipped") return "status statusMonitor";
  return "status statusBlocked";
}

function readinessStatusClass(status: LiveReadinessSnapshot["status"] | "pending") {
  if (status === "ready") return "status statusEntry";
  if (status === "degraded" || status === "pending") return "status statusMonitor";
  return "status statusBlocked";
}

function modeStatusClass(status: ProviderModeStep["status"]) {
  if (status === "active" || status === "ready") return "status statusEntry";
  if (status === "deferred") return "status statusMuted";
  return "status statusBlocked";
}

function entryGateClass(gate: ProviderModeStep["entry_gate"]) {
  if (gate === "allow") return "status statusEntry";
  if (gate === "monitor") return "status statusMonitor";
  return "status statusBlocked";
}

function contractStatusClass(replayLab: ReplayLabSnapshot) {
  if (replayLab.last_contract_passed) return "status statusEntry";
  if (replayLab.last_contract_run_id) return "status statusBlocked";
  return "status statusMonitor";
}

function contractStatusLabel(replayLab: ReplayLabSnapshot) {
  if (replayLab.last_contract_passed) return "contract passed";
  if (replayLab.last_contract_run_id) return "contract failed";
  return "contract pending";
}

function contractEvidenceStatusClass(
  evidence: ReplayLabSnapshot["last_contract_persistence"][number]
) {
  if (!evidence.passed) return "status statusBlocked";
  if (evidence.resync_required) return "status statusMonitor";
  return "status statusEntry";
}

function ingestionRunSummary(run: IngestionRunRecord | undefined) {
  if (!run) return "no persisted run";
  return `${run.run_type.replaceAll("_", " ")} · ${run.source} · ${run.status}`;
}

function summaryObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function summaryString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function summaryNumber(value: unknown) {
  return typeof value === "number" ? value : null;
}

function summaryArrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : null;
}

function ageText(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (value < 1000) return `${value}ms`;
  return `${Math.round(value / 1000)}s`;
}

function summaryText(run: IngestionRunRecord) {
  const summary = run.summary;
  if (run.run_type === "replay_run") {
    const scenario =
      typeof summary.odds_scenario === "string" ? `${summary.odds_scenario} odds` : "replay";
    const events =
      typeof summary.events_replayed === "number" ? `${summary.events_replayed} events` : null;
    const score =
      typeof summary.score_ticks === "number" ? `${summary.score_ticks} score` : null;
    const odds =
      typeof summary.odds_ticks === "number" ? `${summary.odds_ticks} odds` : null;
    const resync = summary.resync_required === true ? "resync required" : null;
    return [scenario, events, score, odds, resync].filter(Boolean).join(" · ");
  }
  if (run.run_type === "replay_contract_run") {
    const passed = summary.passed === true ? "contract passed" : "contract blocked";
    const scenarios = Array.isArray(summary.scenarios)
      ? `${summary.scenarios.length} scenarios`
      : null;
    return [passed, scenarios].filter(Boolean).join(" · ");
  }
  if (run.run_type === "daily_operational_run") {
    const model = summaryObject(summary.model_lab_backtest);
    const status = summaryString(summary.status) ?? run.status;
    const liveCalls =
      typeof summary.live_api_calls === "number" ? `live calls ${summary.live_api_calls}` : null;
    const match = summaryString(summary.match_id);
    const modelStatus = model ? summaryString(model.status) : null;
    return [
      status,
      liveCalls,
      match ? `match ${match}` : null,
      modelStatus ? `model ${modelStatus}` : null
    ].filter(Boolean).join(" · ");
  }
  const directReason = typeof summary.reason === "string" ? summary.reason : null;
  const error = typeof summary.error === "string" ? summary.error : null;
  const oddsIngestion = summaryObject(summary.odds_ingestion);
  const oddsReason =
    oddsIngestion && typeof oddsIngestion.reason === "string" ? oddsIngestion.reason : null;
  const targetDate = typeof summary.target_date === "string" ? summary.target_date : null;
  const matches = typeof summary.matches === "number" ? `${summary.matches} matches` : null;
  const entries =
    typeof summary.entry_signals === "number" ? `${summary.entry_signals} entradas` : null;
  const profile = typeof summary.profile === "string" ? summary.profile : null;
  const fallback = [profile, targetDate, matches, entries].filter(Boolean).join(" · ");

  return error ?? directReason ?? oddsReason ?? (fallback || "Sem resumo operacional");
}

export function DataHealthPanel({
  apiOnboarding,
  dataQuality,
  dailyOperationalRun,
  dailyOpsBusy,
  ingestionRuns,
  onRunDailyOperational,
  onRunReplayContracts,
  providerModeMatrix,
  providerModeReason,
  providerCursors,
  readiness,
  replayContractBusy,
  replayLab,
  sourceSummary
}: {
  apiOnboarding: ApiOnboardingSnapshot;
  dataQuality: DataQualitySnapshot[];
  dailyOperationalRun: DailyOperationalRunResult | null;
  dailyOpsBusy: boolean;
  ingestionRuns: IngestionRunRecord[];
  onRunDailyOperational: () => void;
  onRunReplayContracts: () => void;
  providerModeMatrix: ProviderModeStep[];
  providerModeReason: string;
  providerCursors: ProviderCursor[];
  readiness: LiveReadinessSnapshot | null;
  replayContractBusy: boolean;
  replayLab: ReplayLabSnapshot;
  sourceSummary: OperationalSourceSummary;
}) {
  const activeMode = providerModeMatrix.find((step) => step.active) ?? providerModeMatrix[0];
  const oddsCursor = providerCursors.find((cursor) => cursor.provider === "odds_api_io");
  const blockedCursors = providerCursors.filter(
    (cursor) => cursor.resync_required || cursor.status === "gap_detected" || cursor.status === "resync_required"
  );
  const staleFeeds = dataQuality.filter((snapshot) => snapshot.stale_ticks > 0);
  const sourceCountsText = Object.entries(sourceSummary.source_counts)
    .map(([source, count]) => `${source} ${count}`)
    .join(" · ");
  const matchFreshnessPreview = (sourceSummary.match_freshness ?? []).slice(0, 4);
  const sourceTruthClass =
    sourceSummary.total_matches === 0
      ? "status statusBlocked"
      : sourceSummary.volatile_matches > 0
        ? "status statusMonitor"
        : "status statusEntry";
  const readinessClass = readinessStatusClass(readiness?.status ?? "pending");
  const readinessGate = readiness?.can_generate_entries ? "entries ready" : "entries blocked";
  const readinessReason =
    readiness?.blockers[0] ?? readiness?.warnings[0] ?? "Paper-first readiness checks passing.";
  const latestRun = ingestionRuns[0];
  const latestDailyOpsRun = ingestionRuns.find((run) => run.run_type === "daily_operational_run");
  const latestDailyOpsSummary = summaryObject(latestDailyOpsRun?.summary);
  const latestDailyReplaySummary = summaryObject(latestDailyOpsSummary?.replay_contracts);
  const latestDailyRehearsalSummary = summaryObject(latestDailyOpsSummary?.paper_rehearsal);
  const latestDailyPaperSummary = summaryObject(latestDailyOpsSummary?.paper_auto_settlement);
  const latestDailyModelSummary = summaryObject(latestDailyOpsSummary?.model_lab_backtest);
  const latestDailyExecutionSummary = summaryObject(latestDailyOpsSummary?.execution);
  const persistedDailyStatus = summaryString(latestDailyOpsSummary?.status) ?? latestDailyOpsRun?.status;
  const dailyStatus =
    dailyOperationalRun?.status ??
    (persistedDailyStatus === "completed" ||
    persistedDailyStatus === "collecting" ||
    persistedDailyStatus === "degraded" ||
    persistedDailyStatus === "failed" ||
    persistedDailyStatus === "skipped"
      ? persistedDailyStatus
      : "pending");
  const dailyLiveApiCalls =
    dailyOperationalRun?.live_api_calls ?? summaryNumber(latestDailyOpsSummary?.live_api_calls) ?? 0;
  const dailyMatchId =
    dailyOperationalRun?.match_id ?? summaryString(latestDailyOpsSummary?.match_id) ?? "not run";
  const dailyReplayPassed =
    dailyOperationalRun?.replay_contracts.passed ?? (latestDailyReplaySummary?.passed === true);
  const dailySettledOrders =
    dailyOperationalRun?.paper_auto_settlement.settled_orders ??
    summaryNumber(latestDailyPaperSummary?.settled_orders) ??
    0;
  const dailyTrainingExamples =
    dailyOperationalRun?.paper_auto_settlement.training_examples_ready ??
    summaryNumber(latestDailyPaperSummary?.training_examples_ready) ??
    0;
  const dailySettlementDecisions =
    dailyOperationalRun?.paper_auto_settlement.decisions.length ??
    summaryArrayLength(latestDailyPaperSummary?.decisions) ??
    0;
  const dailyRehearsalTrainingExamples =
    dailyOperationalRun?.paper_rehearsal?.training_examples_ready ??
    summaryNumber(latestDailyRehearsalSummary?.training_examples_ready) ??
    0;
  const dailyRehearsalSettlementDecisions =
    dailyOperationalRun?.paper_rehearsal?.settlement_decisions.length ??
    summaryArrayLength(latestDailyRehearsalSummary?.settlement_decisions) ??
    0;
  const dailyModelStatus =
    dailyOperationalRun?.model_lab_backtest.status ??
    summaryString(latestDailyModelSummary?.status) ??
    "pending";
  const dailyModelVersion =
    dailyOperationalRun?.model_lab_backtest.model_version ??
    summaryString(latestDailyModelSummary?.model_version) ??
    "not set";
  const dailyExecutionCanSubmit =
    dailyOperationalRun?.execution.can_submit_real_orders ??
    (latestDailyExecutionSummary?.can_submit_real_orders === true);
  const dailyOpsNote =
    dailyOperationalRun?.model_lab_backtest.reason ??
    dailyOperationalRun?.model_lab_backtest.run_id ??
    summaryString(latestDailyModelSummary?.reason) ??
    summaryString(latestDailyModelSummary?.run_id) ??
    (latestDailyOpsRun
      ? `persisted ${latestDailyOpsRun.source} run ${latestDailyOpsRun.id}`
      : "Awaiting daily ops run.");

  return (
    <div className="enterpriseGrid">
      <div className="panel wide">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Operational Truth</p>
            <h2>Modo, cursor e replay contract</h2>
          </div>
          <DatabaseZap size={20} />
        </div>
        <div className="operationalTruthRows">
          <div className="operationalTruthRow">
            <span>Active mode</span>
            <strong className={activeMode ? modeStatusClass(activeMode.status) : "status statusBlocked"}>
              {activeMode?.mode ?? "unknown"}
            </strong>
            <p>{providerModeReason}</p>
          </div>
          <div className="operationalTruthRow">
            <span>Entry gate</span>
            <strong className={activeMode ? entryGateClass(activeMode.entry_gate) : "status statusBlocked"}>
              {activeMode?.entry_gate ?? "block"}
            </strong>
            <p>
              {activeMode?.blockers.length
                ? activeMode.blockers.join(", ")
                : activeMode?.next_action ?? "Awaiting operational state."}
            </p>
          </div>
          <div className="operationalTruthRow">
            <span>Source truth</span>
            <strong className={sourceTruthClass}>
              {sourceSummary.persisted_matches}/{sourceSummary.total_matches} persisted
            </strong>
            <p>
              {sourceCountsText || "empty"} · volatile {sourceSummary.volatile_matches} ·{" "}
              {sourceSummary.note}
            </p>
          </div>
          <div className="operationalTruthRow">
            <span>Match freshness</span>
            <strong className={matchFreshnessPreview.length ? "status statusMonitor" : "status statusBlocked"}>
              {matchFreshnessPreview.length} listed
            </strong>
            <p>
              {matchFreshnessPreview.length
                ? matchFreshnessPreview
                    .map(
                      (item) =>
                        `${item.match_id}: ${item.source} · score ${ageText(
                          item.score_age_ms
                        )} · odds ${ageText(item.odds_age_ms)}`
                    )
                    .join(" | ")
                : "No per-match freshness evidence loaded."}
            </p>
          </div>
          <div className="operationalTruthRow">
            <span>Readiness gate</span>
            <strong className={readinessClass}>{readiness?.status ?? "pending"}</strong>
            <p>
              analyze {readiness?.can_analyze_live ? "yes" : "no"} · {readinessGate} · real{" "}
              {readiness?.can_submit_real_orders ? "enabled" : "hard-blocked"} · {readinessReason}
            </p>
          </div>
          <div className="operationalTruthRow">
            <span>Replay contract</span>
            <strong className={contractStatusClass(replayLab)}>{contractStatusLabel(replayLab)}</strong>
            <p>
              {replayLab.last_contract_scenarios.length
                ? replayLab.last_contract_scenarios.join(", ")
                : "Run replay contracts before adding provider keys."}
            </p>
          </div>
          <div className="operationalTruthRow">
            <span>Odds cursor</span>
            <strong className={oddsCursor ? cursorStatusClass(oddsCursor) : "status statusBlocked"}>
              {oddsCursor?.status ?? "missing"}
            </strong>
            <p>
              seq {oddsCursor?.last_seq ?? "none"} · next {oddsCursor?.expected_next_seq ?? "none"} ·{" "}
              {oddsCursor
                ? oddsCursor.resync_required
                  ? "blocks Entrada"
                  : "cursor trusted"
                : "missing blocks Entrada"}
            </p>
          </div>
          <div className="operationalTruthRow">
            <span>Cursor/freshness blocks</span>
            <strong className={blockedCursors.length || staleFeeds.length ? "status statusBlocked" : "status statusEntry"}>
              {blockedCursors.length + staleFeeds.length} blockers
            </strong>
            <p>
              cursors {blockedCursors.length} · stale feeds {staleFeeds.length} ·{" "}
              {blockedCursors[0]?.note || staleFeeds[0]?.notes[0] || "freshness gates clean"}
            </p>
          </div>
          <div className="operationalTruthRow">
            <span>Latest persisted run</span>
            <strong className={latestRun ? ingestionStatusClass(latestRun.status) : "status statusBlocked"}>
              {latestRun?.status ?? "missing"}
            </strong>
            <p>{ingestionRunSummary(latestRun)}</p>
          </div>
        </div>
      </div>
      <div className="panel wide">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Daily Ops</p>
            <h2>Replay, settlement e Model Lab</h2>
          </div>
          <button
            className="iconButton"
            disabled={dailyOpsBusy}
            onClick={onRunDailyOperational}
            title="Run daily operational rehearsal"
            type="button"
          >
            {dailyOpsBusy ? <Timer size={18} /> : <Activity size={18} />}
          </button>
        </div>
        <div className="replaySummary">
          <span className={dailyOpsStatusClass(dailyStatus)}>
            {dailyStatus}
          </span>
          <span>live calls {dailyLiveApiCalls}</span>
          <span>match {dailyMatchId}</span>
          <span className={dailyReplayPassed ? "status statusEntry" : "status statusMonitor"}>
            replay {dailyReplayPassed ? "passed" : "pending"}
          </span>
          <span>
            paper settled {dailySettledOrders} · examples {dailyTrainingExamples} · decisions{" "}
            {dailySettlementDecisions}
          </span>
          {dailyRehearsalTrainingExamples > 0 ? (
            <span className="status statusMonitor">
              rehearsal examples {dailyRehearsalTrainingExamples} · decisions{" "}
              {dailyRehearsalSettlementDecisions}
            </span>
          ) : null}
          <span className={dailyModelStatus === "completed" ? "status statusEntry" : "status statusMonitor"}>
            model {dailyModelStatus} · {dailyModelVersion}
          </span>
          <span>
            execution {dailyExecutionCanSubmit ? "real enabled" : "paper locked"}
          </span>
          <span>{dailyOpsNote}</span>
        </div>
      </div>
      <div className="panel wide">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Provider Mode Matrix</p>
            <h2>sample · replay · live_without_keys · live_with_keys</h2>
          </div>
          <DatabaseZap size={20} />
        </div>
        <div className="providerModeRows">
          {providerModeMatrix.map((step) => (
            <div className={step.active ? "providerModeRow active" : "providerModeRow"} key={step.mode}>
              <div>
                <strong>{step.mode}</strong>
                <span>{step.summary}</span>
              </div>
              <span className={modeStatusClass(step.status)}>{step.status}</span>
              <span className={entryGateClass(step.entry_gate)}>entries {step.entry_gate}</span>
              <span>{step.evidence.slice(0, 2).join(" · ")}</span>
              <span>{step.blockers.length ? step.blockers.join(", ") : "no blockers"}</span>
              <span>{step.next_action}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="panel wide">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">API Onboarding</p>
            <h2>Core primeiro, providers por etapas</h2>
          </div>
          <GitCompareArrows size={20} />
        </div>
        <div className="apiOnboardingSummary">
          <span className={apiOnboarding.core_ready ? "status statusEntry" : "status statusBlocked"}>
            core {apiOnboarding.core_ready ? "ready" : "blocked"}
          </span>
          <span>next {apiOnboarding.current_step}</span>
          {apiOnboarding.warnings.slice(0, 2).map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
        <div className="apiOnboardingRows">
          {apiOnboarding.steps.map((step) => (
            <div className={step.current ? "apiOnboardingRow current" : "apiOnboardingRow"} key={`${step.order}-${step.provider}`}>
              <div>
                <strong>
                  {step.order}. {step.provider}
                </strong>
                <span>{step.capability.replaceAll("_", " ")}</span>
              </div>
              <span className={onboardingStatusClass(step.status)}>{step.status}</span>
              <span>{step.configured ? "key/config ready" : "missing"}</span>
              <span>{step.next_action}</span>
              {step.required_before_enable.length ? (
                <span>needs {step.required_before_enable.join(", ")}</span>
              ) : (
                <span>no prerequisites pending</span>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="panel wide">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Replay Contracts</p>
            <h2>{replayLab.source}</h2>
          </div>
          <button
            className="iconButton"
            disabled={replayContractBusy}
            onClick={onRunReplayContracts}
            title="Run replay contract scenarios"
            type="button"
          >
            {replayContractBusy ? <Timer size={18} /> : <Activity size={18} />}
          </button>
        </div>
        <div className="replaySummary">
          <span className={replayStatusClass(replayLab.status)}>{replayLab.status}</span>
          <span>{replayLab.can_validate_without_live_keys ? "no live keys required" : "live keys required"}</span>
          <span>{replayLab.scenarios.join(", ")}</span>
          <span
            className={
              replayLab.last_contract_passed
                ? "status statusEntry"
                : replayLab.last_contract_run_id
                  ? "status statusBlocked"
                  : "status statusMonitor"
            }
          >
            contract{" "}
            {replayLab.last_contract_passed
              ? "passed"
              : replayLab.last_contract_run_id
                ? "failed"
                : "pending"}
          </span>
          <span>
            contract {replayLab.last_contract_run_id ?? "none"} ·{" "}
            {replayLab.last_contract_scenarios.length
              ? replayLab.last_contract_scenarios.join(", ")
              : "no scenarios"}
          </span>
          <span>
            persisted evidence {replayLab.last_contract_persistence.length} scenarios
          </span>
          <span>
            last {replayLab.last_replay_run_id ?? "none"} · events {replayLab.last_replay_events} · score{" "}
            {replayLab.last_replay_score_ticks} · odds {replayLab.last_replay_odds_ticks}
          </span>
          <span className={replayLab.last_replay_resync_required ? "status statusBlocked" : "status statusMuted"}>
            {replayLab.last_replay_resync_required ? "last replay resync" : "last replay trusted"}
          </span>
        </div>
        {replayLab.last_contract_persistence.length ? (
          <div className="replayContractRows" aria-label="Replay contract persistence evidence">
            {replayLab.last_contract_persistence.map((evidence) => (
              <div className="replayContractRow" key={`evidence-${evidence.scenario}`}>
                <div>
                  <strong>{evidence.scenario}</strong>
                  <span>
                    {evidence.final_status} ·{" "}
                    {evidence.resync_required ? "resync persisted" : "cursor trusted"}
                  </span>
                </div>
                <span className={contractEvidenceStatusClass(evidence)}>
                  {evidence.passed ? "pass" : "block"}
                </span>
                <span>raw_payloads_saved {evidence.raw_payloads_saved}</span>
                <span>
                  score_ticks_saved {evidence.score_ticks_saved} · odds_ticks_saved{" "}
                  {evidence.odds_ticks_saved}
                </span>
                <span>
                  provider_cursors_replayed {evidence.provider_cursors_replayed} · cursors_saved{" "}
                  {evidence.cursors_saved}
                </span>
                <span>
                  provider_latency_saved {evidence.provider_latency_saved}
                </span>
                {evidence.provider_contracts.length ? (
                  <span>
                    contracts{" "}
                    {evidence.provider_contracts
                      .map(
                        (contract) =>
                          `${contract.provider}:${contract.passed ? "pass" : "block"}`
                      )
                      .join(" · ")}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <div className="replayContractRows">
          {replayLab.providers.map((provider) => (
            <div className="replayContractRow" key={`${provider.provider}-${provider.adapter_contract}`}>
              <div>
                <strong>{provider.provider}</strong>
                <span>{provider.fake_api}</span>
              </div>
              <span className={replayStatusClass(provider.status)}>{provider.status}</span>
              <span>{provider.adapter_contract}</span>
              <span>{provider.input_contracts.join(", ")}</span>
              <span>{provider.output_contracts.join(", ")}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Data Health</p>
            <h2>Sequencia, completude e latencia</h2>
          </div>
          <DatabaseZap size={20} />
        </div>
        <div className="qualityRows">
          {dataQuality.map((snapshot) => (
            <div className="qualityRow" key={snapshot.id}>
              <div>
                <strong>{snapshot.provider}</strong>
                <span>{snapshot.feed}</span>
              </div>
              <span>score {pct(snapshot.score_completeness)}</span>
              <span>odds {pct(snapshot.odds_completeness)}</span>
              <span>seq {pct(snapshot.sequence_health)}</span>
              <span>{snapshot.latency_ms ?? "-"}ms</span>
            </div>
          ))}
        </div>
      </div>
      <div className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Provider Latency</p>
            <h2>Odds websocket cursors</h2>
          </div>
          <Timer size={20} />
        </div>
        <div className="cursorRows">
          {providerCursors.map((cursor) => (
            <div className="cursorRow" key={`${cursor.provider}-${cursor.stream}`}>
              <div>
                <strong>{cursor.provider}</strong>
                <span>{cursor.stream}</span>
              </div>
              <span className={cursorStatusClass(cursor)}>
                {cursor.status}
              </span>
              <span>seq {cursor.last_seq ?? "-"}</span>
              <span>next {cursor.expected_next_seq ?? "-"}</span>
              <span>gaps {cursor.gap_count}</span>
              <span className={cursor.resync_required ? "status statusBlocked" : "status statusMuted"}>
                {cursor.resync_required ? "resync" : "trusted"}
              </span>
              {cursor.note ? <span>{cursor.note}</span> : null}
            </div>
          ))}
        </div>
      </div>
      <div className="panel wide">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Ingestion Journal</p>
            <h2>Ultimos ciclos persistidos</h2>
          </div>
          <Activity size={20} />
        </div>
        <div className="ingestionRows">
          {ingestionRuns.length ? (
            ingestionRuns.slice(0, 8).map((run) => (
              <div className="ingestionRow" key={run.id}>
                <div>
                  <strong>{run.run_type.replaceAll("_", " ")}</strong>
                  <span>{summaryText(run)}</span>
                </div>
                <span className={ingestionStatusClass(run.status)}>{run.status}</span>
                <span>{run.source}</span>
                <span>
                  {new Date(run.completed_at).toLocaleTimeString("pt-BR", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit"
                  })}
                </span>
              </div>
            ))
          ) : (
            <p className="empty">Nenhum ciclo persistido ainda.</p>
          )}
        </div>
      </div>
    </div>
  );
}
