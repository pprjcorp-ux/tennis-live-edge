import { DatabaseZap, Timer } from "lucide-react";

import type { DataQualitySnapshot, ProviderCursor } from "@/lib/types";

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

export function DataHealthPanel({
  dataQuality,
  providerCursors
}: {
  dataQuality: DataQualitySnapshot[];
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
              <span className={cursor.resync_required ? "status statusBlocked" : "status statusEntry"}>
                {cursor.status}
              </span>
              <span>seq {cursor.last_seq ?? "-"}</span>
              <span>gaps {cursor.gap_count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
