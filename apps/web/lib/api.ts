import type {
  BacktestMetrics,
  CostProfile,
  DailyMetrics,
  DailyCostReport,
  MatchAnalysis,
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
