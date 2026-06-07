import type {
  AgentAnomaly,
  AgentAutopilotRequest,
  AgentAutopilotResult,
  AgentBriefing,
  AgentPreflight,
  AgentRun,
  BacktestMetrics,
  BankrollSnapshot,
  CalibrationReport,
  CanonicalEntityConflict,
  CostProfile,
  DailyMetrics,
  DailyCostReport,
  DataQualitySnapshot,
  ExecutionOrder,
  ExecutionStatus,
  MatchAnalysis,
  ModelRegistryEntry,
  ModelPromotionDecision,
  PaperPerformance,
  PaperSettlement,
  ProviderCursor,
  ProviderHealth,
  ReplayRunResult,
  Signal
} from "@/lib/types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    credentials: "include"
  });
  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function getTodayMatches(): Promise<MatchAnalysis[]> {
  return getJson<MatchAnalysis[]>("/api/v1/live/matches");
}

export function getDailyMetrics(): Promise<DailyMetrics> {
  return getJson<DailyMetrics>("/api/metrics/daily");
}

export function getProviderHealth(): Promise<ProviderHealth[]> {
  return getJson<ProviderHealth[]>("/api/v1/provider-health");
}

export function getLiveSignals(): Promise<Signal[]> {
  return getJson<Signal[]>("/api/v1/signals/live");
}

export function getCostProfile(): Promise<CostProfile> {
  return getJson<CostProfile>("/api/v1/cost-profile");
}

export function getDailyCostReport(): Promise<DailyCostReport> {
  return getJson<DailyCostReport>("/api/v1/cost-report/daily");
}

export function getDataQuality(): Promise<DataQualitySnapshot[]> {
  return getJson<DataQualitySnapshot[]>("/api/v1/data-quality");
}

export function getProviderCursors(): Promise<ProviderCursor[]> {
  return getJson<ProviderCursor[]>("/api/v1/provider-cursors");
}

export function getModelRegistry(): Promise<ModelRegistryEntry[]> {
  return getJson<ModelRegistryEntry[]>("/api/v1/models/registry");
}

export function getChampionModel(): Promise<ModelRegistryEntry> {
  return getJson<ModelRegistryEntry>("/api/v1/models/champion");
}

export function getCalibrationReport(runId: string): Promise<CalibrationReport> {
  return getJson<CalibrationReport>(`/api/v1/backtests/${encodeURIComponent(runId)}/calibration`);
}

export function getPaperPerformance(): Promise<PaperPerformance> {
  return getJson<PaperPerformance>("/api/v1/paper/performance");
}

export function getAgentBriefing(): Promise<AgentBriefing> {
  return getJson<AgentBriefing>("/api/v1/agent/briefing");
}

export function getAgentAnomalies(): Promise<AgentAnomaly[]> {
  return getJson<AgentAnomaly[]>("/api/v1/agent/anomalies");
}

export function getAgentRuns(): Promise<AgentRun[]> {
  return getJson<AgentRun[]>("/api/v1/agent/runs");
}

export function getAgentPreflight(): Promise<AgentPreflight> {
  return getJson<AgentPreflight>("/api/v1/agent/preflight");
}

export async function getAgentPreflightSafe(): Promise<AgentPreflight> {
  try {
    return await getAgentPreflight();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown preflight error";
    return {
      status: "blocked",
      generated_at: new Date().toISOString(),
      checks: [
        {
          name: "agent_preflight_api",
          status: "fail",
          summary: "Agent Ops preflight could not be loaded; autonomous actions are blocked.",
          detail
        }
      ]
    };
  }
}

export function getEntityConflicts(): Promise<CanonicalEntityConflict[]> {
  return getJson<CanonicalEntityConflict[]>("/api/v1/entity-resolution/conflicts");
}

export function getExecutionStatus(): Promise<ExecutionStatus> {
  return getJson<ExecutionStatus>("/api/v1/execution/status");
}

export function getBankroll(): Promise<BankrollSnapshot> {
  return getJson<BankrollSnapshot>("/api/v1/bankroll");
}

export function getOrders(): Promise<ExecutionOrder[]> {
  return getJson<ExecutionOrder[]>("/api/v1/orders");
}

function adminHeaders(adminToken: string) {
  return {
    "Content-Type": "application/json",
    "x-admin-token": adminToken
  };
}

export async function runReplay(matchId: string, adminToken: string): Promise<ReplayRunResult> {
  const response = await fetch(`${API_BASE}/api/v1/replay/run`, {
    method: "POST",
    headers: adminHeaders(adminToken),
    credentials: "include",
    body: JSON.stringify({ match_id: matchId, speed: 1, include_market_suspensions: true })
  });
  if (!response.ok) {
    throw new Error(`Replay request failed: ${response.status}`);
  }
  return response.json() as Promise<ReplayRunResult>;
}

export async function runBacktest(adminToken: string): Promise<BacktestMetrics> {
  const response = await fetch(`${API_BASE}/api/v1/backtests/run`, {
    method: "POST",
    headers: adminHeaders(adminToken),
    credentials: "include",
    body: JSON.stringify({
      model_version: "prematch_ensemble_v1",
      feature_set: "enterprise_v1",
      walk_forward: true
    })
  });
  if (!response.ok) {
    throw new Error(`Backtest request failed: ${response.status}`);
  }
  return response.json() as Promise<BacktestMetrics>;
}

export async function createPaperOrder(
  signalId: string,
  adminToken: string
): Promise<ExecutionOrder> {
  const response = await fetch(`${API_BASE}/api/v1/orders/paper`, {
    method: "POST",
    headers: adminHeaders(adminToken),
    credentials: "include",
    body: JSON.stringify({ signal_id: signalId })
  });
  if (!response.ok) {
    throw new Error(`Paper order failed: ${response.status}`);
  }
  return response.json() as Promise<ExecutionOrder>;
}

export async function runAgentAutopilot(
  adminToken: string,
  request: AgentAutopilotRequest = {}
): Promise<AgentAutopilotResult> {
  const response = await fetch(`${API_BASE}/api/v1/agent/autopilot/evaluate`, {
    method: "POST",
    headers: adminHeaders(adminToken),
    credentials: "include",
    body: JSON.stringify({
      source: "dashboard",
      create_paper_orders: true,
      request_real_execution: false,
      max_paper_orders: 3,
      ...request
    })
  });
  if (!response.ok) {
    throw new Error(`Agent autopilot failed: ${response.status}`);
  }
  return response.json() as Promise<AgentAutopilotResult>;
}

export async function submitOrder(signalId: string, adminToken: string): Promise<ExecutionOrder> {
  const response = await fetch(`${API_BASE}/api/v1/orders/submit`, {
    method: "POST",
    headers: adminHeaders(adminToken),
    credentials: "include",
    body: JSON.stringify({ signal_id: signalId })
  });
  if (!response.ok) {
    throw new Error(`Submit order failed: ${response.status}`);
  }
  return response.json() as Promise<ExecutionOrder>;
}

export async function setKillSwitch(
  enabled: boolean,
  adminToken: string
): Promise<ExecutionStatus> {
  const response = await fetch(`${API_BASE}/api/v1/execution/kill-switch`, {
    method: "POST",
    headers: adminHeaders(adminToken),
    credentials: "include",
    body: JSON.stringify({ enabled, reason: enabled ? "dashboard" : "dashboard reset" })
  });
  if (!response.ok) {
    throw new Error(`Kill switch update failed: ${response.status}`);
  }
  return response.json() as Promise<ExecutionStatus>;
}

export async function promoteFromLearning(adminToken: string): Promise<ModelPromotionDecision> {
  const response = await fetch(`${API_BASE}/api/v1/models/promote-from-learning`, {
    method: "POST",
    headers: adminHeaders(adminToken),
    credentials: "include",
    body: JSON.stringify({})
  });
  if (!response.ok) {
    throw new Error(`Learning promotion failed: ${response.status}`);
  }
  return response.json() as Promise<ModelPromotionDecision>;
}

export async function settlePaperOrder(
  orderId: string,
  resultWin: boolean,
  closingOdds: number,
  adminToken: string
): Promise<PaperSettlement> {
  const response = await fetch(`${API_BASE}/api/v1/paper/settle`, {
    method: "POST",
    headers: adminHeaders(adminToken),
    credentials: "include",
    body: JSON.stringify({
      order_id: orderId,
      result_win: resultWin,
      closing_odds: closingOdds
    })
  });
  if (!response.ok) {
    throw new Error(`Paper settlement failed: ${response.status}`);
  }
  return response.json() as Promise<PaperSettlement>;
}
