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

async function runtimeCheck() {
  const hermesBin = process.env.HERMES_BIN || "hermes";
  const commands = [
    await runLocalCommand("hermes status", hermesBin, ["status"]),
    await runLocalCommand("hermes doctor", hermesBin, ["doctor"]),
  ];
  const hasMissingCommand = commands.some((item) => item.error_code === "command_not_found");
  const hasFailure = commands.some((item) => item.exit_code !== 0 || item.timed_out || item.error_code);
  printJson({
    generated_at: new Date().toISOString(),
    mode: "local_runtime_check",
    status: hasMissingCommand ? "missing" : hasFailure ? "degraded" : "ready",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    commands,
    next_actions: runtimeCheckActions({ hasMissingCommand, hasFailure }),
  });
}

async function intelligence() {
  printJson(await intelligenceData());
}

async function events() {
  const report = await intelligenceData();
  printJson(buildEventPlan(report));
}

async function unblockPlan() {
  const report = await intelligenceData();
  const eventPlan = buildEventPlan(report);
  const budgetPlan = buildBudgetChainPlan(report, eventPlan);
  printJson(buildUnblockPlan(report, eventPlan, budgetPlan));
}

async function playbook() {
  const report = await intelligenceData();
  const eventPlan = buildEventPlan(report);
  printJson(buildPlaybook(report, eventPlan));
}

async function liveStats() {
  const report = await intelligenceData();
  const eventPlan = buildEventPlan(report);
  const playbookPlan = buildPlaybook(report, eventPlan);
  printJson(buildLiveStats(report, eventPlan, playbookPlan));
}

async function learningReview() {
  const report = await intelligenceData();
  const eventPlan = buildEventPlan(report);
  const playbookPlan = buildPlaybook(report, eventPlan);
  printJson(buildLearningReview(report, eventPlan, playbookPlan));
}

async function budgetChain() {
  const report = await intelligenceData();
  const eventPlan = buildEventPlan(report);
  printJson(buildBudgetChainPlan(report, eventPlan));
}

async function providerSmoke() {
  const report = await intelligenceData();
  const eventPlan = buildEventPlan(report);
  const plan = buildBudgetChainPlan(report, eventPlan);
  const currentStep = plan.current_step;
  const execute = process.argv.includes("--execute-provider-call");

  if (!execute) {
    printJson(providerSmokeBlocked({
      plan,
      currentStep,
      reason: "explicit_provider_call_flag_required",
    }));
    return;
  }

  if (!currentStep) {
    printJson(providerSmokeBlocked({ plan, currentStep, reason: "no_current_budget_step" }));
    return;
  }

  if (plan.blockers.includes("real_execution_safety_violation")) {
    printJson(providerSmokeBlocked({
      plan,
      currentStep,
      reason: "real_execution_safety_violation",
    }));
    return;
  }

  if (currentStep.required_before_enable.length) {
    printJson(providerSmokeBlocked({
      plan,
      currentStep,
      reason: "required_before_enable_not_satisfied",
    }));
    return;
  }

  const smoke = executableProviderSmokeFor(currentStep);
  if (!smoke) {
    printJson(providerSmokeBlocked({
      plan,
      currentStep,
      reason: "unsupported_provider_smoke",
    }));
    return;
  }

  const result = await runNpmJson(smoke.script, smoke.args);
  printJson({
    generated_at: new Date().toISOString(),
    mode: "execute_provider_call",
    status: "executed",
    reason: null,
    current_step: currentStep,
    command: smoke.command,
    provider_api_call_allowed: true,
    executed: true,
    result,
    safety: plan.safety,
  });
}

async function intelligenceData() {
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
  return buildIntelligenceReport({
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
  });
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

function runLocalCommand(name, commandName, args = [], timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const child = spawn(commandName, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const startedAt = new Date();
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        name,
        command: [commandName, ...args].join(" "),
        started_at: startedAt.toISOString(),
        completed_at: new Date().toISOString(),
        exit_code: null,
        timed_out: false,
        error_code: error.code === "ENOENT" ? "command_not_found" : "spawn_error",
        stdout: "",
        stderr: sanitizeCommandOutput(error.message),
      });
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolve({
        name,
        command: [commandName, ...args].join(" "),
        started_at: startedAt.toISOString(),
        completed_at: new Date().toISOString(),
        exit_code: exitCode,
        signal,
        timed_out: signal === "SIGTERM" && exitCode === null,
        error_code: null,
        stdout: sanitizeCommandOutput(stdout),
        stderr: sanitizeCommandOutput(stderr),
      });
    });
  });
}

function sanitizeCommandOutput(output) {
  return String(output ?? "")
    .replace(/\bsk-[^\s]+/g, "[REDACTED_API_KEY]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\s+$/g, "")
    .slice(0, 4_000);
}

function runtimeCheckActions({ hasMissingCommand, hasFailure }) {
  if (hasMissingCommand) {
    return [
      "Install or expose the Hermes CLI before enabling runtime automation.",
      "Keep using internal FastAPI packets while Hermes gateway is unavailable.",
    ];
  }
  if (hasFailure) {
    return [
      "Inspect Hermes status and doctor output before running protected autopilot.",
      "Keep cron/Telegram routes in observe mode until the loopback gateway is reachable.",
    ];
  }
  return [
    "Hermes CLI diagnostics are clean; rerun npm run hermes:preflight.",
    "Keep real execution hard-blocked.",
  ];
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
  const activeCursorsRequiringResync = cursorsRequiringResync.filter((cursor) => (
    !isDeferredEnterpriseProvider(cursor.provider, apiOnboarding)
  ));
  const deferredEnterpriseCursors = cursorsRequiringResync.filter((cursor) => (
    isDeferredEnterpriseProvider(cursor.provider, apiOnboarding)
  ));
  const blockers = [
    ...failedPreflight.map((check) => `preflight:${check.name}`),
    ...unhealthyProviders.map((health) => `provider:${health.provider}:${health.status}`),
    ...activeCursorsRequiringResync.map((cursor) => `cursor:${cursor.provider}:${cursor.stream}`),
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
      match_freshness: compactMatchFreshness(sourceSummary.match_freshness ?? []),
      replay_contract_ready: replayLab.status ?? "unknown",
      data_quality_non_pass: staleQuality.length,
      unhealthy_providers: unhealthyProviders.length,
      cursors_requiring_resync: activeCursorsRequiringResync.length,
      deferred_enterprise_cursors: deferredEnterpriseCursors.length,
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
    budget_chain_snapshot: {
      budget_chain_completed: Boolean(apiOnboarding.budget_chain_completed),
      enterprise_eligible: Boolean(apiOnboarding.enterprise_eligible),
      current_step: apiOnboarding.current_step,
      next_action: apiOnboarding.next_action,
      core_ready: Boolean(apiOnboarding.core_ready),
      steps: compactApiOnboardingSteps(apiOnboarding.steps ?? []),
      warnings: (apiOnboarding.warnings ?? []).slice(0, 5),
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
      provider_cursors: activeCursorsRequiringResync.map(compactProviderCursor),
      deferred_enterprise_cursors: deferredEnterpriseCursors.map(compactProviderCursor),
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

function isDeferredEnterpriseProvider(provider, apiOnboarding) {
  const enterpriseEligible = Boolean(apiOnboarding?.enterprise_eligible);
  const budgetChainCompleted = Boolean(apiOnboarding?.budget_chain_completed);
  return !enterpriseEligible && !budgetChainCompleted && ["sportradar", "betradar", "txodds"].includes(String(provider));
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

function compactMatchFreshness(rows) {
  return rows.slice(0, 10).map((row) => ({
    match_id: row.match_id,
    source: row.source,
    persisted: row.persisted,
    score_age_ms: row.score_age_ms,
    odds_age_ms: row.odds_age_ms,
  }));
}

function compactApiOnboardingSteps(steps) {
  return steps.map((step) => ({
    order: step.order,
    provider: step.provider,
    capability: step.capability,
    status: step.status,
    configured: step.configured,
    current: step.current,
    last_smoke_status: step.last_smoke_status,
    last_smoke_at: step.last_smoke_at,
    smoke_completed: step.smoke_completed,
    required_before_enable: step.required_before_enable ?? [],
    next_action: step.next_action,
    notes: step.notes ?? [],
  }));
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

function buildEventPlan(report) {
  const events = [];
  const blockers = report.blockers ?? [];
  const costSnapshot = report.cost_snapshot ?? {};
  const safety = report.safety ?? {};
  const learning = report.learning_snapshot ?? {};

  if (safety.can_submit_real_orders || safety.real_execution_hard_block !== true) {
    events.push(event({
      type: "real_execution_safety_violation",
      severity: "critical",
      reason: "Real execution is not hard-blocked or the API reports real order submission as possible.",
      action: "Stop all automation and restore REAL_EXECUTION_HARD_BLOCK=true before continuing.",
      allowedCommand: "npm run hermes:preflight",
      requiresAdminToken: false,
      canCreateOrders: false,
    }));
  }

  for (const blocker of blockers) {
    events.push(eventFromBlocker(blocker));
  }

  const monthlyBudget = Number(costSnapshot.monthly_budget_usd ?? 0);
  const estimatedSpend = Number(costSnapshot.estimated_monthly_spend_usd ?? 0);
  if (monthlyBudget > 0 && estimatedSpend >= monthlyBudget * 0.9) {
    events.push(event({
      type: "budget_or_quota_risk",
      severity: estimatedSpend > monthlyBudget ? "high" : "medium",
      reason: `Estimated monthly spend is ${estimatedSpend} against budget ${monthlyBudget}.`,
      action: "Keep live polling selective and review provider quota before adding paid traffic.",
      allowedCommand: "npm --silent run hermes:intelligence",
      requiresAdminToken: false,
      canCreateOrders: false,
    }));
  }

  if (report.mode === "paper_autopilot_candidate" && !events.some((item) => blocksPaperOrders(item))) {
    events.push(event({
      type: "paper_autopilot_candidate",
      severity: "medium",
      reason: "Backend has valid Entrada signals and no safety/data blockers were reported.",
      action: "Run paper autopilot through the backend only; never request real execution.",
      allowedCommand: "npm run hermes:autopilot",
      requiresAdminToken: true,
      canCreateOrders: true,
    }));
  }

  if (report.mode === "budget_chain_buildout") {
    events.push(event({
      type: "budget_chain_next_step",
      severity: "medium",
      reason: "Budget onboarding is not complete, so enterprise remains locked.",
      action: "Run operational truth checks and complete the next budget provider smoke before enterprise work.",
      allowedCommand: "npm run api:check:operational-truth -- --pretty",
      requiresAdminToken: false,
      canCreateOrders: false,
    }));
  }

  if (!learning.can_run_live_backtest || learning.readiness_status !== "ready_for_review") {
    events.push(event({
      type: "learning_data_collection",
      severity: "low",
      reason: "Model Lab does not yet have enough production learning evidence for promotion review.",
      action: "Keep collecting settled paper outcomes and run the daily ops rehearsal.",
      allowedCommand: "npm run hermes:ops:daily",
      requiresAdminToken: true,
      canCreateOrders: false,
    }));
  }

  if (!events.length) {
    events.push(event({
      type: "steady_state_monitoring",
      severity: "low",
      reason: "No operational blockers or paper candidates were reported.",
      action: "Continue scheduled intelligence, preflight, anomaly scans, and daily ops rehearsal.",
      allowedCommand: "npm --silent run hermes:intelligence",
      requiresAdminToken: false,
      canCreateOrders: false,
    }));
  }

  const normalizedEvents = dedupeEvents(events).sort((a, b) => (
    severityRank(b.severity) - severityRank(a.severity) || a.type.localeCompare(b.type)
  ));
  const canRunPaperAutopilot = normalizedEvents.some(
    (item) => item.type === "paper_autopilot_candidate" && item.can_create_orders
  );
  return {
    generated_at: new Date().toISOString(),
    source_mode: report.mode,
    severity: highestSeverity(normalizedEvents),
    summary: summarizeEventPlan(report, normalizedEvents),
    can_run_paper_autopilot: canRunPaperAutopilot,
    events: normalizedEvents,
    recommended_commands: recommendedCommands(normalizedEvents),
    safety: {
      real_execution_hard_block: safety.real_execution_hard_block,
      can_submit_real_orders: safety.can_submit_real_orders,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
    },
    forbidden_actions: report.forbidden_collection_paths ?? [],
    allowed_collection_paths: report.allowed_collection_paths ?? [],
  };
}

function buildUnblockPlan(report, eventPlan, budgetPlan) {
  const lanes = [
    ...localRuntimeLanes(report),
    ...providerSmokeLanes(budgetPlan),
    ...providerCredentialLanes(report),
    ...dataQualityLanes(report),
    ...enterpriseDeferredLanes(report),
    ...learningLanes(report),
  ].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return {
    generated_at: new Date().toISOString(),
    mode: "unblock_plan",
    source_mode: report.mode,
    severity: eventPlan.severity,
    summary: "Hermes unblock plan: classify blockers by safe next action, quota risk, and human dependency.",
    can_run_paper_autopilot: eventPlan.can_run_paper_autopilot,
    can_submit_real_orders: false,
    provider_api_call_allowed: false,
    next_best_action: lanes[0] ?? null,
    lanes,
    deferred_enterprise_cursors: report.degraded_items?.deferred_enterprise_cursors ?? [],
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      provider_api_call_allowed: false,
      llm_per_tick_allowed: false,
      forbidden_actions: report.forbidden_collection_paths ?? [],
    },
  };
}

function localRuntimeLanes(report) {
  const failed = report.degraded_items?.preflight_failed ?? [];
  if (!failed.some((check) => check.name === "hermes_gateway")) return [];
  return [unblockLane({
    id: "local_runtime",
    priority: 10,
    status: "ready",
    command: "hermes status && hermes doctor",
    reason: "Hermes loopback gateway is not reachable; diagnose local runtime before protected automation.",
    requiresHuman: false,
    writes: false,
    liveApiCalls: false,
    quotaRisk: "none",
  })];
}

function providerSmokeLanes(budgetPlan) {
  const step = budgetPlan.current_step;
  if (!step || step.smoke_completed || step.required_before_enable.length) return [];
  return [unblockLane({
    id: "provider_smoke",
    priority: 20,
    status: "operator_confirm",
    command: "npm run hermes:provider-smoke",
    reason: `Next budget step is ${step.provider}:${step.capability}; dry-run first, then use --execute-provider-call only from a local operator shell.`,
    requiresHuman: true,
    writes: true,
    liveApiCalls: true,
    quotaRisk: "explicit_operator_call_only",
  })];
}

function providerCredentialLanes(report) {
  const providers = report.degraded_items?.provider_health ?? [];
  const missing = providers.filter((provider) => (
    provider.configured === false || String(provider.status ?? "").includes("key missing")
  ));
  if (!missing.length) return [];
  return [unblockLane({
    id: "provider_credentials",
    priority: 30,
    status: "waiting_on_human",
    command: "Update local .env with missing budget provider keys, then rerun npm run hermes:preflight.",
    reason: `Missing or inactive budget providers: ${missing.map((provider) => provider.provider).join(", ")}.`,
    requiresHuman: true,
    writes: true,
    liveApiCalls: false,
    quotaRisk: "none_until_smoke",
  })];
}

function dataQualityLanes(report) {
  const snapshots = report.degraded_items?.data_quality ?? [];
  if (!snapshots.length) return [];
  return [unblockLane({
    id: "data_quality",
    priority: 40,
    status: "ready",
    command: "npm run api:check:operational-truth -- --pretty",
    reason: "Persisted data quality reports stale or blocking provider ticks; use replay/contracts before new live API spend.",
    requiresHuman: false,
    writes: true,
    liveApiCalls: false,
    quotaRisk: "none",
  })];
}

function enterpriseDeferredLanes(report) {
  const cursors = report.degraded_items?.deferred_enterprise_cursors ?? [];
  if (!cursors.length) return [];
  return [unblockLane({
    id: "enterprise_deferred",
    priority: 80,
    status: "deferred",
    command: "No action in budget mode.",
    reason: "Enterprise cursors are intentionally deferred until the budget chain and paper proof are complete.",
    requiresHuman: false,
    writes: false,
    liveApiCalls: false,
    quotaRisk: "deferred_enterprise_contract",
  })];
}

function learningLanes(report) {
  const learning = report.learning_snapshot ?? {};
  if (learning.can_run_live_backtest && learning.readiness_status === "ready_for_review") return [];
  return [unblockLane({
    id: "learning_collection",
    priority: 70,
    status: "collecting",
    command: "npm run hermes:ops:daily",
    reason: "Model Lab still needs production training examples; keep daily paper/replay rehearsal running.",
    requiresHuman: true,
    writes: true,
    liveApiCalls: false,
    quotaRisk: "none",
  })];
}

function unblockLane({
  id,
  priority,
  status,
  command,
  reason,
  requiresHuman,
  writes,
  liveApiCalls,
  quotaRisk,
}) {
  return {
    id,
    priority,
    status,
    command,
    reason,
    requires_human: requiresHuman,
    writes,
    live_api_calls: liveApiCalls,
    quota_risk: quotaRisk,
    can_submit_real_orders: false,
    provider_api_call_allowed: false,
  };
}

function eventFromBlocker(blocker) {
  if (blocker.startsWith("preflight:")) {
    return event({
      type: "preflight_blocked",
      severity: "high",
      reason: blocker,
      action: "Run Hermes preflight and fix failed checks before any autopilot action.",
      allowedCommand: "npm run hermes:preflight",
      requiresAdminToken: false,
      canCreateOrders: false,
    });
  }
  if (blocker.startsWith("cursor:")) {
    return event({
      type: "cursor_resync_required",
      severity: "high",
      reason: blocker,
      action: "Run replay/contracts and apply provider resync only after a trusted snapshot is reconciled.",
      allowedCommand: "npm run api:check:operational-truth -- --pretty",
      requiresAdminToken: false,
      canCreateOrders: false,
    });
  }
  if (blocker.startsWith("provider:")) {
    return event({
      type: "provider_health_degraded",
      severity: "high",
      reason: blocker,
      action: "Inspect provider health, quota, credentials, and last tick before spending more live calls.",
      allowedCommand: "npm run hermes:preflight",
      requiresAdminToken: false,
      canCreateOrders: false,
    });
  }
  if (blocker.startsWith("data_quality:")) {
    return event({
      type: "data_quality_degraded",
      severity: "high",
      reason: blocker,
      action: "Keep entries blocked until stale ticks, blocked signals, or sequence gaps clear.",
      allowedCommand: "npm --silent run hermes:intelligence",
      requiresAdminToken: false,
      canCreateOrders: false,
    });
  }
  if (blocker === "execution:real_orders_enabled") {
    return event({
      type: "real_execution_safety_violation",
      severity: "critical",
      reason: blocker,
      action: "Disable real execution before running any agent automation.",
      allowedCommand: "npm run hermes:preflight",
      requiresAdminToken: false,
      canCreateOrders: false,
    });
  }
  return event({
    type: "operator_investigation_required",
    severity: "medium",
    reason: blocker,
    action: "Inspect the intelligence packet and keep Hermes in monitor mode.",
    allowedCommand: "npm --silent run hermes:intelligence",
    requiresAdminToken: false,
    canCreateOrders: false,
  });
}

function event({
  type,
  severity,
  reason,
  action,
  allowedCommand,
  requiresAdminToken,
  canCreateOrders,
}) {
  return {
    type,
    severity,
    reason,
    action,
    allowed_command: allowedCommand,
    requires_admin_token: requiresAdminToken,
    can_create_orders: canCreateOrders,
    can_submit_real_orders: false,
  };
}

function blocksPaperOrders(item) {
  return ["critical", "high"].includes(item.severity) || item.type === "budget_chain_next_step";
}

function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((item) => {
    const key = `${item.type}:${item.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function severityRank(severity) {
  return { low: 1, medium: 2, high: 3, critical: 4 }[severity] ?? 0;
}

function highestSeverity(events) {
  return events.reduce(
    (highest, item) => (severityRank(item.severity) > severityRank(highest) ? item.severity : highest),
    "low"
  );
}

function recommendedCommands(events) {
  return [...new Set(events.map((item) => item.allowed_command).filter(Boolean))];
}

function summarizeEventPlan(report, events) {
  const highest = highestSeverity(events);
  const eventTypes = [...new Set(events.map((item) => item.type))].join(", ");
  return `Hermes event router: source_mode=${report.mode}, severity=${highest}, events=${eventTypes}`;
}

function buildPlaybook(report, eventPlan) {
  const eventsByType = new Map(eventPlan.events.map((item) => [item.type, item]));
  const highBlockers = eventPlan.events.filter((item) => ["critical", "high"].includes(item.severity));
  const budget = report.budget_chain_snapshot ?? {};
  const learning = report.learning_snapshot ?? {};
  const paperReady = eventPlan.can_run_paper_autopilot;
  const activePhase = chooseActivePhase({ eventPlan, budget, learning, paperReady, highBlockers });
  const steps = [
    playbookStep({
      id: "observe_state",
      phase: "observe",
      status: "ready",
      command: "npm --silent run hermes:intelligence",
      reason: "Always safe: reads internal APIs and emits the redacted operator packet.",
      requiresAdminToken: false,
      writes: false,
      liveApiCalls: false,
    }),
    playbookStep({
      id: "route_events",
      phase: "observe",
      status: "ready",
      command: "npm --silent run hermes:events",
      reason: "Always safe: converts the operator packet into deterministic event triggers.",
      requiresAdminToken: false,
      writes: false,
      liveApiCalls: false,
    }),
    playbookStep({
      id: "preflight_gate",
      phase: "stabilize_data",
      status: eventsByType.has("preflight_blocked") ? "ready" : "waiting",
      command: "npm run hermes:preflight",
      reason: eventsByType.get("preflight_blocked")?.reason ?? "Run periodically or before any protected action.",
      requiresAdminToken: false,
      writes: false,
      liveApiCalls: false,
    }),
    playbookStep({
      id: "replay_contracts",
      phase: "stabilize_data",
      status: eventsByType.has("cursor_resync_required") || eventsByType.has("data_quality_degraded") ? "ready" : "waiting",
      command: "npm run api:check:operational-truth -- --pretty",
      reason: "Use fake-provider replay/contracts before spending live quota or clearing cursor gaps.",
      requiresAdminToken: false,
      writes: true,
      liveApiCalls: false,
    }),
    playbookStep({
      id: "provider_health_review",
      phase: "stabilize_data",
      status: eventsByType.has("provider_health_degraded") ? "ready" : "waiting",
      command: "npm run hermes:preflight",
      reason: eventsByType.get("provider_health_degraded")?.reason ?? "Provider health is not currently the highest priority.",
      requiresAdminToken: false,
      writes: false,
      liveApiCalls: false,
    }),
    playbookStep({
      id: "budget_chain_next_step",
      phase: "budget_chain",
      status: budget.budget_chain_completed ? "waiting" : "ready",
      command: "npm run api:check:operational-truth -- --pretty",
      reason: budget.current_step
        ? `Enterprise stays locked; next budget step is ${budget.current_step}.`
        : "Enterprise stays locked until the budget chain is complete.",
      requiresAdminToken: false,
      writes: true,
      liveApiCalls: false,
    }),
    playbookStep({
      id: "daily_ops_rehearsal",
      phase: "collect_learning",
      status: learning.can_run_live_backtest && learning.readiness_status === "ready_for_review" ? "waiting" : "ready",
      command: "npm run hermes:ops:daily",
      reason: "Collect settled paper/rehearsal evidence and keep Model Lab dataset-first.",
      requiresAdminToken: true,
      writes: true,
      liveApiCalls: false,
    }),
    playbookStep({
      id: "paper_autopilot",
      phase: "paper_autopilot",
      status: paperReady ? "ready" : "blocked",
      command: "npm run hermes:autopilot",
      reason: paperReady
        ? "Backend has Entrada candidates and the event router found no high-severity blockers."
        : "Blocked until event router reports can_run_paper_autopilot=true.",
      requiresAdminToken: true,
      writes: true,
      liveApiCalls: false,
      canCreatePaperOrders: paperReady,
    }),
    playbookStep({
      id: "weekly_learning_review",
      phase: "learning_review",
      status: learning.can_run_live_backtest && learning.readiness_status === "ready_for_review" ? "ready" : "waiting",
      command: "npm run hermes:intelligence",
      reason: "Use the strong model route only for weekly ROI/CLV/calibration/readiness interpretation.",
      requiresAdminToken: false,
      writes: false,
      liveApiCalls: false,
    }),
  ];
  return {
    generated_at: new Date().toISOString(),
    active_phase: activePhase,
    severity: eventPlan.severity,
    summary: `Hermes playbook: active_phase=${activePhase}, source_mode=${eventPlan.source_mode}, paper_autopilot=${paperReady}`,
    enterprise_eligible: Boolean(budget.enterprise_eligible),
    budget_chain_completed: Boolean(budget.budget_chain_completed),
    current_budget_step: budget.current_step,
    can_run_paper_autopilot: paperReady,
    can_submit_real_orders: false,
    phases: compactPhases(steps),
    steps,
    hard_boundaries: [
      "no_sportsbook_ui_automation",
      "no_anti_bot_or_geolocation_bypass",
      "no_credential_or_session_extraction",
      "no_direct_betfair_or_sportsbook_calls",
      "no_llm_real_money_execution",
    ],
    event_summary: eventPlan.events.map((item) => ({
      type: item.type,
      severity: item.severity,
      can_create_orders: item.can_create_orders,
      allowed_command: item.allowed_command,
    })),
  };
}

function chooseActivePhase({ eventPlan, budget, learning, paperReady, highBlockers }) {
  if (eventPlan.events.some((item) => item.type === "real_execution_safety_violation")) {
    return "safety_stop";
  }
  if (highBlockers.length) {
    return "stabilize_data";
  }
  if (!budget.budget_chain_completed) {
    return "budget_chain";
  }
  if (paperReady) {
    return "paper_autopilot";
  }
  if (!learning.can_run_live_backtest || learning.readiness_status !== "ready_for_review") {
    return "collect_learning";
  }
  return "learning_review";
}

function playbookStep({
  id,
  phase,
  status,
  command,
  reason,
  requiresAdminToken,
  writes,
  liveApiCalls,
  canCreatePaperOrders = false,
}) {
  return {
    id,
    phase,
    status,
    command,
    reason,
    requires_admin_token: requiresAdminToken,
    writes,
    live_api_calls: liveApiCalls,
    can_create_paper_orders: canCreatePaperOrders,
    can_submit_real_orders: false,
  };
}

function compactPhases(steps) {
  return [...new Set(steps.map((step) => step.phase))].map((phase) => ({
    phase,
    ready_steps: steps.filter((step) => step.phase === phase && step.status === "ready").length,
    blocked_steps: steps.filter((step) => step.phase === phase && step.status === "blocked").length,
    waiting_steps: steps.filter((step) => step.phase === phase && step.status === "waiting").length,
  }));
}

function buildLiveStats(report, eventPlan, playbookPlan) {
  const data = report.data_snapshot ?? {};
  const signals = report.signal_snapshot ?? {};
  const learning = report.learning_snapshot ?? {};
  const cost = report.cost_snapshot ?? {};
  const budget = report.budget_chain_snapshot ?? {};
  const freshness = freshnessStats(data.match_freshness ?? []);
  const health = pipelineHealthScores({ data, signals, learning, eventPlan, freshness });
  return {
    generated_at: new Date().toISOString(),
    mode: report.mode,
    active_phase: playbookPlan.active_phase,
    provider_mode: data.provider_mode,
    collection_status: collectionStatus({ data, eventPlan, freshness }),
    processing_status: processingStatus({ data, learning, eventPlan }),
    health_scores: health,
    signal_stats: {
      total: signals.total_signals ?? 0,
      entry: signals.entry_signals ?? 0,
      blocked: signals.blocked_signals ?? 0,
      entry_rate: ratio(signals.entry_signals, signals.total_signals),
      blocked_rate: ratio(signals.blocked_signals, signals.total_signals),
      paper_autopilot_allowed: eventPlan.can_run_paper_autopilot,
    },
    freshness,
    learning_progress: {
      readiness_status: learning.readiness_status,
      settled_orders: learning.settled_orders ?? 0,
      production_training_examples: learning.production_training_examples ?? 0,
      can_run_live_backtest: Boolean(learning.can_run_live_backtest),
      roi: learning.roi,
      clv: learning.clv,
    },
    cost_efficiency: {
      active_plan: cost.active_plan,
      estimated_monthly_spend_usd: cost.estimated_monthly_spend_usd,
      monthly_budget_usd: cost.monthly_budget_usd,
      budget_utilization: ratio(cost.estimated_monthly_spend_usd, cost.monthly_budget_usd),
      daily_live_api_calls: cost.daily_live_api_calls ?? 0,
      cost_per_signal_usd: cost.cost_per_signal_usd,
    },
    budget_chain: {
      completed: Boolean(budget.budget_chain_completed),
      enterprise_eligible: Boolean(budget.enterprise_eligible),
      current_step: budget.current_step,
    },
    sampling_policy: chooseSamplingPolicy({ report, eventPlan, playbookPlan, health, budget }),
    next_safe_commands: playbookPlan.steps
      .filter((step) => step.status === "ready")
      .map((step) => ({
        id: step.id,
        command: step.command,
        phase: step.phase,
        writes: step.writes,
        live_api_calls: step.live_api_calls,
        requires_admin_token: step.requires_admin_token,
      })),
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
    },
  };
}

function buildLearningReview(report, eventPlan, playbookPlan) {
  const learning = report.learning_snapshot ?? {};
  const budget = report.budget_chain_snapshot ?? {};
  const safety = report.safety ?? {};
  const readyForReview = learning.readiness_status === "ready_for_review";
  const canRunBacktest = Boolean(learning.can_run_live_backtest);
  const budgetComplete = Boolean(budget.budget_chain_completed);
  const highBlockers = eventPlan.events.filter((item) => ["critical", "high"].includes(item.severity));
  const reviewStatus = (
    readyForReview && canRunBacktest && budgetComplete && highBlockers.length === 0
      ? "ready"
      : highBlockers.length
        ? "blocked"
        : "collecting"
  );
  return {
    generated_at: new Date().toISOString(),
    mode: "weekly_learning_review",
    review_status: reviewStatus,
    active_phase: playbookPlan.active_phase,
    model_route: {
      model: "gpt-5.5",
      task: "weekly ROI/CLV/calibration/readiness interpretation",
      reason: "Use the strong route for periodic review only; deterministic backend gates still decide promotion and execution.",
      estimated_cost_usd: 0.4,
    },
    metrics: {
      readiness_status: learning.readiness_status,
      settled_orders: learning.settled_orders ?? 0,
      production_training_examples: learning.production_training_examples ?? 0,
      roi: learning.roi ?? null,
      clv: learning.clv ?? null,
      model_lab_status: learning.model_lab_status,
    },
    gates: {
      budget_chain_completed: budgetComplete,
      enterprise_eligible: Boolean(budget.enterprise_eligible),
      can_run_live_backtest: canRunBacktest,
      ready_for_review: readyForReview,
      high_severity_blockers: highBlockers.length,
      real_execution_hard_block: safety.real_execution_hard_block === true,
    },
    blockers: [
      ...(!budgetComplete ? ["budget_chain_incomplete"] : []),
      ...(!canRunBacktest ? ["live_backtest_dataset_not_ready"] : []),
      ...(!readyForReview ? ["paper_readiness_not_ready_for_review"] : []),
      ...highBlockers.map((item) => `${item.type}:${item.reason}`),
      ...(safety.can_submit_real_orders ? ["real_execution_not_blocked"] : []),
    ],
    next_actions: learningReviewActions({ reviewStatus, budgetComplete, canRunBacktest, readyForReview, highBlockers }),
    real_execution_recommendation: "keep_blocked",
    llm_per_tick_allowed: false,
    safety: {
      real_execution_hard_block: safety.real_execution_hard_block,
      can_submit_real_orders: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
    },
  };
}

function learningReviewActions({ reviewStatus, budgetComplete, canRunBacktest, readyForReview, highBlockers }) {
  if (highBlockers.length) {
    return [
      "Resolve high-severity provider, cursor, data-quality, or preflight blockers before learning review.",
      "Run npm run hermes:events and npm run api:check:operational-truth -- --pretty.",
      "Keep real execution hard-blocked.",
    ];
  }
  if (!budgetComplete) {
    return [
      "Complete the budget provider chain before enterprise or real-execution readiness review.",
      "Run npm run hermes:budget-chain and use npm run hermes:provider-smoke only from a local operator shell.",
      "Keep collecting paper/replay evidence.",
    ];
  }
  if (!canRunBacktest || !readyForReview) {
    return [
      "Keep daily ops rehearsal and paper settlement running until production training examples are sufficient.",
      "Do not promote models from rehearsal-only or synthetic evidence.",
      "Keep real execution hard-blocked.",
    ];
  }
  if (reviewStatus === "ready") {
    return [
      "Run protected backtest/calibration review before any model promotion.",
      "Compare ROI, CLV, Brier, log loss, calibration error, and max drawdown against champion.",
      "Produce a readiness report; do not enable real execution in this phase.",
    ];
  }
  return [
    "Continue collecting settled paper evidence.",
    "Keep Hermes on monitoring and report mode.",
    "Keep real execution hard-blocked.",
  ];
}

function freshnessStats(rows) {
  const scoreAges = rows.map((row) => Number(row.score_age_ms)).filter(Number.isFinite);
  const oddsAges = rows.map((row) => Number(row.odds_age_ms)).filter(Number.isFinite);
  return {
    matches_sampled: rows.length,
    persisted_matches_sampled: rows.filter((row) => row.persisted).length,
    max_score_age_ms: maxOrNull(scoreAges),
    max_odds_age_ms: maxOrNull(oddsAges),
    avg_score_age_ms: averageOrNull(scoreAges),
    avg_odds_age_ms: averageOrNull(oddsAges),
    stale_score_matches: scoreAges.filter((age) => age > 30_000).length,
    stale_odds_matches: oddsAges.filter((age) => age > 15_000).length,
  };
}

function pipelineHealthScores({ data, signals, learning, eventPlan, freshness }) {
  const highBlockers = (eventPlan.events ?? []).filter((item) => (
    ["critical", "high"].includes(item.severity)
  )).length;
  const blockerPenalty = Math.min(60, highBlockers * 15);
  const dataPenalty = (Number(data.unhealthy_providers ?? 0) * 12)
    + (Number(data.cursors_requiring_resync ?? 0) * 25)
    + (Number(data.data_quality_non_pass ?? 0) * 10)
    + Math.min(20, Number(data.recent_ingestion_failures ?? 0) * 5);
  const freshnessPenalty = Math.min(
    30,
    (Number(freshness.stale_score_matches ?? 0) * 5) + (Number(freshness.stale_odds_matches ?? 0) * 5)
  );
  const collection = clampScore(100 - dataPenalty - freshnessPenalty);
  const processing = clampScore(100 - blockerPenalty - Math.min(30, Number(data.data_quality_non_pass ?? 0) * 10));
  const signalReadiness = clampScore(
    100
      - blockerPenalty
      - (Number(signals.blocked_signals ?? 0) > 0 ? 20 : 0)
      + (Number(signals.entry_signals ?? 0) > 0 ? 10 : 0)
  );
  const learningReadiness = clampScore(
    (learning.can_run_live_backtest ? 70 : 30)
      + Math.min(20, Number(learning.production_training_examples ?? 0) / 25)
      + (learning.readiness_status === "ready_for_review" ? 10 : 0)
  );
  return {
    collection,
    processing,
    signal_readiness: signalReadiness,
    learning_readiness: learningReadiness,
    overall: Math.round((collection * 0.35) + (processing * 0.25) + (signalReadiness * 0.25) + (learningReadiness * 0.15)),
  };
}

function chooseSamplingPolicy({ report, eventPlan, playbookPlan, health, budget }) {
  if (eventPlan.events.some((item) => item.type === "real_execution_safety_violation")) {
    return policy("safety_stop", "critical", 0, "Stop automation until real execution is hard-blocked again.");
  }
  if (health.collection < 50 || eventPlan.events.some((item) => item.type === "cursor_resync_required")) {
    return policy("cold_safe_mode", "high", 0, "Use replay/contracts and internal status only until provider cursors and freshness recover.");
  }
  if (!budget.budget_chain_completed) {
    return policy("budget_chain_polling", "medium", 5, `Complete budget step ${budget.current_step ?? "unknown"} before enterprise work.`);
  }
  if (eventPlan.can_run_paper_autopilot) {
    return policy("paper_signal_watch", "medium", 1, "Poll internal state frequently enough to create paper orders through backend gates.");
  }
  if (playbookPlan.active_phase === "collect_learning") {
    return policy("learning_collection", "low", 15, "Keep collecting settled paper evidence; avoid extra live API spend.");
  }
  if (report.mode === "steady_state_monitoring") {
    return policy("steady_state", "low", 15, "Monitor internal summaries and run daily ops; no per-tick LLM work.");
  }
  return policy("operator_review", "medium", 5, "Review Hermes events before changing collection cadence.");
}

function collectionStatus({ data, eventPlan, freshness }) {
  const blockers = eventPlan.events
    .filter((item) => ["cursor_resync_required", "provider_health_degraded", "data_quality_degraded"].includes(item.type))
    .map((item) => item.type);
  return {
    status: blockers.length ? "degraded" : "healthy",
    provider_mode: data.provider_mode,
    source_total_matches: data.source_total_matches ?? 0,
    persisted_matches: data.persisted_matches ?? 0,
    blockers: [...new Set(blockers)],
    freshness,
  };
}

function processingStatus({ data, learning, eventPlan }) {
  return {
    status: eventPlan.severity === "critical" ? "blocked" : eventPlan.severity === "high" ? "degraded" : "healthy",
    replay_contract_ready: data.replay_contract_ready,
    data_quality_non_pass: data.data_quality_non_pass ?? 0,
    recent_ingestion_failures: data.recent_ingestion_failures ?? 0,
    model_lab_status: learning.model_lab_status,
    can_run_live_backtest: Boolean(learning.can_run_live_backtest),
  };
}

function policy(name, severity, pollIntervalMinutes, reason) {
  return {
    name,
    severity,
    poll_interval_minutes: pollIntervalMinutes,
    reason,
    llm_per_tick_allowed: false,
    live_api_calls_allowed: !["safety_stop", "cold_safe_mode"].includes(name),
  };
}

function ratio(numerator, denominator) {
  const num = Number(numerator ?? 0);
  const den = Number(denominator ?? 0);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) {
    return 0;
  }
  return Number((num / den).toFixed(4));
}

function averageOrNull(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function maxOrNull(values) {
  if (!values.length) return null;
  return Math.max(...values);
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function buildBudgetChainPlan(report, eventPlan) {
  const budget = report.budget_chain_snapshot ?? {};
  const steps = budget.steps ?? [];
  const currentStep = steps.find((step) => step.current)
    ?? stepFromCurrentLabel(budget.current_step, steps)
    ?? steps.find((step) => !step.smoke_completed)
    ?? null;
  return {
    generated_at: new Date().toISOString(),
    mode: "dry_run",
    current_step_label: budget.current_step,
    budget_chain_completed: Boolean(budget.budget_chain_completed),
    enterprise_eligible: Boolean(budget.enterprise_eligible),
    core_ready: Boolean(budget.core_ready),
    current_step: currentStep ? budgetStep(currentStep, true) : null,
    steps: steps.map((step) => budgetStep(step, false)),
    blockers: budgetBlockers({ budget, eventPlan, currentStep }),
    policy: {
      execute_provider_api_calls_by_default: false,
      requires_operator_confirmation: true,
      reason: "Budget onboarding can spend provider quota, so Hermes reports commands but does not run them automatically.",
    },
    safety: {
      can_submit_real_orders: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
    },
  };
}

function stepFromCurrentLabel(label, steps) {
  if (!label || !steps.length) return null;
  const match = String(label).match(/^(\d+)\.\s*([^:]+):(.+)$/);
  if (!match) return null;
  const order = Number(match[1]);
  return steps.find((step) => Number(step.order) === order) ?? null;
}

function budgetStep(step, includeCommand) {
  const command = smokeCommandFor(step);
  return {
    order: step.order,
    provider: step.provider,
    capability: step.capability,
    status: step.status,
    configured: Boolean(step.configured),
    current: Boolean(step.current),
    smoke_completed: Boolean(step.smoke_completed),
    last_smoke_status: step.last_smoke_status,
    last_smoke_at: step.last_smoke_at,
    required_before_enable: step.required_before_enable ?? [],
    next_action: step.next_action,
    smoke_command: includeCommand ? command : command,
    provider_api_call_allowed: false,
    requires_operator_confirmation: true,
    notes: step.notes ?? [],
  };
}

function smokeCommandFor(step) {
  const key = `${step.provider}:${step.capability}`;
  return {
    "theoddsapi:archive_odds": "npm run api:ingest:archive-odds -- --pretty",
    "api_tennis:score_livescore": "npm run api:ingest:api-tennis -- --pretty",
    "odds_api_io:live_odds_websocket": "npm run api:ingest:odds-stream -- --max-messages 5 --timeout-seconds 10",
  }[key] ?? "npm run api:check:operational-truth -- --pretty";
}

function executableProviderSmokeFor(step) {
  const key = `${step.provider}:${step.capability}`;
  return {
    "theoddsapi:archive_odds": {
      script: "api:ingest:archive-odds",
      args: ["--pretty"],
      command: "npm run api:ingest:archive-odds -- --pretty",
    },
  }[key] ?? null;
}

function providerSmokeBlocked({ plan, currentStep, reason }) {
  return {
    generated_at: new Date().toISOString(),
    mode: "dry_run",
    status: "blocked",
    reason,
    current_step: currentStep,
    would_run: currentStep?.smoke_command ?? null,
    provider_api_call_allowed: false,
    executed: false,
    blockers: plan.blockers,
    safety: plan.safety,
    policy: {
      execute_provider_api_calls_by_default: false,
      explicit_flag_required: "--execute-provider-call",
      note: "Provider smoke commands can spend quota; Hermes will not run them without an explicit local operator flag.",
    },
  };
}

function budgetBlockers({ budget, eventPlan, currentStep }) {
  const blockers = [];
  if (!budget.core_ready) {
    blockers.push("core_not_ready");
  }
  if (eventPlan.events.some((item) => item.type === "real_execution_safety_violation")) {
    blockers.push("real_execution_safety_violation");
  }
  if (currentStep?.required_before_enable?.length) {
    blockers.push(...currentStep.required_before_enable);
  }
  if (!currentStep) {
    blockers.push("no_current_budget_step");
  }
  return blockers;
}

const commands = {
  briefing,
  anomalies,
  runs,
  preflight,
  "runtime-check": runtimeCheck,
  intelligence,
  events,
  "unblock-plan": unblockPlan,
  playbook,
  "live-stats": liveStats,
  "learning-review": learningReview,
  "budget-chain": budgetChain,
  "provider-smoke": providerSmoke,
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
