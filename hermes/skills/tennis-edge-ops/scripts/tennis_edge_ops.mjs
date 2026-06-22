#!/usr/bin/env node

import { spawn } from "node:child_process";

const command = process.argv[2] ?? "briefing";
const apiBaseArg = process.argv.find((arg) => arg.startsWith("--api-base="));
const API_BASE = apiBaseArg ? apiBaseArg.slice("--api-base=".length) : "http://127.0.0.1:8000";
const TOKEN_STDIN_FLAG = "--token-stdin";

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${options.method ?? "GET"} ${path} failed: ${response.status} ${body}`);
  }
  return response.json();
}

async function adminHeaders() {
  if (!process.argv.includes(TOKEN_STDIN_FLAG)) {
    throw new Error("Pass the admin token through stdin with --token-stdin for this command.");
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const token = Buffer.concat(chunks).toString("utf8").trim();
  if (!token) {
    throw new Error("Admin token stdin was empty.");
  }
  return { "x-admin-token": token };
}

function printJson(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

async function briefing() {
  const data = await request("/api/v1/agent/briefing");
  printJson({
    summary: data.summary,
    autopilot_enabled: data.autopilot_enabled,
    channel: data.channel,
    triage_model: data.triage_model,
    critical_model: data.critical_model,
    entry_signals: data.entry_signals,
    provider_alerts: data.provider_alerts,
    readiness_status: data.readiness_status,
    next_actions: data.next_actions
  });
}

async function anomalies() {
  const data = await request("/api/v1/agent/anomalies");
  printJson(data);
}

async function runs() {
  const data = await request("/api/v1/agent/runs");
  printJson(data);
}

async function preflight() {
  const data = await request("/api/v1/agent/preflight");
  printJson({
    status: data.status,
    checks: data.checks,
    generated_at: data.generated_at
  });
}

async function intelligence() {
  const [
    briefing,
    preflightData,
    anomaliesData,
    providerHealth,
    providerCursors,
    dataQuality,
    costProfile,
    costReport,
    paperPerformance,
    executionStatus,
    bankroll,
    liveSignals,
    ingestionRuns,
    dashboardState,
  ] = await Promise.all([
    request("/api/v1/agent/briefing"),
    request("/api/v1/agent/preflight"),
    request("/api/v1/agent/anomalies"),
    request("/api/v1/provider-health"),
    request("/api/v1/provider-cursors"),
    request("/api/v1/data-quality"),
    request("/api/v1/cost-profile"),
    request("/api/v1/cost-report/daily"),
    request("/api/v1/paper/performance"),
    request("/api/v1/execution/status"),
    request("/api/v1/bankroll"),
    request("/api/v1/signals/live"),
    request("/api/v1/ingestion/runs"),
    request("/api/v1/dashboard/live-state"),
  ]);
  printJson(buildIntelligenceReport({
    briefing,
    preflightData,
    anomaliesData,
    providerHealth,
    providerCursors,
    dataQuality,
    costProfile,
    costReport,
    paperPerformance,
    executionStatus,
    bankroll,
    liveSignals,
    ingestionRuns,
    dashboardState,
  }));
}

async function ingestionRuns() {
  const data = await request("/api/v1/ingestion/runs");
  printJson(data);
}

async function autopilot() {
  const preflightData = await request("/api/v1/agent/preflight");
  if (preflightData.status === "blocked") {
    throw new Error(
      `Hermes preflight blocked autopilot: ${summarizeFailedChecks(preflightData.checks)}`
    );
  }
  const data = await request("/api/v1/agent/autopilot/evaluate", {
    method: "POST",
    headers: await adminHeaders(),
    body: JSON.stringify({
      source: "hermes",
      create_paper_orders: true,
      request_real_execution: false,
      max_paper_orders: 3,
      notes: "hermes local skill paper autopilot"
    })
  });
  printJson({
    run_id: data.run.id,
    summary: data.run.summary,
    paper_orders_created: data.paper_orders_created,
    paper_orders_skipped: data.paper_orders_skipped,
    real_execution_blocked: data.real_execution_blocked,
    actions: data.run.actions
  });
}

async function opsDaily() {
  const body = dailyOpsBody();
  const data = await request("/api/v1/ops/daily", {
    method: "POST",
    headers: await adminHeaders(),
    body: JSON.stringify(body)
  });
  printJson({
    status: data.status,
    source: data.source,
    live_api_calls: data.live_api_calls,
    match_id: data.match_id,
    replay_passed: data.replay_contracts.passed,
    replay_scenarios: data.replay_contracts.scenarios.map((scenario) => ({
      scenario: scenario.scenario,
      passed: scenario.passed,
      final_status: scenario.final_status,
      resync_required: scenario.resync_required
    })),
    paper_auto_settlement: {
      evaluated_orders: data.paper_auto_settlement.evaluated_orders,
      settled_orders: data.paper_auto_settlement.settled_orders,
      training_examples_ready: data.paper_auto_settlement.training_examples_ready
    },
    model_lab_backtest: data.model_lab_backtest,
    execution: data.execution
  });
}

async function ingestLiveBudget() {
  const passthroughArgs = process.argv
    .slice(3)
    .filter((arg) => arg !== TOKEN_STDIN_FLAG && arg !== apiBaseArg);
  const data = await runNpmJson("api:ingest:live-budget", passthroughArgs);
  printJson(data);
}

function runNpmJson(scriptName, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["--silent", "run", scriptName, "--", ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (exitCode !== 0) {
        reject(new Error(stderr || stdout || `${scriptName} failed with exit ${exitCode}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`${scriptName} returned non-JSON output: ${stdout || stderr}`));
      }
    });
  });
}

function dailyOpsBody() {
  const body = {};
  const matchId = optionValue("--match-id");
  const settleMatchId = optionValue("--settle-match-id");
  const maxOrders = optionValue("--max-orders");
  const scenarios = optionValues("--scenario");
  if (matchId) body.match_id = matchId;
  if (settleMatchId) body.settle_match_id = settleMatchId;
  if (maxOrders) body.max_orders = Number(maxOrders);
  if (scenarios.length) body.scenarios = scenarios;
  return body;
}

function optionValue(name) {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function optionValues(name) {
  const prefix = `${name}=`;
  return process.argv
    .filter((arg) => arg.startsWith(prefix))
    .map((arg) => arg.slice(prefix.length));
}

function summarizeFailedChecks(checks = []) {
  const failed = checks.filter((check) => check.status === "fail");
  if (!failed.length) {
    return "status=blocked";
  }
  return failed.map((check) => `${check.name}: ${check.summary}`).join("; ");
}

function buildIntelligenceReport({
  briefing,
  preflightData,
  anomaliesData,
  providerHealth,
  providerCursors,
  dataQuality,
  costProfile,
  costReport,
  paperPerformance,
  executionStatus,
  bankroll,
  liveSignals,
  ingestionRuns,
  dashboardState,
}) {
  const failedPreflight = (preflightData.checks ?? []).filter((check) => check.status === "fail");
  const warningPreflight = (preflightData.checks ?? []).filter((check) => check.status === "warn");
  const unhealthyProviders = providerHealth.filter(
    (health) => health.status !== "healthy" && !String(health.status ?? "").includes("disabled by")
  );
  const cursorsRequiringResync = providerCursors.filter((cursor) => cursor.resync_required);
  const staleQuality = dataQuality.filter((snapshot) => {
    const sequenceHealth = Number(snapshot.sequence_health ?? 1);
    const staleTicks = Number(snapshot.stale_ticks ?? 0);
    const blockedSignals = Number(snapshot.blocked_signals ?? 0);
    return sequenceHealth < 1 || staleTicks > 0 || blockedSignals > 0;
  });
  const entrySignals = liveSignals.filter((signal) => signal.status === "Entrada");
  const blockedSignals = liveSignals.filter((signal) => signal.status === "Bloqueado");
  const recentIngestionFailures = ingestionRuns
    .filter((run) => ["failed", "degraded"].includes(run.status))
    .slice(0, 5);
  const operationalState = dashboardState.operational_state ?? {};
  const sourceSummary = operationalState.source_summary ?? {};
  const replayLab = operationalState.replay_lab ?? {};
  const modelLab = operationalState.model_lab ?? {};
  const apiOnboarding = operationalState.api_onboarding ?? {};
  const blockers = [
    ...failedPreflight.map((check) => `preflight:${check.name}`),
    ...unhealthyProviders.map((health) => `provider:${health.provider}:${health.status}`),
    ...cursorsRequiringResync.map((cursor) => `cursor:${cursor.provider}:${cursor.stream}`),
    ...staleQuality.map((snapshot) => (
      `data_quality:${snapshot.provider ?? "unknown"}:${snapshot.feed ?? snapshot.id ?? "unknown"}`
    )),
    ...(executionStatus.can_submit_real_orders ? ["execution:real_orders_enabled"] : []),
  ];
  const recommendedMode = chooseRecommendedMode({
    blockers,
    entrySignals,
    paperPerformance,
    modelLab,
    apiOnboarding,
    replayLab,
  });
  return {
    generated_at: new Date().toISOString(),
    mode: recommendedMode.mode,
    severity: recommendedMode.severity,
    summary: recommendedMode.summary,
    recommended_actions: recommendedMode.actions,
    safety: {
      real_execution_hard_block: executionStatus.real_execution_hard_block,
      can_submit_real_orders: executionStatus.can_submit_real_orders,
      execution_stage: executionStatus.stage,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
    },
    signal_snapshot: {
      entry_signals: entrySignals.length,
      blocked_signals: blockedSignals.length,
      total_signals: liveSignals.length,
      briefing_entry_signals: briefing.entry_signals,
    },
    data_snapshot: {
      provider_mode: operationalState.provider_mode,
      source_total_matches: sourceSummary.total_matches ?? 0,
      persisted_matches: sourceSummary.persisted_matches ?? 0,
      replay_contract_ready: replayLab.status ?? "unknown",
      data_quality_non_pass: staleQuality.length,
      unhealthy_providers: unhealthyProviders.length,
      cursors_requiring_resync: cursorsRequiringResync.length,
      recent_ingestion_failures: recentIngestionFailures.length,
    },
    learning_snapshot: {
      readiness_status: paperPerformance.readiness_status,
      roi: paperPerformance.roi,
      clv: paperPerformance.clv,
      settled_orders: paperPerformance.settled_orders,
      model_lab_status: modelLab.status,
      production_training_examples: modelLab.production_training_examples,
      can_run_live_backtest: modelLab.can_run_live_backtest,
    },
    cost_snapshot: {
      active_plan: costProfile.active_plan,
      estimated_monthly_spend_usd: costProfile.estimated_monthly_spend_usd,
      monthly_budget_usd: costProfile.monthly_budget_usd,
      daily_live_api_calls: costReport.live_api_calls,
      cost_per_signal_usd: costReport.cost_per_signal_usd,
    },
    bankroll_snapshot: {
      balance: bankroll.balance,
      currency: bankroll.currency,
      open_exposure: bankroll.open_exposure,
      daily_pnl: bankroll.daily_pnl,
      weekly_pnl: bankroll.weekly_pnl,
    },
    blockers,
    degraded_items: {
      preflight_failed: failedPreflight,
      preflight_warnings: warningPreflight,
      provider_health: unhealthyProviders.map(compactProviderHealth),
      provider_cursors: cursorsRequiringResync.map(compactProviderCursor),
      data_quality: staleQuality.map(compactDataQuality),
      ingestion_runs: recentIngestionFailures.map(compactIngestionRun),
    },
    allowed_collection_paths: [
      "licensed_provider_api",
      "provider_websocket",
      "internal_fastapi_endpoint",
      "persisted_postgres_replay",
      "manual_operator_note",
    ],
    forbidden_collection_paths: [
      "sportsbook_ui_automation",
      "anti_bot_bypass",
      "geolocation_bypass",
      "credential_or_session_extraction",
      "paywall_or_tos_circumvention",
    ],
  };
}

function compactProviderHealth(health) {
  return {
    provider: health.provider,
    configured: health.configured,
    healthy: health.healthy,
    status: health.status,
    latency_ms: health.latency_ms,
    quota_used: health.quota_used,
    quota_limit: health.quota_limit,
    last_message_at: health.last_message_at,
  };
}

function compactProviderCursor(cursor) {
  return {
    provider: cursor.provider,
    stream: cursor.stream,
    status: cursor.status,
    last_seq: cursor.last_seq,
    expected_next_seq: cursor.expected_next_seq,
    gap_count: cursor.gap_count,
    resync_required: cursor.resync_required,
    note: cursor.note,
  };
}

function compactDataQuality(snapshot) {
  return {
    id: snapshot.id,
    provider: snapshot.provider,
    feed: snapshot.feed,
    sequence_health: snapshot.sequence_health,
    stale_ticks: snapshot.stale_ticks,
    blocked_signals: snapshot.blocked_signals,
    latency_ms: snapshot.latency_ms,
    notes: (snapshot.notes ?? []).slice(0, 3),
  };
}

function compactIngestionRun(run) {
  return {
    id: run.id,
    run_type: run.run_type,
    source: run.source,
    status: run.status,
    started_at: run.started_at,
    completed_at: run.completed_at,
    summary: {
      run_kind: run.summary?.run_kind,
      source: run.summary?.source,
      final_status: run.summary?.final_status,
      replay_passed: run.summary?.passed,
      resync_required: run.summary?.resync_required,
      live_api_calls: run.summary?.live_api_calls,
      notes: (run.summary?.notes ?? []).slice(0, 3),
    },
  };
}

function chooseRecommendedMode({
  blockers,
  entrySignals,
  paperPerformance,
  modelLab,
  apiOnboarding,
  replayLab,
}) {
  if (blockers.length) {
    return {
      mode: "investigate",
      severity: "high",
      summary: "Operational blockers detected; keep Hermes in monitor/report mode.",
      actions: [
        "Run npm run hermes:preflight and inspect failed checks.",
        "Do not run paper autopilot until blockers clear.",
        "Use replay/contracts and provider cursor evidence before adding paid API traffic.",
      ],
    };
  }
  if (entrySignals.length) {
    return {
      mode: "paper_autopilot_candidate",
      severity: "medium",
      summary: "Backend has actionable paper candidates; Hermes may request paper-only autopilot.",
      actions: [
        "Run npm run hermes:autopilot with ADMIN_API_TOKEN via stdin.",
        "Confirm created orders remain paper-only and persisted.",
        "Review CLV/ROI after settlement before changing model or stake policy.",
      ],
    };
  }
  if (!apiOnboarding.budget_chain_completed) {
    return {
      mode: "budget_chain_buildout",
      severity: "medium",
      summary: "Budget chain is still collecting/rehearsing; prioritize provider onboarding evidence.",
      actions: [
        "Keep enterprise feeds disabled.",
        "Run npm run api:check:operational-truth -- --pretty.",
        "Onboard only the next budget provider smoke shown by API onboarding.",
      ],
    };
  }
  if (!modelLab.can_run_live_backtest || paperPerformance.readiness_status !== "ready_for_review") {
    return {
      mode: "collect_learning_data",
      severity: "low",
      summary: "No urgent blockers; collect more settled paper examples before promotion review.",
      actions: [
        "Keep Hermes on scheduled briefing, anomaly scan, and daily ops rehearsal.",
        "Avoid model promotion until persisted production training examples are sufficient.",
        "Use critical model only for weekly readiness or severe anomaly review.",
      ],
    };
  }
  if (replayLab.status !== "ready") {
    return {
      mode: "replay_lab_hardening",
      severity: "medium",
      summary: "Learning data is close, but replay lab is not ready enough for higher autonomy.",
      actions: [
        "Run replay contract scenarios and inspect persisted evidence.",
        "Keep live API traffic gated until replay lab is green.",
      ],
    };
  }
  return {
    mode: "steady_state_monitoring",
    severity: "low",
    summary: "System is in steady paper-first monitoring mode.",
    actions: [
      "Keep scheduled intelligence and daily ops reports running.",
      "Review weekly ROI/CLV/calibration before any execution change.",
    ],
  };
}

const commands = {
  briefing,
  anomalies,
  runs,
  preflight,
  intelligence,
  "ingestion-runs": ingestionRuns,
  autopilot,
  "ops-daily": opsDaily,
  "ingest-live-budget": ingestLiveBudget,
};

if (!commands[command]) {
  process.stderr.write(
    `Unknown command "${command}". Use one of: ${Object.keys(commands).join(", ")}\n`
  );
  process.exit(2);
}

commands[command]().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
