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
    headers: { "x-admin-token": adminToken },
    credentials: "include"
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
