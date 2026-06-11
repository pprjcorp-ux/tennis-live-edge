import { Activity, DatabaseZap, GitCompareArrows, Timer } from "lucide-react";

import type {
  ApiOnboardingSnapshot,
  DataQualitySnapshot,
  IngestionRunRecord,
  ProviderCursor,
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

function summaryObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  ingestionRuns,
  providerCursors,
  replayLab
}: {
  apiOnboarding: ApiOnboardingSnapshot;
  dataQuality: DataQualitySnapshot[];
  ingestionRuns: IngestionRunRecord[];
  providerCursors: ProviderCursor[];
  replayLab: ReplayLabSnapshot;
}) {
  return (
    <div className="enterpriseGrid">
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
          <Activity size={20} />
        </div>
        <div className="replaySummary">
          <span className={replayStatusClass(replayLab.status)}>{replayLab.status}</span>
          <span>{replayLab.can_validate_without_live_keys ? "no live keys required" : "live keys required"}</span>
          <span>{replayLab.scenarios.join(", ")}</span>
          <span>
            last {replayLab.last_replay_run_id ?? "none"} · events {replayLab.last_replay_events} · score{" "}
            {replayLab.last_replay_score_ticks} · odds {replayLab.last_replay_odds_ticks}
          </span>
          <span className={replayLab.last_replay_resync_required ? "status statusBlocked" : "status statusMuted"}>
            {replayLab.last_replay_resync_required ? "last replay resync" : "last replay trusted"}
          </span>
        </div>
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
