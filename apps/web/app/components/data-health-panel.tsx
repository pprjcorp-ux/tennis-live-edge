import { Activity, DatabaseZap, Timer } from "lucide-react";

import type { DataQualitySnapshot, IngestionRunRecord, ProviderCursor } from "@/lib/types";

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

function summaryObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function summaryText(run: IngestionRunRecord) {
  const summary = run.summary;
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
  dataQuality,
  ingestionRuns,
  providerCursors
}: {
  dataQuality: DataQualitySnapshot[];
  ingestionRuns: IngestionRunRecord[];
  providerCursors: ProviderCursor[];
}) {
  return (
    <div className="enterpriseGrid">
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
