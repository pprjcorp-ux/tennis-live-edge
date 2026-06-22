#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const command = process.argv[2] ?? "briefing";
const apiBaseArg = process.argv.find((arg) => arg.startsWith("--api-base="));
const API_BASE = apiBaseArg ? apiBaseArg.slice("--api-base=".length) : "http://127.0.0.1:8000";
const TOKEN_STDIN_FLAG = "--token-stdin";
const BACKEND_READINESS_REQUESTS = [
  { label: "preflight", path: "/api/v1/agent/preflight", fallback: backendUnavailablePreflight },
  { label: "dashboard_state", path: "/api/v1/dashboard/live-state", fallback: backendUnavailableDashboardState },
  { label: "live_matches", path: "/api/v1/live/matches", fallback: [] },
  { label: "provider_health", path: "/api/v1/provider-health", fallback: backendUnavailableProviderHealth },
  { label: "cost_profile", path: "/api/v1/cost-profile", fallback: backendUnavailableCostProfile },
  { label: "execution_status", path: "/api/v1/execution/status", fallback: backendUnavailableExecutionStatus },
];

async function request(path, options = {}) {
  const { timeoutMs, ...fetchOptions } = options;
  const effectiveTimeoutMs = boundedHttpTimeoutMs(timeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  const response = await fetch(`${API_BASE}${path}`, {
    ...fetchOptions,
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      ...(fetchOptions.headers ?? {})
    }
  }).catch((error) => {
    if (error.name === "AbortError") {
      throw new Error(`${fetchOptions.method ?? "GET"} ${path} timed out after ${effectiveTimeoutMs}ms`);
    }
    throw error;
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${fetchOptions.method ?? "GET"} ${path} failed: ${response.status} ${body}`);
  }
  return response.json();
}

function boundedHttpTimeoutMs(value) {
  const parsed = Number(value ?? process.env.HERMES_HTTP_TIMEOUT_MS ?? 5_000);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 5_000;
  }
  return Math.min(Math.max(Math.trunc(parsed), 100), 30_000);
}

function boundedDoctorTriageTimeoutMs(value = process.env.HERMES_DOCTOR_TRIAGE_TIMEOUT_MS) {
  const parsed = Number(value ?? 15_000);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 15_000;
  }
  return Math.min(Math.max(Math.trunc(parsed), 100), 15_000);
}

function boundedBackendTriageTimeoutMs(value = process.env.HERMES_BACKEND_TRIAGE_TIMEOUT_MS) {
  const parsed = Number(value ?? 2_000);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 2_000;
  }
  return Math.min(Math.max(Math.trunc(parsed), 100), 10_000);
}

function runtimeDoctorTimeoutMs(value = process.env.HERMES_RUNTIME_DOCTOR_TIMEOUT_MS) {
  const parsed = Number(value ?? 15_000);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 15_000;
  }
  return Math.min(Math.max(Math.trunc(parsed), 1_000), 30_000);
}

function enterpriseReadinessTimeoutMs(value = process.env.HERMES_ENTERPRISE_READINESS_TIMEOUT_MS) {
  const parsed = Number(value ?? 15_000);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 15_000;
  }
  return Math.min(Math.max(Math.trunc(parsed), 1_000), 30_000);
}

async function safeRequest(path, fallback, label = path, options = {}) {
  try {
    return { data: await request(path, options), error: null };
  } catch (error) {
    return {
      data: fallbackFor(path, fallback, error),
      error: {
        label,
        path,
        message: String(error.message ?? error),
      },
    };
  }
}

function fallbackFor(path, fallback, error) {
  if (typeof fallback === "function") {
    return fallback({ path, error });
  }
  return fallback;
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
  printJson(await runtimeCheckData());
}

async function doctorTriage() {
  printJson(await doctorTriageData());
}

async function channelReadiness() {
  const runtime = await runtimeCheckData();
  printJson(buildChannelReadiness(runtime));
}

async function channelRecoveryPlan() {
  const runtime = await runtimeCheckData();
  const channel = buildChannelReadiness(runtime);
  printJson(buildChannelRecoveryPlan({ runtime, channel }));
}

async function backendReadiness() {
  printJson(await backendReadinessData());
}

async function backendLatencyTriage() {
  printJson(await backendLatencyTriageData());
}

async function missionControl() {
  printJson(await missionControlData());
}

async function missionLedger() {
  const mission = await missionControlData();
  const ledger = buildMissionLedger(mission);
  writeMissionLedger(ledger.record);
  printJson(ledger);
}

async function missionLedgerReport() {
  printJson(buildMissionLedgerReport(readMissionLedgerRecords()));
}

async function missionControlData() {
  const runtime = await runtimeCheckData();
  const channel = buildChannelReadiness(runtime);
  const backend = await backendReadinessData();
  const report = await intelligenceData();
  const eventPlan = buildEventPlan(report);
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  const sourceRoutes = buildSourceRouteMatrix({ report, eventPlan, sourcePlan });
  const playbookPlan = buildPlaybook(report, eventPlan);
  const liveStatsPlan = buildLiveStats(report, eventPlan, playbookPlan);
  const liveWindowPlan = buildLiveWindow(report, eventPlan, playbookPlan, liveStatsPlan);
  return buildMissionControl({
    backend,
    channel,
    report,
    eventPlan,
    sourceRoutes,
    liveWindowPlan,
  });
}

async function backendReadinessData() {
  const responses = await Promise.all(BACKEND_READINESS_REQUESTS.map((item) => (
    safeRequest(item.path, item.fallback, item.label)
  )));
  return buildBackendReadiness({
    preflightData: responses[0].data,
    dashboardState: responses[1].data,
    liveMatches: responses[2].data,
    providerHealth: responses[3].data,
    costProfile: responses[4].data,
    executionStatus: responses[5].data,
    requestErrors: responses.map((response) => response.error).filter(Boolean),
  });
}

async function backendLatencyTriageData() {
  const timeoutMs = boundedBackendTriageTimeoutMs();
  const probes = [];
  for (const item of BACKEND_READINESS_REQUESTS) {
    probes.push(await backendProbe(item, timeoutMs));
  }
  return buildBackendLatencyTriage({ probes, timeoutMs });
}

async function runtimeCheckData() {
  const hermesBin = process.env.HERMES_BIN || "hermes";
  const commands = [
    await runLocalCommand("hermes status", hermesBin, ["status"]),
    await runLocalCommand("hermes doctor", hermesBin, ["doctor"], runtimeDoctorTimeoutMs()),
  ];
  const hasMissingCommand = commands.some((item) => item.error_code === "command_not_found");
  const hasFailure = commands.some((item) => item.exit_code !== 0 || item.timed_out || item.error_code);
  const runtimeFindings = buildRuntimeFindings(commands);
  const capabilitySummary = buildRuntimeCapabilitySummary({ commands, runtimeFindings });
  return {
    generated_at: new Date().toISOString(),
    mode: "local_runtime_check",
    status: hasMissingCommand ? "missing" : hasFailure ? "degraded" : "ready",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    commands,
    runtime_findings: runtimeFindings,
    capability_summary: capabilitySummary,
    autonomy_impact: runtimeAutonomyImpact({ runtimeFindings, capabilitySummary, hasMissingCommand, hasFailure }),
    diagnostic_actions: runtimeDiagnosticActions({ hasMissingCommand, hasFailure, runtimeFindings }),
    next_actions: runtimeCheckActions({ hasMissingCommand, hasFailure, runtimeFindings }),
  };
}

async function doctorTriageData() {
  const hermesBin = process.env.HERMES_BIN || "hermes";
  const doctorTimeoutMs = boundedDoctorTriageTimeoutMs();
  const commands = [
    await runLocalCommand("hermes version", hermesBin, ["--version"], 3_000),
    await runLocalCommand("hermes status", hermesBin, ["status"], 2_000),
    await runLocalCommand("hermes doctor short", hermesBin, ["doctor"], doctorTimeoutMs),
  ];
  const runtimeFindings = buildRuntimeFindings([
    commands.find((item) => item.name === "hermes status"),
    {
      ...commands.find((item) => item.name === "hermes doctor short"),
      name: "hermes doctor",
    },
  ].filter(Boolean));
  return buildDoctorTriage({
    hermesBin,
    doctorTimeoutMs,
    commands,
    runtimeFindings,
  });
}

function buildChannelReadiness(runtime) {
  const checks = channelReadinessChecks(runtime);
  const failedChecks = checks.filter((check) => check.status !== "pass");
  return {
    generated_at: new Date().toISOString(),
    mode: "channel_readiness",
    status: failedChecks.length ? "blocked" : "ready",
    readiness_ceiling: failedChecks.length ? "observe" : "channel_ready",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    checks,
    next_action: channelReadinessActions({ checks, runtime })[0] ?? null,
    actions: channelReadinessActions({ checks, runtime }),
    acceptance_evidence: [
      "gateway_service_status=running",
      "doctor_status=passed",
      "telegram_allowlist_configured=true",
      "private_access_allowlist_configured=true",
      "local_admin_secret_available=true",
    ],
    runtime: {
      status: runtime.status,
      runtime_findings: runtime.runtime_findings,
      capability_summary: runtime.capability_summary,
      autonomy_impact: runtime.autonomy_impact,
      diagnostic_actions: runtime.diagnostic_actions,
    },
    operator_notes: failedChecks.length
      ? [
        "Resolve failed checks from a local operator shell before cron or Telegram activation.",
        "This command does not start Hermes gateway, create jobs, edit .env, or call providers.",
      ]
      : [
        "Channel prerequisites are ready; use npm run hermes:activation-checklist before manual cron activation.",
        "Keep provider smoke and paper autopilot outside scheduled channel jobs.",
      ],
    forbidden_actions: [
      "sportsbook_ui_automation",
      "anti_bot_bypass",
      "geolocation_bypass",
      "credential_or_session_extraction",
      "paywall_or_tos_circumvention",
    ],
    safety: {
      real_execution_hard_block: true,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function channelReadinessChecks(runtime) {
  const findings = runtime.runtime_findings ?? {};
  return [
    channelReadinessCheck({
      id: "hermes_cli_available",
      status: runtime.status === "missing" ? "fail" : "pass",
      summary: runtime.status === "missing"
        ? "Hermes CLI is not available in PATH."
        : "Hermes CLI responded to bounded diagnostics.",
      evidence: {
        runtime_status: runtime.status,
      },
    }),
    channelReadinessCheck({
      id: "gateway_service_running",
      status: findings.gateway_service_status === "running" ? "pass" : "fail",
      summary: findings.gateway_service_status === "running"
        ? "Hermes gateway service is running."
        : `Hermes gateway service is ${findings.gateway_service_status ?? "unknown"}.`,
      evidence: {
        gateway_service_status: findings.gateway_service_status ?? "unknown",
      },
    }),
    channelReadinessCheck({
      id: "doctor_passed",
      status: findings.doctor_status === "passed" ? "pass" : "fail",
      summary: findings.doctor_status === "passed"
        ? "Hermes doctor passed bounded diagnostics."
        : `Hermes doctor status is ${findings.doctor_status ?? "unknown"}.`,
      evidence: {
        doctor_status: findings.doctor_status ?? "unknown",
      },
    }),
    channelReadinessCheck({
      id: "telegram_allowlist_configured",
      status: envListCount(["HERMES_TELEGRAM_ALLOWED_USER_IDS", "OPENCLAW_TELEGRAM_ALLOWED_USER_IDS"]) > 0 ? "pass" : "fail",
      summary: "Telegram routing has an explicit local allowlist.",
      evidence: {
        configured_count: envListCount(["HERMES_TELEGRAM_ALLOWED_USER_IDS", "OPENCLAW_TELEGRAM_ALLOWED_USER_IDS"]),
      },
    }),
    channelReadinessCheck({
      id: "private_access_allowlist_configured",
      status: envListCount(["PRIVATE_ALLOWED_EMAILS", "TENNIS_EDGE_PRIVATE_ALLOWED_EMAILS"]) > 0 ? "pass" : "fail",
      summary: "Private Access has an explicit local email allowlist.",
      evidence: {
        configured_count: envListCount(["PRIVATE_ALLOWED_EMAILS", "TENNIS_EDGE_PRIVATE_ALLOWED_EMAILS"]),
      },
    }),
    channelReadinessCheck({
      id: "local_admin_secret_available",
      status: envConfigured(["ADMIN_API_TOKEN", "TENNIS_EDGE_ADMIN_API_TOKEN"]) ? "pass" : "fail",
      summary: "Local admin token is available for protected backend-only actions; value is not printed.",
    }),
  ];
}

function channelReadinessCheck({ id, status, summary, evidence = {} }) {
  return { id, status, summary, evidence };
}

function channelReadinessActions({ checks, runtime }) {
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  const actions = [];
  if (byId.hermes_cli_available?.status !== "pass") {
    actions.push(channelReadinessAction({
      id: "expose_hermes_cli",
      priority: 5,
      lane: "local_runtime",
      command: "command -v hermes",
      reason: "Hermes CLI must be available before channel automation can be trusted.",
    }));
  }
  if (byId.gateway_service_running?.status !== "pass") {
    const diagnostic = (runtime.diagnostic_actions ?? [])
      .find((action) => action.id === "start_gateway_manual_review");
    actions.push(channelReadinessAction({
      id: "start_gateway_manual_review",
      priority: 10,
      lane: "local_runtime",
      command: diagnostic?.command ?? "hermes gateway start",
      reason: diagnostic?.reason ?? "Hermes gateway must be running before Telegram/cron channel activation.",
      mutatesRuntimeIfRun: true,
      requiresOperatorConfirmation: true,
    }));
  }
  if (byId.doctor_passed?.status !== "pass") {
    actions.push(channelReadinessAction({
      id: "rerun_bounded_runtime_check",
      priority: 20,
      lane: "local_runtime",
      command: runtimeReviewCommand(runtime.runtime_findings),
      reason: runtimeReviewReason(runtime.runtime_findings),
    }));
  }
  if (byId.telegram_allowlist_configured?.status !== "pass") {
    actions.push(channelReadinessAction({
      id: "configure_telegram_allowlist",
      priority: 30,
      lane: "operator_reachability",
      command: "Configure HERMES_TELEGRAM_ALLOWED_USER_IDS locally, then rerun npm run hermes:channel-readiness.",
      reason: "Telegram channel commands must be allowlisted before use.",
      requiresOperatorConfirmation: true,
    }));
  }
  if (byId.private_access_allowlist_configured?.status !== "pass") {
    actions.push(channelReadinessAction({
      id: "configure_private_access_allowlist",
      priority: 40,
      lane: "private_access",
      command: "Configure PRIVATE_ALLOWED_EMAILS locally, then rerun npm run hermes:channel-readiness.",
      reason: "Private dashboard/API access must stay behind an explicit allowlist.",
      requiresOperatorConfirmation: true,
    }));
  }
  if (byId.local_admin_secret_available?.status !== "pass") {
    actions.push(channelReadinessAction({
      id: "configure_local_admin_token",
      priority: 50,
      lane: "local_secret",
      command: "Configure ADMIN_API_TOKEN locally, then rerun npm run hermes:channel-readiness.",
      reason: "Protected backend-only actions require a local admin token passed through stdin.",
      requiresOperatorConfirmation: true,
    }));
  }
  if (!actions.length) {
    actions.push(channelReadinessAction({
      id: "run_activation_checklist",
      priority: 100,
      lane: "manual_activation",
      command: "npm run hermes:activation-checklist",
      reason: "Channel prerequisites are ready; final cron activation still requires the activation checklist.",
    }));
  }
  return actions.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function channelReadinessAction({
  id,
  priority,
  lane,
  command,
  reason,
  mutatesRuntimeIfRun = false,
  requiresOperatorConfirmation = false,
}) {
  return {
    id,
    priority,
    lane,
    command,
    reason,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    mutates_runtime_if_run: Boolean(mutatesRuntimeIfRun),
    requires_operator_confirmation: Boolean(requiresOperatorConfirmation),
  };
}

function buildBackendReadiness({
  preflightData,
  dashboardState,
  liveMatches,
  providerHealth,
  costProfile,
  executionStatus,
  requestErrors = [],
}) {
  const checks = backendReadinessChecks({
    preflightData,
    dashboardState,
    liveMatches,
    providerHealth,
    costProfile,
    executionStatus,
    requestErrors,
  });
  const failedChecks = checks.filter((check) => check.status === "fail");
  const actions = backendReadinessActions({ checks, requestErrors });
  return {
    generated_at: new Date().toISOString(),
    mode: "backend_readiness",
    status: failedChecks.length ? "blocked" : "ready",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    api_base: API_BASE,
    checks,
    request_errors: requestErrors,
    next_action: actions[0] ?? null,
    actions,
    endpoint_summary: {
      preflight_status: preflightData?.status ?? "unknown",
      provider_mode: dashboardState?.operational_state?.provider_mode ?? "unknown",
      live_match_count: Array.isArray(liveMatches) ? liveMatches.length : 0,
      provider_health_count: Array.isArray(providerHealth) ? providerHealth.length : 0,
      active_plan: costProfile?.active_plan ?? "unknown",
      execution_stage: executionStatus?.stage ?? "unknown",
    },
    acceptance_evidence: [
      "preflight endpoint reachable",
      "dashboard live-state endpoint reachable",
      "live matches endpoint reachable",
      "provider health endpoint reachable",
      "cost profile endpoint reachable",
      "execution status reports can_submit_real_orders=false",
    ],
    operator_notes: failedChecks.length
      ? [
        "Restore or inspect the local FastAPI process before Hermes live-window/paper routing.",
        "This command does not start the API server, Docker, Postgres, dashboard, or provider ingestion.",
      ]
      : [
        "Backend readiness is sufficient for read-only Hermes packets.",
        "Run npm --silent run hermes:live-window before any protected paper-autopilot path.",
      ],
    safety: {
      real_execution_hard_block: executionStatus?.real_execution_hard_block === true,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function backendReadinessChecks({
  preflightData,
  dashboardState,
  liveMatches,
  providerHealth,
  costProfile,
  executionStatus,
  requestErrors,
}) {
  const errorLabels = new Set(requestErrors.map((error) => error.label));
  return [
    backendReadinessCheck({
      id: "internal_api_reachable",
      status: requestErrors.length ? "fail" : "pass",
      summary: requestErrors.length
        ? "One or more internal FastAPI endpoints did not answer within the bounded timeout."
        : "All sampled internal FastAPI endpoints answered.",
      evidence: {
        failed_labels: [...errorLabels],
      },
    }),
    backendReadinessCheck({
      id: "preflight_endpoint_reachable",
      status: errorLabels.has("preflight") ? "fail" : "pass",
      summary: `Preflight status is ${preflightData?.status ?? "unknown"}.`,
      evidence: {
        status: preflightData?.status ?? "unknown",
        failed_checks: (preflightData?.checks ?? [])
          .filter((check) => check.status === "fail")
          .map((check) => check.name ?? check.id),
      },
    }),
    backendReadinessCheck({
      id: "dashboard_state_available",
      status: errorLabels.has("dashboard_state") ? "fail" : "pass",
      summary: `Dashboard provider mode is ${dashboardState?.operational_state?.provider_mode ?? "unknown"}.`,
      evidence: {
        provider_mode: dashboardState?.operational_state?.provider_mode ?? "unknown",
      },
    }),
    backendReadinessCheck({
      id: "live_matches_endpoint_reachable",
      status: errorLabels.has("live_matches") ? "fail" : "pass",
      summary: `${Array.isArray(liveMatches) ? liveMatches.length : 0} live match rows are visible to Hermes.`,
      evidence: {
        count: Array.isArray(liveMatches) ? liveMatches.length : 0,
      },
    }),
    backendReadinessCheck({
      id: "provider_health_visible",
      status: errorLabels.has("provider_health") ? "fail" : "pass",
      summary: `${Array.isArray(providerHealth) ? providerHealth.length : 0} provider health rows are visible.`,
      evidence: {
        count: Array.isArray(providerHealth) ? providerHealth.length : 0,
      },
    }),
    backendReadinessCheck({
      id: "cost_profile_visible",
      status: errorLabels.has("cost_profile") ? "fail" : "pass",
      summary: `Cost profile active plan is ${costProfile?.active_plan ?? "unknown"}.`,
      evidence: {
        active_plan: costProfile?.active_plan ?? "unknown",
      },
    }),
    backendReadinessCheck({
      id: "real_execution_hard_block",
      status: executionStatus?.can_submit_real_orders === false ? "pass" : "fail",
      summary: "Backend execution status must keep real order submission impossible.",
      evidence: {
        real_execution_hard_block: executionStatus?.real_execution_hard_block,
        can_submit_real_orders: executionStatus?.can_submit_real_orders,
        stage: executionStatus?.stage,
      },
    }),
  ];
}

function backendReadinessCheck({ id, status, summary, evidence = {} }) {
  return { id, status, summary, evidence };
}

async function backendProbe(item, timeoutMs) {
  const startedAt = new Date();
  const started = Date.now();
  try {
    const data = await request(item.path, { timeoutMs });
    return {
      label: item.label,
      path: item.path,
      status: "pass",
      duration_ms: Date.now() - started,
      timeout_ms: timeoutMs,
      timed_out: false,
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      summary: backendProbeSummary(data),
    };
  } catch (error) {
    const message = String(error.message ?? error);
    return {
      label: item.label,
      path: item.path,
      status: message.includes("timed out") ? "timeout" : "fail",
      duration_ms: Date.now() - started,
      timeout_ms: timeoutMs,
      timed_out: message.includes("timed out"),
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      error: message,
      summary: null,
    };
  }
}

function buildBackendLatencyTriage({ probes, timeoutMs }) {
  const failed = probes.filter((probe) => probe.status !== "pass");
  const passed = probes.filter((probe) => probe.status === "pass");
  const likelyCause = backendLatencyLikelyCause({ probes, failed, passed });
  return {
    generated_at: new Date().toISOString(),
    mode: "backend_latency_triage",
    status: failed.length ? passed.length ? "degraded" : "blocked" : "ready",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    api_base: API_BASE,
    timeout_ms: timeoutMs,
    likely_cause: likelyCause,
    passed_count: passed.length,
    failed_count: failed.length,
    timeout_count: probes.filter((probe) => probe.timed_out).length,
    slowest_pass_ms: passed.length ? Math.max(...passed.map((probe) => probe.duration_ms)) : null,
    probes,
    next_safe_actions: backendLatencyActions({ likelyCause, failed, passed }),
    operator_note: "This triage only probes local FastAPI endpoints with bounded GET requests; it does not start servers, mutate state, call providers, or print payload bodies.",
    safety: {
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
      payload_body_printed: false,
    },
  };
}

function backendProbeSummary(data) {
  if (Array.isArray(data)) {
    return { type: "array", count: data.length };
  }
  if (data && typeof data === "object") {
    return {
      type: "object",
      keys: Object.keys(data).slice(0, 8),
      status: data.status ?? data.readiness_status ?? null,
    };
  }
  return { type: typeof data };
}

function backendLatencyLikelyCause({ probes, failed, passed }) {
  if (!passed.length && failed.every((probe) => probe.timed_out)) {
    return "backend_unreachable_or_event_loop_blocked";
  }
  if (failed.length && passed.length) {
    return failed.some((probe) => probe.timed_out)
      ? "partial_endpoint_latency_or_contention"
      : "partial_endpoint_failure";
  }
  if (!failed.length) {
    const slow = probes.some((probe) => probe.duration_ms > Math.min(probe.timeout_ms * 0.8, 2_000));
    return slow ? "backend_responsive_but_slow" : "backend_responsive";
  }
  return "backend_unavailable";
}

function backendLatencyActions({ likelyCause, failed, passed }) {
  if (likelyCause === "backend_responsive" || likelyCause === "backend_responsive_but_slow") {
    return [
      backendReadinessAction({
        id: "rerun_backend_readiness",
        priority: 10,
        lane: "local_backend",
        command: "npm run hermes:backend-readiness",
        reason: "Backend endpoints responded to bounded probes; rerun readiness before live-window routing.",
      }),
    ];
  }
  if (passed.length && failed.length) {
    return [
      backendReadinessAction({
        id: "rerun_longer_backend_latency_probe",
        priority: 10,
        lane: "local_backend",
        command: "HERMES_BACKEND_TRIAGE_TIMEOUT_MS=10000 npm run hermes:backend-latency-triage",
        reason: "Some local endpoints responded while others timed out; run a longer bounded probe before restarting services.",
      }),
      backendReadinessAction({
        id: "verify_operational_truth_after_probe",
        priority: 20,
        lane: "local_backend",
        command: "npm run api:check:operational-truth -- --pretty",
        reason: "Confirm persisted replay, fail-closed signals, and execution hard block after endpoint latency stabilizes.",
      }),
    ];
  }
  return [
    backendReadinessAction({
      id: "start_or_inspect_fastapi_manual_review",
      priority: 10,
      lane: "local_backend",
      command: "npm run api:dev",
      reason: "No sampled backend endpoint responded; inspect or start FastAPI manually.",
      mutatesRuntimeIfRun: true,
      requiresOperatorConfirmation: true,
    }),
  ];
}

function backendReadinessActions({ checks, requestErrors }) {
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  const actions = [];
  if (requestErrors.length || byId.internal_api_reachable?.status !== "pass") {
    const partialFailure = requestErrors.length > 0 && requestErrors.length < BACKEND_READINESS_REQUESTS.length;
    actions.push(backendReadinessAction({
      id: partialFailure ? "triage_backend_latency" : "start_or_inspect_fastapi_manual_review",
      priority: 10,
      lane: "local_backend",
      command: partialFailure ? "npm run hermes:backend-latency-triage" : "npm run api:dev",
      reason: partialFailure
        ? "Some internal FastAPI endpoints answered while others timed out; measure endpoint latency before restarting services."
        : "Hermes cannot use live-window or backend-gated paper routes until the local FastAPI service is reachable.",
      mutatesRuntimeIfRun: !partialFailure,
      requiresOperatorConfirmation: !partialFailure,
    }));
    actions.push(backendReadinessAction({
      id: "check_operational_truth_after_backend_start",
      priority: 20,
      lane: "local_backend",
      command: "npm run api:check:operational-truth -- --pretty",
      reason: "After FastAPI is reachable, verify persisted replay, fail-closed signals, and real-execution hard block.",
    }));
  }
  if (byId.real_execution_hard_block?.status !== "pass") {
    actions.push(backendReadinessAction({
      id: "restore_real_execution_hard_block",
      priority: 1,
      lane: "execution_safety",
      command: "Stop automation and restore REAL_EXECUTION_HARD_BLOCK=true before continuing.",
      reason: "Hermes must not proceed while the backend reports real order submission as possible.",
      requiresOperatorConfirmation: true,
    }));
  }
  if (!actions.length) {
    actions.push(backendReadinessAction({
      id: "run_live_window",
      priority: 100,
      lane: "live_window",
      command: "npm --silent run hermes:live-window",
      reason: "Backend readiness is clean enough for read-only live-window evaluation.",
    }));
  }
  return actions.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function backendReadinessAction({
  id,
  priority,
  lane,
  command,
  reason,
  mutatesRuntimeIfRun = false,
  requiresOperatorConfirmation = false,
}) {
  return {
    id,
    priority,
    lane,
    command,
    reason,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    mutates_runtime_if_run: Boolean(mutatesRuntimeIfRun),
    requires_operator_confirmation: Boolean(requiresOperatorConfirmation),
  };
}

function buildChannelRecoveryPlan({ runtime, channel }) {
  const failedChecks = (channel.checks ?? []).filter((check) => check.status !== "pass");
  return {
    generated_at: new Date().toISOString(),
    mode: "channel_recovery_plan",
    status: failedChecks.length ? "blocked" : "ready",
    readiness_ceiling: channel.readiness_ceiling,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    runtime: {
      status: runtime.status,
      gateway_service_status: runtime.runtime_findings?.gateway_service_status ?? "unknown",
      doctor_status: runtime.runtime_findings?.doctor_status ?? "unknown",
      blockers: runtime.runtime_findings?.blockers ?? [],
    },
    failed_check_ids: failedChecks.map((check) => check.id),
    failed_checks: failedChecks.map((check) => ({
      id: check.id,
      summary: check.summary,
      evidence: check.evidence ?? {},
    })),
    local_env_requirements: channelRecoveryEnvRequirements(),
    operator_channel_bootstrap: buildOperatorChannelBootstrapPacket(channel),
    verification_commands: [
      "npm run hermes:runtime-check",
      "npm run hermes:channel-readiness",
      "npm run hermes:activation-checklist",
    ],
    next_safe_action: channel.next_action ?? null,
    next_human_steps: channelRecoveryHumanSteps(channel.actions ?? []),
    operator_note: "This plan reports local recovery gates only; it does not edit .env, start services, create cron jobs, or print secret values.",
    forbidden_actions: channel.forbidden_actions,
    safety: {
      real_execution_hard_block: channel.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function buildOperatorChannelBootstrapPacket(channel) {
  const requirements = channelRecoveryEnvRequirements();
  return {
    mode: "operator_channel_bootstrap",
    status: requirements.every((requirement) => requirement.configured) ? "ready" : "needs_local_env",
    read_only: true,
    writes: false,
    automated_env_write_allowed: false,
    manual_env_write_required: requirements.some((requirement) => !requirement.configured),
    target_file: ".env",
    secret_value_printed: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    env_template_lines: [
      "HERMES_TELEGRAM_ALLOWED_USER_IDS=<telegram-user-id>",
      "OPENCLAW_TELEGRAM_ALLOWED_USER_IDS=<telegram-user-id>",
      "PRIVATE_ALLOWED_EMAILS=<operator-email>",
      "TENNIS_EDGE_PRIVATE_ALLOWED_EMAILS=<operator-email>",
      "ADMIN_API_TOKEN=<random-32-byte-local-token>",
      "TENNIS_EDGE_ADMIN_API_TOKEN=<random-32-byte-local-token>",
    ],
    required_groups: requirements.map((requirement) => ({
      id: requirement.id,
      names: requirement.names,
      configured: requirement.configured,
      configured_count: requirement.configured_count,
      secret: requirement.secret,
      required_count: 1,
      note: requirement.secret
        ? "Generate locally with a password manager or local shell and paste only into .env."
        : "Use an explicit allowlist value; do not use wildcard access.",
      secret_value_printed: false,
    })),
    verification_commands: [
      "npm --silent run hermes:channel-readiness",
      "npm --silent run hermes:activation-checklist",
      "npm --silent run hermes:implementation-handoff",
    ],
    acceptance_evidence: [
      "doctor_passed=pass",
      "telegram_allowlist_configured=pass",
      "private_access_allowlist_configured=pass",
      "local_admin_secret_available=pass",
      "secret_value_printed=false",
      "work_order.id!=configure_hermes_operator_channel_secrets",
    ],
    next_action_after_local_env: channel.next_action?.id === "run_activation_checklist"
      ? channel.next_action
      : {
        id: "rerun_channel_readiness",
        command: "npm --silent run hermes:channel-readiness",
        reason: "Rerun the read-only channel gate after local .env values are present.",
        executes_now: false,
        writes: false,
        provider_api_call_allowed: false,
        can_submit_real_orders: false,
        can_create_paper_orders: false,
      },
  };
}

function buildDoctorTriage({ hermesBin, doctorTimeoutMs, commands, runtimeFindings }) {
  const versionCommand = commands.find((item) => item.name === "hermes version");
  const statusCommand = commands.find((item) => item.name === "hermes status");
  const doctorCommand = commands.find((item) => item.name === "hermes doctor short");
  const likelyCause = doctorTriageLikelyCause({
    versionCommand,
    statusCommand,
    doctorCommand,
    runtimeFindings,
    doctorTimeoutMs,
  });
  return {
    generated_at: new Date().toISOString(),
    mode: "doctor_triage",
    status: doctorCommand?.exit_code === 0 && !doctorCommand?.timed_out ? "ready" : "blocked",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    hermes_bin_source: process.env.HERMES_BIN ? "env" : "path",
    hermes_bin_name: hermesBin,
    doctor_timeout_ms: doctorTimeoutMs,
    runtime_findings: runtimeFindings,
    likely_cause: likelyCause,
    command_summary: commands.map((item) => ({
      name: item.name,
      exit_code: item.exit_code,
      timed_out: item.timed_out,
      error_code: item.error_code,
      stdout_preview: doctorTriagePreview(item.stdout),
      stderr_preview: doctorTriagePreview(item.stderr),
    })),
    next_safe_actions: doctorTriageActions({ likelyCause, runtimeFindings, doctorTimeoutMs }),
    verification_commands: [
      "npm run hermes:doctor-triage",
      "npm run hermes:runtime-check",
      "npm run hermes:channel-readiness",
    ],
    operator_note: "This triage is bounded and read-only; it does not edit .env, start Hermes services, create cron jobs, call providers, or print secret values.",
    safety: {
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
      secret_value_printed: false,
    },
  };
}

function doctorTriageLikelyCause({ versionCommand, statusCommand, doctorCommand, runtimeFindings, doctorTimeoutMs }) {
  if ([versionCommand, statusCommand, doctorCommand].some((item) => item?.error_code === "command_not_found")) {
    return "hermes_cli_not_found";
  }
  if (runtimeFindings.gateway_service_status === "stopped") {
    return "gateway_service_stopped";
  }
  if (runtimeFindings.gateway_service_status === "unknown" && statusCommand?.exit_code !== 0) {
    return "gateway_status_unavailable";
  }
  if (doctorCommand?.timed_out) {
    if (Number(doctorTimeoutMs) >= 5_000 && runtimeFindings.gateway_service_status === "running") {
      if (runtimeFindings.doctor_progress?.reached_api_connectivity) {
        return "persistent_doctor_api_connectivity_timeout";
      }
      return "persistent_doctor_timeout_with_gateway_running";
    }
    return runtimeFindings.gateway_service_status === "running"
      ? "doctor_timeout_with_gateway_running"
      : "doctor_timeout";
  }
  if (doctorCommand?.exit_code && doctorCommand.exit_code !== 0) {
    return "doctor_exited_nonzero";
  }
  if (doctorCommand?.exit_code === 0) {
    return "doctor_passed_short_probe";
  }
  return "unknown";
}

function doctorTriageActions({ likelyCause, runtimeFindings, doctorTimeoutMs }) {
  const base = [
    doctorTriageAction({
      id: "keep_channel_observe_only",
      priority: 90,
      command: "npm run hermes:channel-readiness",
      reason: "Channel activation stays observe-only until doctor and allowlist gates pass.",
    }),
  ];
  if (likelyCause === "hermes_cli_not_found") {
    return [
      doctorTriageAction({
        id: "expose_hermes_cli",
        priority: 10,
        command: "command -v hermes",
        reason: "Hermes is not available to the repo wrapper; expose the installed CLI before channel automation.",
      }),
      ...base,
    ];
  }
  if (likelyCause === "gateway_service_stopped") {
    return [
      doctorTriageAction({
        id: "manual_gateway_start_review",
        priority: 10,
        command: "hermes gateway start",
        reason: "Gateway is stopped; start it only from a local operator shell after reviewing Hermes status.",
        mutatesRuntimeIfRun: true,
        requiresOperatorConfirmation: true,
      }),
      ...base,
    ];
  }
  if (likelyCause === "doctor_timeout_with_gateway_running" || likelyCause === "doctor_timeout") {
    return [
      doctorTriageAction({
        id: "bounded_doctor_recheck",
        priority: 10,
        command: "HERMES_DOCTOR_TRIAGE_TIMEOUT_MS=5000 npm run hermes:doctor-triage",
        reason: "Doctor timed out in the short probe; rerun a bounded longer probe before any channel activation.",
      }),
      doctorTriageAction({
        id: "inspect_runtime_status",
        priority: 20,
        command: "npm run hermes:runtime-check",
        reason: `Current gateway=${runtimeFindings.gateway_service_status}; use sanitized repo diagnostics instead of unbounded doctor calls.`,
      }),
      ...base,
    ];
  }
  if (likelyCause === "persistent_doctor_timeout_with_gateway_running") {
    return [
      doctorTriageAction({
        id: "persistent_doctor_timeout_review",
        priority: 10,
        command: "npm run hermes:runtime-check",
        reason: `Doctor still timed out after ${doctorTimeoutMs}ms while gateway is running; stop repeating doctor probes and review runtime status/update path manually.`,
      }),
      doctorTriageAction({
        id: "manual_hermes_update_review",
        priority: 20,
        command: "hermes update",
        reason: "Hermes version output may report an available update; update only from an operator shell after reviewing release risk.",
        mutatesRuntimeIfRun: true,
        requiresOperatorConfirmation: true,
      }),
      ...base,
    ];
  }
  if (likelyCause === "persistent_doctor_api_connectivity_timeout") {
    return [
      doctorTriageAction({
        id: "api_connectivity_timeout_review",
        priority: 10,
        command: "npm run hermes:runtime-check",
        reason: `Doctor reached API Connectivity and still timed out after ${doctorTimeoutMs}ms; review network/provider connectivity manually instead of repeating doctor probes.`,
      }),
      doctorTriageAction({
        id: "manual_hermes_update_review",
        priority: 20,
        command: "hermes update",
        reason: "Hermes version output may report an available update; update only from an operator shell after reviewing release risk.",
        mutatesRuntimeIfRun: true,
        requiresOperatorConfirmation: true,
      }),
      ...base,
    ];
  }
  if (likelyCause === "doctor_exited_nonzero") {
    return [
      doctorTriageAction({
        id: "inspect_sanitized_doctor_output",
        priority: 10,
        command: "npm run hermes:doctor-triage",
        reason: "Doctor returned non-zero; inspect sanitized stdout/stderr previews before enabling channels.",
      }),
      ...base,
    ];
  }
  return [
    doctorTriageAction({
      id: "rerun_runtime_check",
      priority: 10,
      command: "npm run hermes:runtime-check",
      reason: "Short doctor probe passed or produced no hard blocker; verify the full bounded runtime check.",
    }),
    ...base,
  ];
}

function doctorTriageAction({
  id,
  priority,
  command,
  reason,
  mutatesRuntimeIfRun = false,
  requiresOperatorConfirmation = false,
}) {
  return {
    id,
    priority,
    command,
    reason,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
    mutates_runtime_if_run: Boolean(mutatesRuntimeIfRun),
    requires_operator_confirmation: Boolean(requiresOperatorConfirmation),
  };
}

function doctorTriagePreview(value) {
  return String(value ?? "").slice(0, 500);
}

function channelRecoveryEnvRequirements() {
  return [
    channelRecoveryEnvRequirement({
      id: "telegram_allowlist",
      names: ["HERMES_TELEGRAM_ALLOWED_USER_IDS", "OPENCLAW_TELEGRAM_ALLOWED_USER_IDS"],
      purpose: "Allowlist Telegram users before any channel command can be trusted.",
      configured: envListCount(["HERMES_TELEGRAM_ALLOWED_USER_IDS", "OPENCLAW_TELEGRAM_ALLOWED_USER_IDS"]) > 0,
      configuredCount: envListCount(["HERMES_TELEGRAM_ALLOWED_USER_IDS", "OPENCLAW_TELEGRAM_ALLOWED_USER_IDS"]),
      secret: false,
    }),
    channelRecoveryEnvRequirement({
      id: "private_access_allowlist",
      names: ["PRIVATE_ALLOWED_EMAILS", "TENNIS_EDGE_PRIVATE_ALLOWED_EMAILS"],
      purpose: "Restrict private dashboard/API access to explicit emails.",
      configured: envListCount(["PRIVATE_ALLOWED_EMAILS", "TENNIS_EDGE_PRIVATE_ALLOWED_EMAILS"]) > 0,
      configuredCount: envListCount(["PRIVATE_ALLOWED_EMAILS", "TENNIS_EDGE_PRIVATE_ALLOWED_EMAILS"]),
      secret: false,
    }),
    channelRecoveryEnvRequirement({
      id: "local_admin_token",
      names: ["ADMIN_API_TOKEN", "TENNIS_EDGE_ADMIN_API_TOKEN"],
      purpose: "Authorize protected backend-only operator actions through stdin/local env.",
      configured: envConfigured(["ADMIN_API_TOKEN", "TENNIS_EDGE_ADMIN_API_TOKEN"]),
      configuredCount: envConfigured(["ADMIN_API_TOKEN", "TENNIS_EDGE_ADMIN_API_TOKEN"]) ? 1 : 0,
      secret: true,
    }),
  ];
}

function channelRecoveryEnvRequirement({ id, names, purpose, configured, configuredCount, secret }) {
  return {
    id,
    names,
    purpose,
    configured: Boolean(configured),
    configured_count: configuredCount,
    secret: Boolean(secret),
    secret_value_printed: false,
  };
}

function channelRecoveryHumanSteps(actions) {
  return actions
    .filter((action) => action.requires_operator_confirmation || action.mutates_runtime_if_run)
    .map((action) => action.command);
}

function buildMissionControl({
  backend,
  channel,
  report,
  eventPlan,
  sourceRoutes,
  liveWindowPlan,
}) {
  const lanes = missionControlLanes({ backend, channel, report, eventPlan, sourceRoutes, liveWindowPlan });
  const nextAction = missionControlNextAction(lanes);
  const hardBlocked = lanes.some((lane) => lane.status === "blocked" && lane.priority < 70);
  return {
    generated_at: new Date().toISOString(),
    mode: "mission_control",
    status: hardBlocked ? "blocked" : "ready",
    active_ceiling: channel.readiness_ceiling ?? "observe",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    summary: missionControlSummary({ backend, channel, liveWindowPlan, sourceRoutes }),
    next_action: nextAction,
    lanes,
    packets: {
      backend_readiness: {
        status: backend.status,
        endpoint_summary: backend.endpoint_summary,
        request_error_count: backend.request_errors?.length ?? 0,
      },
      channel_readiness: {
        status: channel.status,
        readiness_ceiling: channel.readiness_ceiling,
        failed_checks: (channel.checks ?? [])
          .filter((check) => check.status !== "pass")
          .map((check) => check.id),
      },
      live_window: {
        status: liveWindowPlan.status,
        window_open: liveWindowPlan.window_open,
        blockers: liveWindowPlan.blockers ?? [],
      },
      source_routes: {
        status: sourceRoutes.status,
        next_route: sourceRoutes.next_route?.id ?? null,
        route_count: sourceRoutes.routes?.length ?? 0,
      },
    },
    safe_jailbreak_policy: sourceRoutes.safe_jailbreak_policy,
    forbidden_actions: report.forbidden_collection_paths ?? [],
    acceptance_evidence: [
      "backend_readiness.status=ready",
      "channel_readiness.readiness_ceiling=channel_ready",
      "source_routes.next_route is explicit and non-executing",
      "live_window evaluated before paper autopilot",
      "real_execution_hard_block=true",
    ],
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block === true
        && backend.safety?.real_execution_hard_block === true,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function missionControlSummary({ backend, channel, liveWindowPlan, sourceRoutes }) {
  return [
    `backend=${backend.status}`,
    `channel=${channel.status}:${channel.readiness_ceiling}`,
    `live_window=${liveWindowPlan.status}`,
    `next_route=${sourceRoutes.next_route?.id ?? "none"}`,
  ].join(" | ");
}

function missionControlLanes({ backend, channel, report, eventPlan, sourceRoutes, liveWindowPlan }) {
  return [
    missionControlLane({
      id: "backend",
      priority: 10,
      status: backend.status,
      command: backend.next_action?.command ?? "npm --silent run hermes:backend-readiness",
      reason: backend.next_action?.reason ?? "Verify FastAPI internal endpoints before live-window routing.",
      blockers: (backend.checks ?? []).filter((check) => check.status === "fail").map((check) => check.id),
      source: "backend_readiness",
      mutatesRuntimeIfRun: Boolean(backend.next_action?.mutates_runtime_if_run),
      requiresOperatorConfirmation: Boolean(backend.next_action?.requires_operator_confirmation),
    }),
    missionControlLane({
      id: "channel",
      priority: 20,
      status: channel.status,
      command: channel.next_action?.command ?? "npm --silent run hermes:channel-readiness",
      reason: channel.next_action?.reason ?? "Verify Hermes gateway/channel prerequisites before cron or Telegram automation.",
      blockers: (channel.checks ?? []).filter((check) => check.status !== "pass").map((check) => check.id),
      source: "channel_readiness",
      mutatesRuntimeIfRun: Boolean(channel.next_action?.mutates_runtime_if_run),
      requiresOperatorConfirmation: Boolean(channel.next_action?.requires_operator_confirmation),
    }),
    missionControlLane({
      id: "safety",
      priority: 30,
      status: report.safety?.real_execution_hard_block === true
        && eventPlan.safety?.can_submit_real_orders === false
        ? "ready"
        : "blocked",
      command: "npm --silent run hermes:backend-readiness",
      reason: "Real execution and unsafe collection paths must remain blocked before any higher autonomy.",
      blockers: report.safety?.real_execution_hard_block === true ? [] : ["real_execution_hard_block_missing"],
      source: "intelligence",
    }),
    missionControlLane({
      id: "live_window",
      priority: 40,
      status: liveWindowPlan.status === "blocked" || liveWindowPlan.status === "safety_stop"
        ? "blocked"
        : "ready",
      command: liveWindowPlan.next_action?.command ?? "npm --silent run hermes:live-window",
      reason: liveWindowPlan.next_action?.reason ?? "Evaluate the current live window before paper autopilot.",
      blockers: liveWindowPlan.blockers ?? [],
      source: "live_window",
    }),
    missionControlLane({
      id: "source_routes",
      priority: 50,
      status: sourceRoutes.status,
      command: sourceRoutes.next_route?.command ?? "npm --silent run hermes:source-route-matrix",
      reason: sourceRoutes.next_route?.reason ?? "Use allowed data routes only.",
      blockers: sourceRoutes.next_route?.blocked_when ?? [],
      source: "source_route_matrix",
      requiresOperatorConfirmation: Boolean(sourceRoutes.next_route?.operator_required),
    }),
  ].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function missionControlLane({
  id,
  priority,
  status,
  command,
  reason,
  blockers = [],
  source,
  mutatesRuntimeIfRun = false,
  requiresOperatorConfirmation = false,
}) {
  return {
    id,
    priority,
    status,
    command,
    reason,
    blockers,
    source,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    mutates_runtime_if_run: Boolean(mutatesRuntimeIfRun),
    requires_operator_confirmation: Boolean(requiresOperatorConfirmation),
  };
}

function missionControlNextAction(lanes) {
  const blockedLane = lanes.find((lane) => lane.status === "blocked");
  const lane = blockedLane ?? lanes.find((item) => item.status === "ready") ?? lanes[0] ?? null;
  if (!lane) return null;
  return {
    id: `${lane.id}_next_action`,
    lane: lane.id,
    command: lane.command,
    reason: lane.reason,
    source: lane.source,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    mutates_runtime_if_run: lane.mutates_runtime_if_run,
    requires_operator_confirmation: lane.requires_operator_confirmation,
  };
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

async function liveWindow() {
  const report = await intelligenceData();
  const eventPlan = buildEventPlan(report);
  const playbookPlan = buildPlaybook(report, eventPlan);
  const liveStatsPlan = buildLiveStats(report, eventPlan, playbookPlan);
  printJson(buildLiveWindow(report, eventPlan, playbookPlan, liveStatsPlan));
}

async function matchPulse() {
  const [report, matches] = await Promise.all([
    intelligenceData(),
    request("/api/v1/live/matches"),
  ]);
  const eventPlan = buildEventPlan(report);
  const playbookPlan = buildPlaybook(report, eventPlan);
  const liveStatsPlan = buildLiveStats(report, eventPlan, playbookPlan);
  const liveWindowPlan = buildLiveWindow(report, eventPlan, playbookPlan, liveStatsPlan);
  printJson(buildMatchPulse({ report, eventPlan, liveWindowPlan, matches }));
}

async function collectionPlan() {
  const [report, matches] = await Promise.all([
    intelligenceData(),
    request("/api/v1/live/matches"),
  ]);
  const eventPlan = buildEventPlan(report);
  const playbookPlan = buildPlaybook(report, eventPlan);
  const liveStatsPlan = buildLiveStats(report, eventPlan, playbookPlan);
  const liveWindowPlan = buildLiveWindow(report, eventPlan, playbookPlan, liveStatsPlan);
  const pulse = buildMatchPulse({ report, eventPlan, liveWindowPlan, matches });
  printJson(buildCollectionPlan({ report, eventPlan, liveWindowPlan, pulse }));
}

async function quotaPlan() {
  const [report, matches] = await Promise.all([
    intelligenceData(),
    request("/api/v1/live/matches"),
  ]);
  const eventPlan = buildEventPlan(report);
  const playbookPlan = buildPlaybook(report, eventPlan);
  const liveStatsPlan = buildLiveStats(report, eventPlan, playbookPlan);
  const liveWindowPlan = buildLiveWindow(report, eventPlan, playbookPlan, liveStatsPlan);
  const pulse = buildMatchPulse({ report, eventPlan, liveWindowPlan, matches });
  const collection = buildCollectionPlan({ report, eventPlan, liveWindowPlan, pulse });
  printJson(buildQuotaPlan({ report, collection }));
}

async function liveController() {
  printJson(await liveControllerData());
}

async function grandSlamReadiness() {
  printJson(await grandSlamReadinessData());
}

async function grandSlamMission() {
  printJson(await grandSlamMissionData());
}

async function grandSlamScorelineForecast() {
  printJson(await grandSlamScorelineForecastData());
}

async function grandSlamMissionLedger() {
  const mission = await grandSlamMissionData();
  const ledger = buildGrandSlamMissionLedger(mission);
  writeGrandSlamMissionLedger(ledger.record);
  printJson(ledger);
}

async function grandSlamMissionLedgerReport() {
  printJson(buildGrandSlamMissionLedgerReport(readGrandSlamMissionLedgerRecords()));
}

async function grandSlamReadinessData() {
  const [backend, report, matches] = await Promise.all([
    backendReadinessData(),
    intelligenceData(),
    liveMatchesData(),
  ]);
  const eventPlan = buildEventPlan(report);
  const playbookPlan = buildPlaybook(report, eventPlan);
  const liveStatsPlan = buildLiveStats(report, eventPlan, playbookPlan);
  const liveWindowPlan = buildLiveWindow(report, eventPlan, playbookPlan, liveStatsPlan);
  const pulse = buildMatchPulse({ report, eventPlan, liveWindowPlan, matches });
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  const sourceRoutes = buildSourceRouteMatrix({ report, eventPlan, sourcePlan });
  return buildGrandSlamReadiness({
    backend,
    report,
    eventPlan,
    liveWindowPlan,
    pulse,
    sourceRoutes,
    matches,
  });
}

async function grandSlamScorelineForecastData() {
  const [backend, report, matches] = await Promise.all([
    backendReadinessData(),
    intelligenceData(),
    liveMatchesData(),
  ]);
  const eventPlan = buildEventPlan(report);
  const playbookPlan = buildPlaybook(report, eventPlan);
  const liveStatsPlan = buildLiveStats(report, eventPlan, playbookPlan);
  const liveWindowPlan = buildLiveWindow(report, eventPlan, playbookPlan, liveStatsPlan);
  const pulse = buildMatchPulse({ report, eventPlan, liveWindowPlan, matches });
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  const sourceRoutes = buildSourceRouteMatrix({ report, eventPlan, sourcePlan });
  const grandSlam = buildGrandSlamReadiness({
    backend,
    report,
    eventPlan,
    liveWindowPlan,
    pulse,
    sourceRoutes,
    matches,
  });
  return buildGrandSlamScorelineForecast({
    backend,
    report,
    liveWindowPlan,
    pulse,
    sourceRoutes,
    matches,
    grandSlam,
  });
}

async function grandSlamMissionData() {
  const [backend, report, matches] = await Promise.all([
    backendReadinessData(),
    intelligenceData(),
    liveMatchesData(),
  ]);
  const eventPlan = buildEventPlan(report);
  const playbookPlan = buildPlaybook(report, eventPlan);
  const liveStatsPlan = buildLiveStats(report, eventPlan, playbookPlan);
  const liveWindowPlan = buildLiveWindow(report, eventPlan, playbookPlan, liveStatsPlan);
  const pulse = buildMatchPulse({ report, eventPlan, liveWindowPlan, matches });
  const collection = buildCollectionPlan({ report, eventPlan, liveWindowPlan, pulse });
  const quota = buildQuotaPlan({ report, collection });
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  const sourceRoutes = buildSourceRouteMatrix({ report, eventPlan, sourcePlan });
  const grandSlam = buildGrandSlamReadiness({
    backend,
    report,
    eventPlan,
    liveWindowPlan,
    pulse,
    sourceRoutes,
    matches,
  });
  const scorelineForecast = buildGrandSlamScorelineForecast({
    backend,
    report,
    liveWindowPlan,
    pulse,
    sourceRoutes,
    matches,
    grandSlam,
  });
  const historicalBackfill = buildHistoricalBackfillPlan({
    report,
    eventPlan,
    sourcePlan,
    sourceRoutes,
    grandSlam,
  });
  const learning = buildLearningReview(report, eventPlan, playbookPlan);
  const liveControllerPlan = buildLiveController({
    report,
    eventPlan,
    liveWindowPlan,
    pulse,
    collection,
    quota,
    sourceRoutes,
  });
  return buildGrandSlamMission({
    backend,
    report,
    eventPlan,
    liveStatsPlan,
    liveWindowPlan,
    pulse,
    collection,
    quota,
    sourceRoutes,
    historicalBackfill,
    grandSlam,
    scorelineForecast,
    learning,
    liveControllerPlan,
  });
}

async function liveControllerData() {
  const [report, matches] = await Promise.all([
    intelligenceData(),
    liveMatchesData(),
  ]);
  const eventPlan = buildEventPlan(report);
  const playbookPlan = buildPlaybook(report, eventPlan);
  const liveStatsPlan = buildLiveStats(report, eventPlan, playbookPlan);
  const liveWindowPlan = buildLiveWindow(report, eventPlan, playbookPlan, liveStatsPlan);
  const pulse = buildMatchPulse({ report, eventPlan, liveWindowPlan, matches });
  const collection = buildCollectionPlan({ report, eventPlan, liveWindowPlan, pulse });
  const quota = buildQuotaPlan({ report, collection });
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  const sourceRoutes = buildSourceRouteMatrix({ report, eventPlan, sourcePlan });
  return buildLiveController({
    report,
    eventPlan,
    liveWindowPlan,
    pulse,
    collection,
    quota,
    sourceRoutes,
  });
}

async function liveControllerLedger() {
  const controller = await liveControllerData();
  const ledger = buildLiveControllerLedger(controller);
  writeLiveControllerLedger(ledger.record);
  printJson(ledger);
}

async function liveControllerLedgerReport() {
  printJson(buildLiveControllerLedgerReport(readLiveControllerLedgerRecords()));
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

async function safeLoop() {
  printJson(await safeLoopData());
}

async function autonomyBrief() {
  const loop = await safeLoopData();
  const runtimePriorities = buildRuntimeFixPriorities(buildOperatorLedgerReport(readOperatorLedgerRecords()));
  printJson(buildAutonomyBrief({ loop, runtimePriorities }));
}

async function sourceDiscovery() {
  const report = await intelligenceData();
  const eventPlan = buildEventPlan(report);
  printJson(buildSourceDiscovery({ report, eventPlan }));
}

async function sourceRouteMatrix() {
  printJson(await sourceRouteMatrixData());
}

async function sourceRouteMatrixData() {
  const report = await intelligenceData();
  const eventPlan = buildEventPlan(report);
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  return buildSourceRouteMatrix({ report, eventPlan, sourcePlan });
}

async function sourceRouteLedger() {
  const matrix = await sourceRouteMatrixData();
  const ledger = buildSourceRouteLedger(matrix);
  writeSourceRouteLedger(ledger.record);
  printJson(ledger);
}

async function sourceRouteLedgerReport() {
  printJson(buildSourceRouteLedgerReport(readSourceRouteLedgerRecords()));
}

async function replayBackfillContract() {
  const report = await intelligenceData();
  const eventPlan = buildEventPlan(report);
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  const sourceRoutes = buildSourceRouteMatrix({ report, eventPlan, sourcePlan });
  const sourceRouteReport = buildSourceRouteLedgerReport(readSourceRouteLedgerRecords());
  const sourceIntakeReport = buildSourceIntakeLedgerReport(readSourceIntakeLedgerRecords());
  printJson(buildReplayBackfillContract({
    report,
    eventPlan,
    sourcePlan,
    sourceRoutes,
    sourceRouteReport,
    sourceIntakeReport,
  }));
}

async function sourceUseManifest() {
  printJson(await sourceUseManifestData());
}

async function sourceUseManifestData() {
  const [report, grandSlam] = await Promise.all([
    intelligenceData(),
    grandSlamReadinessData(),
  ]);
  const eventPlan = buildEventPlan(report);
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  const sourceRoutes = buildSourceRouteMatrix({ report, eventPlan, sourcePlan });
  const historicalBackfill = buildHistoricalBackfillPlan({
    report,
    eventPlan,
    sourcePlan,
    sourceRoutes,
    grandSlam,
  });
  const enterpriseReadiness = buildEnterpriseReadinessPacket({ report, eventPlan });
  return buildSourceUseManifest({
    report,
    eventPlan,
    sourcePlan,
    sourceRoutes,
    historicalBackfill,
    enterpriseReadiness,
  });
}

async function sourceUseLedger() {
  const manifest = await sourceUseManifestData();
  const ledger = buildSourceUseLedger(manifest);
  writeSourceUseLedger(ledger.record);
  printJson(ledger);
}

async function sourceUseLedgerReport() {
  printJson(buildSourceUseLedgerReport(readSourceUseLedgerRecords()));
}

async function sourceIntakePlan() {
  printJson(await sourceIntakePlanData());
}

async function sourceIntakePlanData() {
  const [report, grandSlam] = await Promise.all([
    intelligenceData(),
    grandSlamReadinessData(),
  ]);
  const eventPlan = buildEventPlan(report);
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  const sourceRoutes = buildSourceRouteMatrix({ report, eventPlan, sourcePlan });
  const historicalBackfill = buildHistoricalBackfillPlan({
    report,
    eventPlan,
    sourcePlan,
    sourceRoutes,
    grandSlam,
  });
  const enterpriseReadiness = buildEnterpriseReadinessPacket({ report, eventPlan });
  const manifest = buildSourceUseManifest({
    report,
    eventPlan,
    sourcePlan,
    sourceRoutes,
    historicalBackfill,
    enterpriseReadiness,
  });
  const sourceUseReport = buildSourceUseLedgerReport(readSourceUseLedgerRecords());
  return buildSourceIntakePlan({
    report,
    eventPlan,
    sourcePlan,
    historicalBackfill,
    enterpriseReadiness,
    manifest,
    sourceUseReport,
  });
}

async function sourceIntakeLedger() {
  const plan = await sourceIntakePlanData();
  const ledger = buildSourceIntakeLedger(plan);
  writeSourceIntakeLedger(ledger.record);
  printJson(ledger);
}

async function sourceIntakeLedgerReport() {
  printJson(buildSourceIntakeLedgerReport(readSourceIntakeLedgerRecords()));
}

async function historicalBackfillPlan() {
  const [report, grandSlam] = await Promise.all([
    intelligenceData(),
    grandSlamReadinessData(),
  ]);
  const eventPlan = buildEventPlan(report);
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  const sourceRoutes = buildSourceRouteMatrix({ report, eventPlan, sourcePlan });
  printJson(buildHistoricalBackfillPlan({
    report,
    eventPlan,
    sourcePlan,
    sourceRoutes,
    grandSlam,
  }));
}

async function enterpriseAccuracyPlan() {
  const [loop, report, grandSlam] = await Promise.all([
    safeLoopData(),
    intelligenceData(),
    grandSlamReadinessData(),
  ]);
  const eventPlan = buildEventPlan(report);
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  const sourceRoutes = buildSourceRouteMatrix({ report, eventPlan, sourcePlan });
  const historicalBackfill = buildHistoricalBackfillPlan({
    report,
    eventPlan,
    sourcePlan,
    sourceRoutes,
    grandSlam,
  });
  printJson(buildEnterpriseAccuracyPlan({
    loop,
    report,
    eventPlan,
    sourcePlan,
    sourceRoutes,
    historicalBackfill,
    grandSlam,
  }));
}

async function enterpriseReadiness() {
  printJson(await enterpriseReadinessPacketData());
}

async function enterpriseReadinessPacketData() {
  const report = await enterpriseReadinessReportData();
  const eventPlan = buildEventPlan(report);
  return buildEnterpriseReadinessPacket({ report, eventPlan });
}

async function enterpriseReadinessReportData() {
  const response = await safeRequest(
    "/api/v1/dashboard/live-state",
    backendUnavailableDashboardState,
    "dashboard_state",
    { timeoutMs: enterpriseReadinessTimeoutMs() },
  );
  return buildEnterpriseReadinessReport(response.data, response.error);
}

async function triggerPolicy() {
  const [loop, report, grandSlam] = await Promise.all([
    safeLoopData(),
    intelligenceData(),
    grandSlamReadinessData(),
  ]);
  const eventPlan = buildEventPlan(report);
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  printJson(buildTriggerPolicy({ loop, sourcePlan, grandSlam }));
}

async function opsCompiler() {
  const enterpriseReadinessPacket = await enterpriseReadinessPacketData();
  const [loop, report, grandSlam, scorelineForecast] = await Promise.all([
    safeLoopData(),
    intelligenceData(),
    grandSlamReadinessData(),
    grandSlamScorelineForecastData(),
  ]);
  const { effectiveness } = autonomyEffectivenessData();
  const eventPlan = buildEventPlan(report);
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  const sourceRoutes = buildSourceRouteMatrix({ report, eventPlan, sourcePlan });
  const historicalBackfill = buildHistoricalBackfillPlan({
    report,
    eventPlan,
    sourcePlan,
    sourceRoutes,
    grandSlam,
  });
  const sourceUseManifest = buildSourceUseManifest({
    report,
    eventPlan,
    sourcePlan,
    sourceRoutes,
    historicalBackfill,
    enterpriseReadiness: enterpriseReadinessPacket,
  });
  const enterpriseAccuracy = buildEnterpriseAccuracyPlan({
    loop,
    report,
    eventPlan,
    sourcePlan,
    sourceRoutes,
    historicalBackfill,
    grandSlam,
  });
  const triggerPlan = buildTriggerPolicy({ loop, sourcePlan, grandSlam });
  const runtimePriorities = buildRuntimeFixPriorities(buildOperatorLedgerReport(readOperatorLedgerRecords()));
  const autonomyPlan = buildAutonomyBrief({ loop, runtimePriorities });
  const operator = buildOperatorPacket(loop);
  printJson(buildOpsCompiler({
    loop,
    sourcePlan,
    triggerPlan,
    grandSlam,
    autonomyPlan,
    operator,
    effectiveness,
    enterpriseReadiness: enterpriseReadinessPacket,
    enterpriseAccuracy,
    sourceUseManifest,
    scorelineForecast,
  }));
}

async function capabilityAudit() {
  const [loop, report] = await Promise.all([
    safeLoopData(),
    intelligenceData(),
  ]);
  const eventPlan = buildEventPlan(report);
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  const triggerPlan = buildTriggerPolicy({ loop, sourcePlan });
  const runtimePriorities = buildRuntimeFixPriorities(buildOperatorLedgerReport(readOperatorLedgerRecords()));
  const autonomyPlan = buildAutonomyBrief({ loop, runtimePriorities });
  const operator = buildOperatorPacket(loop);
  const opsPacket = buildOpsCompiler({
    loop,
    sourcePlan,
    triggerPlan,
    autonomyPlan,
    operator,
  });
  printJson(buildCapabilityAudit({
    loop,
    report,
    eventPlan,
    sourcePlan,
    autonomyPlan,
    opsPacket,
  }));
}

async function autonomyGates() {
  const [loop, report] = await Promise.all([
    safeLoopData(),
    intelligenceData(),
  ]);
  const eventPlan = buildEventPlan(report);
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  const triggerPlan = buildTriggerPolicy({ loop, sourcePlan });
  const runtimePriorities = buildRuntimeFixPriorities(buildOperatorLedgerReport(readOperatorLedgerRecords()));
  const autonomyPlan = buildAutonomyBrief({ loop, runtimePriorities });
  const operator = buildOperatorPacket(loop);
  const opsPacket = buildOpsCompiler({
    loop,
    sourcePlan,
    triggerPlan,
    autonomyPlan,
    operator,
  });
  const capabilityAuditPlan = buildCapabilityAudit({
    loop,
    report,
    eventPlan,
    sourcePlan,
    autonomyPlan,
    opsPacket,
  });
  const grandSlam = await grandSlamReadinessData();
  const rehearsal = buildSchedulerRehearsal(loop, grandSlam);
  const proposal = buildCronProposal(rehearsal);
  const activation = buildActivationChecklist({ loop, rehearsal, proposal });
  printJson(buildAutonomyGates({
    loop,
    report,
    eventPlan,
    sourcePlan,
    capabilityAuditPlan,
    activation,
  }));
}

async function experimentLab() {
  printJson(await experimentLabData());
}

async function experimentLabData() {
  const [loop, report] = await Promise.all([
    safeLoopData(),
    intelligenceData(),
  ]);
  const eventPlan = buildEventPlan(report);
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  const triggerPlan = buildTriggerPolicy({ loop, sourcePlan });
  const experimentReport = buildExperimentLedgerReport(readExperimentLedgerRecords());
  const operatorReport = buildOperatorLedgerReport(readOperatorLedgerRecords());
  const missionReport = buildMissionLedgerReport(readMissionLedgerRecords());
  const liveControllerReport = buildLiveControllerLedgerReport(readLiveControllerLedgerRecords());
  const grandSlamMissionReport = buildGrandSlamMissionLedgerReport(readGrandSlamMissionLedgerRecords());
  const sourceRouteReport = buildSourceRouteLedgerReport(readSourceRouteLedgerRecords());
  const sourceUseReport = buildSourceUseLedgerReport(readSourceUseLedgerRecords());
  const sourceIntakeReport = buildSourceIntakeLedgerReport(readSourceIntakeLedgerRecords());
  const runtimePriorities = buildRuntimeFixPriorities(operatorReport);
  const backlogPlan = buildBacklogPlan({
    experimentReport,
    operatorReport,
    missionReport,
    liveControllerReport,
    grandSlamMissionReport,
    sourceRouteReport,
    sourceUseReport,
    sourceIntakeReport,
    runtimePriorities,
  });
  const autonomyPlan = buildAutonomyBrief({ loop, runtimePriorities });
  const operator = buildOperatorPacket(loop);
  const opsPacket = buildOpsCompiler({
    loop,
    sourcePlan,
    triggerPlan,
    autonomyPlan,
    operator,
  });
  const capabilityAuditPlan = buildCapabilityAudit({
    loop,
    report,
    eventPlan,
    sourcePlan,
    autonomyPlan,
    opsPacket,
  });
  const grandSlam = await grandSlamReadinessData();
  const rehearsal = buildSchedulerRehearsal(loop, grandSlam);
  const proposal = buildCronProposal(rehearsal);
  const activation = buildActivationChecklist({ loop, rehearsal, proposal });
  const gates = buildAutonomyGates({
    loop,
    report,
    eventPlan,
    sourcePlan,
    capabilityAuditPlan,
    activation,
  });
  return buildExperimentLab({
    loop,
    report,
    eventPlan,
    sourcePlan,
    capabilityAuditPlan,
    gates,
    backlogPlan,
  });
}

async function experimentLedger() {
  const lab = await experimentLabData();
  const ledger = buildExperimentLedger(lab);
  writeExperimentLedger(ledger.record);
  printJson(ledger);
}

async function experimentLedgerReport() {
  printJson(buildExperimentLedgerReport(readExperimentLedgerRecords()));
}

async function backlogPlan() {
  const { backlog } = autonomyEffectivenessData();
  printJson(backlog);
}

function autonomyEffectivenessData() {
  const experimentReport = buildExperimentLedgerReport(readExperimentLedgerRecords());
  const operatorReport = buildOperatorLedgerReport(readOperatorLedgerRecords());
  const missionReport = buildMissionLedgerReport(readMissionLedgerRecords());
  const liveControllerReport = buildLiveControllerLedgerReport(readLiveControllerLedgerRecords());
  const grandSlamMissionReport = buildGrandSlamMissionLedgerReport(readGrandSlamMissionLedgerRecords());
  const sourceRouteReport = buildSourceRouteLedgerReport(readSourceRouteLedgerRecords());
  const sourceUseReport = buildSourceUseLedgerReport(readSourceUseLedgerRecords());
  const sourceIntakeReport = buildSourceIntakeLedgerReport(readSourceIntakeLedgerRecords());
  const runtimePriorities = buildRuntimeFixPriorities(operatorReport);
  const backlog = buildBacklogPlan({
    experimentReport,
    operatorReport,
    missionReport,
    liveControllerReport,
    grandSlamMissionReport,
    sourceRouteReport,
    sourceUseReport,
    sourceIntakeReport,
    runtimePriorities,
  });
  const effectiveness = buildAutonomyEffectiveness({
    experimentReport,
    operatorReport,
    missionReport,
    liveControllerReport,
    grandSlamMissionReport,
    sourceRouteReport,
    sourceUseReport,
    sourceIntakeReport,
    runtimePriorities,
    backlog,
  });
  return {
    experimentReport,
    operatorReport,
    missionReport,
    liveControllerReport,
    grandSlamMissionReport,
    sourceRouteReport,
    sourceUseReport,
    sourceIntakeReport,
    runtimePriorities,
    backlog,
    effectiveness,
  };
}

async function autonomyEffectiveness() {
  const { effectiveness } = autonomyEffectivenessData();
  printJson(effectiveness);
}

async function implementationHandoff() {
  const { backlog, effectiveness } = autonomyEffectivenessData();
  const enterpriseReadinessPacket = await enterpriseReadinessPacketData();
  const channel = buildChannelReadiness(await runtimeCheckData());
  const channelBacklog = buildBacklogPlanWithChannelReadiness(backlog, channel);
  const routedBacklog = buildBacklogPlanWithEnterpriseReadiness(channelBacklog, enterpriseReadinessPacket);
  printJson(buildImplementationHandoff(routedBacklog, effectiveness));
}

async function operatorPacket() {
  const loop = await safeLoopData();
  printJson(buildOperatorPacket(loop));
}

async function operatorLedger() {
  const loop = await safeLoopData();
  const packet = buildOperatorPacket(loop);
  const ledger = buildOperatorLedger(packet);
  writeOperatorLedger(ledger.record);
  printJson(ledger);
}

async function operatorLedgerReport() {
  printJson(buildOperatorLedgerReport(readOperatorLedgerRecords()));
}

async function runtimeFixPriorities() {
  const report = buildOperatorLedgerReport(readOperatorLedgerRecords());
  printJson(buildRuntimeFixPriorities(report));
}

async function safeLoopData() {
  const [runtime, report, matches] = await Promise.all([
    runtimeCheckData(),
    intelligenceData(),
    liveMatchesData(),
  ]);
  const eventPlan = buildEventPlan(report);
  const budgetPlan = buildBudgetChainPlan(report, eventPlan);
  const unblock = buildUnblockPlan(report, eventPlan, budgetPlan);
  const playbookPlan = buildPlaybook(report, eventPlan);
  const liveStatsPlan = buildLiveStats(report, eventPlan, playbookPlan);
  const liveWindowPlan = buildLiveWindow(report, eventPlan, playbookPlan, liveStatsPlan);
  const pulse = buildMatchPulse({ report, eventPlan, liveWindowPlan, matches });
  const collection = buildCollectionPlan({ report, eventPlan, liveWindowPlan, pulse });
  const quotaPlan = buildQuotaPlan({ report, collection });
  const learningPlan = buildLearningReview(report, eventPlan, playbookPlan);
  return buildSafeLoop({
    runtime,
    report,
    eventPlan,
    budgetPlan,
    unblock,
    playbookPlan,
    liveStatsPlan,
    quotaPlan,
    learningPlan,
  });
}

async function liveMatchesData() {
  try {
    return await request("/api/v1/live/matches");
  } catch {
    return [];
  }
}

async function schedulerRehearsal() {
  const [loop, grandSlam] = await Promise.all([
    safeLoopData(),
    grandSlamReadinessData(),
  ]);
  const rehearsal = buildSchedulerRehearsal(loop, grandSlam);
  writeSchedulerAudit(rehearsal);
  printJson(rehearsal);
}

async function cronProposal() {
  const [loop, grandSlam] = await Promise.all([
    safeLoopData(),
    grandSlamReadinessData(),
  ]);
  const rehearsal = buildSchedulerRehearsal(loop, grandSlam);
  writeSchedulerAudit(rehearsal);
  const proposal = buildCronProposal(rehearsal);
  writeCronProposal(proposal);
  printJson(proposal);
}

async function activationChecklist() {
  const [loop, grandSlam] = await Promise.all([
    safeLoopData(),
    grandSlamReadinessData(),
  ]);
  const rehearsal = buildSchedulerRehearsal(loop, grandSlam);
  writeSchedulerAudit(rehearsal);
  const proposal = buildCronProposal(rehearsal);
  writeCronProposal(proposal);
  printJson(buildActivationChecklist({ loop, rehearsal, proposal }));
}

async function runtimeFixPlan() {
  const [loop, grandSlam] = await Promise.all([
    safeLoopData(),
    grandSlamReadinessData(),
  ]);
  const rehearsal = buildSchedulerRehearsal(loop, grandSlam);
  const proposal = buildCronProposal(rehearsal);
  const activation = buildActivationChecklist({ loop, rehearsal, proposal });
  printJson(buildRuntimeFixPlan({ loop, rehearsal, proposal, activation }));
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

function backendUnavailableBriefing({ error }) {
  return {
    summary: `FastAPI local unavailable for Hermes intelligence: ${String(error.message ?? error)}`,
    autopilot_enabled: false,
    channel: "local_cli",
    triage_model: "deterministic_fail_closed",
    critical_model: "none",
    entry_signals: 0,
    provider_alerts: 1,
    readiness_status: "blocked",
    next_actions: [
      "Start or inspect the local FastAPI service before protected automation.",
      "Keep Hermes in observe/report mode while backend intelligence is unavailable.",
    ],
  };
}

function backendUnavailablePreflight({ error }) {
  return {
    status: "blocked",
    generated_at: new Date().toISOString(),
    checks: [
      {
        name: "backend_api",
        status: "fail",
        summary: `FastAPI local did not answer Hermes within the bounded timeout: ${String(error.message ?? error)}`,
      },
      {
        name: "real_execution_hard_block",
        status: "pass",
        summary: "Hermes fail-closed fallback preserves real execution hard block.",
      },
    ],
  };
}

function backendUnavailableAnomalies({ error }) {
  return [
    {
      id: "backend_api_unreachable",
      severity: "high",
      status: "open",
      summary: `Hermes could not collect internal API intelligence: ${String(error.message ?? error)}`,
    },
  ];
}

function backendUnavailableProviderHealth({ error }) {
  return [
    {
      provider: "fastapi",
      configured: true,
      healthy: false,
      status: "unreachable",
      latency_ms: null,
      quota_used: 0,
      quota_limit: 0,
      last_message_at: null,
      note: String(error.message ?? error),
    },
  ];
}

function backendUnavailableDataQuality({ error }) {
  return [
    {
      id: "backend_api_unreachable",
      provider: "fastapi",
      feed: "internal_api",
      sequence_health: 0,
      stale_ticks: 1,
      blocked_signals: 1,
      latency_ms: null,
      notes: [String(error.message ?? error)],
    },
  ];
}

function backendUnavailableReplayBackfillEvidence({ error }) {
  return {
    status: "collecting",
    source: "operational_state_replay_lab",
    contract_id: "replay_backfill_to_operational_truth",
    adapter_boundary: "internal_fastapi_read_models",
    provider_api_call_allowed: false,
    browser_sportsbook_automation_allowed: false,
    bypass_allowed: false,
    can_submit_real_orders: false,
    replay_lab_status: "collecting",
    replay_contract_ready: false,
    persisted_matches: 0,
    score_ticks: 0,
    odds_ticks: 0,
    raw_payloads_saved: 0,
    score_ticks_saved: 0,
    odds_ticks_saved: 0,
    cursors_saved: 0,
    provider_latency_saved: 0,
    resync_required: false,
    scenarios_passed: [],
    scenarios_blocked: [],
    closing_line_proxy_seed_ready: false,
    paper_learning_seed_ready: false,
    signal_gate_regression_ready: false,
    gates: {
      backend_reachable: false,
    },
    notes: [`ReplayBackfillEvidence endpoint unavailable: ${String(error.message ?? error)}`],
  };
}

function backendUnavailableCostProfile() {
  return {
    active_plan: "lean_atp",
    enabled_providers: [],
    estimated_monthly_spend_usd: 0,
    monthly_budget_usd: 500,
    coverage_scope: ["atp_main", "grand_slam_men", "grand_slam_women"],
    skipped_by_coverage_gate: 0,
  };
}

function backendUnavailableCostReport() {
  return {
    live_api_calls: 0,
    cost_per_signal_usd: null,
    provider_calls: [],
    web_socket_uptime_seconds: 0,
  };
}

function backendUnavailablePaperPerformance() {
  return {
    readiness_status: "blocked",
    roi: null,
    clv: null,
    settled_orders: 0,
    open_orders: 0,
    max_drawdown: null,
  };
}

function backendUnavailableExecutionStatus() {
  return {
    real_execution_hard_block: true,
    can_submit_real_orders: false,
    stage: "paper",
    execution_enabled: false,
    venue: "none",
  };
}

function backendUnavailableBankroll() {
  return {
    balance: null,
    currency: null,
    open_exposure: 0,
    daily_pnl: 0,
    weekly_pnl: 0,
  };
}

function backendUnavailableIngestionRuns({ error }) {
  const now = new Date().toISOString();
  return [
    {
      id: "backend_api_unreachable",
      run_type: "hermes_internal_api",
      source: "fastapi",
      status: "failed",
      started_at: now,
      completed_at: now,
      summary: {
        run_kind: "hermes_internal_api",
        source: "fastapi",
        final_status: "failed",
        passed: false,
        resync_required: false,
        live_api_calls: 0,
        notes: [String(error.message ?? error)],
      },
    },
  ];
}

function backendUnavailableDashboardState({ error }) {
  return {
    operational_state: {
      provider_mode: "backend_unavailable",
      source_summary: {
        total_matches: 0,
        persisted_matches: 0,
        match_freshness: [],
      },
      replay_lab: {
        status: "unknown",
      },
      model_lab: {
        status: "blocked",
        production_training_examples: 0,
        can_run_live_backtest: false,
      },
      api_onboarding: {
        budget_chain_completed: false,
        enterprise_eligible: false,
        current_step: "backend_api",
        next_action: "Restore local FastAPI before provider onboarding.",
        core_ready: false,
        steps: [],
        warnings: [String(error.message ?? error)],
      },
    },
  };
}

async function intelligenceData() {
  const responses = await Promise.all([
    safeRequest("/api/v1/agent/briefing", backendUnavailableBriefing, "briefing"),
    safeRequest("/api/v1/agent/preflight", backendUnavailablePreflight, "preflight"),
    safeRequest("/api/v1/agent/anomalies", backendUnavailableAnomalies, "anomalies"),
    safeRequest("/api/v1/provider-health", backendUnavailableProviderHealth, "provider_health"),
    safeRequest("/api/v1/provider-cursors", [], "provider_cursors"),
    safeRequest("/api/v1/data-quality", backendUnavailableDataQuality, "data_quality"),
    safeRequest("/api/v1/cost-profile", backendUnavailableCostProfile, "cost_profile"),
    safeRequest("/api/v1/cost-report/daily", backendUnavailableCostReport, "cost_report"),
    safeRequest("/api/v1/paper/performance", backendUnavailablePaperPerformance, "paper_performance"),
    safeRequest("/api/v1/execution/status", backendUnavailableExecutionStatus, "execution_status"),
    safeRequest("/api/v1/bankroll", backendUnavailableBankroll, "bankroll"),
    safeRequest("/api/v1/signals/live", [], "live_signals"),
    safeRequest("/api/v1/ingestion/runs", backendUnavailableIngestionRuns, "ingestion_runs"),
    safeRequest("/api/v1/dashboard/live-state", backendUnavailableDashboardState, "dashboard_state"),
    safeRequest("/api/v1/replay/backfill-evidence", backendUnavailableReplayBackfillEvidence, "replay_backfill_evidence"),
  ]);
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
    replayBackfillEvidence,
  ] = responses.map((response) => response.data);
  const requestErrors = responses.map((response) => response.error).filter(Boolean);
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
    replayBackfillEvidence,
    requestErrors,
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
    let didTimeout = false;
    const startedAt = new Date();
    const timeout = setTimeout(() => {
      if (settled) return;
      didTimeout = true;
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
        timeout_ms: timeoutMs,
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
        timeout_ms: timeoutMs,
        started_at: startedAt.toISOString(),
        completed_at: new Date().toISOString(),
        exit_code: exitCode,
        signal,
        timed_out: didTimeout,
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

function buildRuntimeFindings(commands) {
  const statusCommand = commands.find((item) => item.name === "hermes status");
  const doctorCommand = commands.find((item) => item.name === "hermes doctor");
  const gatewayStatus = parseGatewayStatus(statusCommand?.stdout ?? "");
  const doctorProgress = parseDoctorProgress(doctorCommand?.stdout ?? "");
  const doctorStatus = doctorCommand?.timed_out
    ? "timed_out"
    : doctorCommand?.error_code
      ? doctorCommand.error_code
      : doctorCommand?.exit_code === 0
        ? "passed"
        : doctorCommand
          ? "failed"
          : "not_run";
  const blockers = [];
  if (statusCommand?.error_code === "command_not_found") blockers.push("hermes_command_not_found");
  if (gatewayStatus === "stopped") blockers.push("gateway_service_stopped");
  if (gatewayStatus === "unknown" && statusCommand?.exit_code !== 0) blockers.push("gateway_status_unknown");
  if (doctorStatus === "timed_out") blockers.push("doctor_timed_out");
  if (doctorStatus === "failed") blockers.push("doctor_failed");
  if (doctorCommand?.error_code) blockers.push(`doctor_${doctorCommand.error_code}`);
  return {
    gateway_service_status: gatewayStatus,
    doctor_status: doctorStatus,
    blockers,
    auth_notes: runtimeAuthNotes(statusCommand?.stdout ?? ""),
    messaging_notes: runtimeMessagingNotes(statusCommand?.stdout ?? ""),
    doctor_progress: doctorCommand ? doctorProgress : null,
    doctor_timeout_ms: doctorCommand?.timeout_ms ?? null,
  };
}

function buildRuntimeCapabilitySummary({ commands, runtimeFindings }) {
  const statusCommand = commands.find((item) => item.name === "hermes status");
  const statusText = statusCommand?.stdout ?? "";
  const channels = runtimeChannelSummary(statusText);
  const apiKeys = runtimeApiKeySummary(statusText);
  const authProviders = runtimeAuthProviderSummary(statusText);
  const gatewayRunning = runtimeFindings.gateway_service_status === "running";
  const openAiReady = apiKeys.openai === "configured" || (runtimeFindings.auth_notes ?? []).includes("openai_api_key_present");
  const configuredChannels = Object.entries(channels)
    .filter(([, value]) => value === "configured")
    .map(([key]) => key);
  return {
    model: parseStatusLineValue(statusText, "Model"),
    provider: parseStatusLineValue(statusText, "Provider"),
    project: parseStatusLineValue(statusText, "Project"),
    python: parseStatusLineValue(statusText, "Python"),
    terminal_backend: parseStatusLineValue(statusText, "Backend"),
    gateway_running: gatewayRunning,
    scheduled_jobs: parseIntegerLineValue(statusText, "Jobs"),
    active_sessions: parseIntegerLineValue(statusText, "Active"),
    api_keys: apiKeys,
    auth_providers: authProviders,
    channels,
    configured_channels: configuredChannels,
    openai_api_ready: openAiReady,
    nous_portal_ready: authProviders.nous_portal === "logged_in",
    usable_for_internal_packets: gatewayRunning && openAiReady,
    usable_for_channel_delivery: gatewayRunning && configuredChannels.length > 0,
    blocked_for_autonomous_cron: runtimeFindings.doctor_status !== "passed",
    blocked_for_paper_autopilot: true,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    provider_api_call_allowed: false,
  };
}

function runtimeAutonomyImpact({ runtimeFindings, capabilitySummary, hasMissingCommand, hasFailure }) {
  const usableForPackets = Boolean(capabilitySummary.usable_for_internal_packets);
  const doctorBlocking = runtimeFindings.doctor_status !== "passed";
  return {
    status: hasMissingCommand
      ? "missing_cli"
      : usableForPackets && doctorBlocking
        ? "partial_runtime_available"
        : hasFailure
          ? "degraded"
          : "ready",
    allowed_now: [
      "internal_fastapi_packets",
      ...(usableForPackets ? ["operator_summary_generation"] : []),
      "ledger_reports",
      "read_only_runtime_diagnostics",
    ],
    blocked_until_operator_fix: [
      ...(doctorBlocking ? ["cron_activation", "channel_ready_gate"] : []),
      ...(!capabilitySummary.usable_for_channel_delivery ? ["telegram_or_discord_delivery"] : []),
      "paper_autopilot_without_admin_token",
      "provider_quota_spend_without_operator",
      "real_execution",
    ],
    reason: usableForPackets && doctorBlocking
      ? "Hermes gateway/model path is usable for read-only packets, but doctor timeout keeps channel/cron autonomy blocked."
      : hasMissingCommand
        ? "Hermes CLI is missing, so only repo-local backend packets are safe."
        : hasFailure
          ? "Hermes runtime is degraded; stay observe-only."
          : "Hermes runtime diagnostics are clean; still keep provider and real-execution gates closed.",
    executes_now: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
  };
}

function parseStatusLineValue(output, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(output ?? "").match(new RegExp(`^\\s*${escaped}:\\s*(.+?)\\s*$`, "im"));
  if (!match) return null;
  return stripStatusGlyph(match[1]);
}

function parseIntegerLineValue(output, label) {
  const value = parseStatusLineValue(output, label);
  const match = String(value ?? "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

function stripStatusGlyph(value) {
  return String(value ?? "")
    .replace(/[✓✗]/g, "")
    .replace(/\[REDACTED_[^\]]+\]/g, "[redacted]")
    .trim() || null;
}

function runtimeApiKeySummary(output) {
  return {
    openai: statusPresence(output, "OpenAI"),
    openrouter: statusPresence(output, "OpenRouter"),
    google_gemini: statusPresence(output, "Google / Gemini"),
    deepseek: statusPresence(output, "DeepSeek"),
    xai_grok: statusPresence(output, "xAI / Grok"),
    github: statusPresence(output, "GitHub"),
    browser_use: statusPresence(output, "Browser Use"),
    browserbase: statusPresence(output, "Browserbase"),
  };
}

function runtimeAuthProviderSummary(output) {
  return {
    nous_portal: /Nous Portal\s+✓ logged in/i.test(output) ? "logged_in" : statusPresence(output, "Nous Portal"),
    openai_codex: /OpenAI Codex\s+✓/i.test(output) ? "logged_in" : statusPresence(output, "OpenAI Codex"),
    qwen_oauth: /Qwen OAuth\s+✓/i.test(output) ? "logged_in" : statusPresence(output, "Qwen OAuth"),
    xai_oauth: /xAI OAuth\s+✓/i.test(output) ? "logged_in" : statusPresence(output, "xAI OAuth"),
  };
}

function runtimeChannelSummary(output) {
  return {
    telegram: statusPresence(output, "Telegram"),
    discord: statusPresence(output, "Discord"),
    whatsapp: statusPresence(output, "WhatsApp"),
    slack: statusPresence(output, "Slack"),
    email: statusPresence(output, "Email"),
    signal: statusPresence(output, "Signal"),
  };
}

function statusPresence(output, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const configuredPattern = new RegExp(`${escaped}\\s+✓`, "i");
  const missingPattern = new RegExp(`${escaped}\\s+✗`, "i");
  if (configuredPattern.test(output)) return "configured";
  if (missingPattern.test(output)) return "missing";
  return "unknown";
}

function parseDoctorProgress(output) {
  const text = String(output ?? "");
  const sections = [...text.matchAll(/^◆\s+(.+?)\s*$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const connectivityMatch = text.match(/Running\s+(\d+)\s+connectivity checks/i);
  return {
    sections_seen: sections,
    last_section: sections.at(-1) ?? null,
    reached_api_connectivity: sections.includes("API Connectivity"),
    connectivity_checks_count: connectivityMatch ? Number(connectivityMatch[1]) : null,
    stdout_available: text.trim().length > 0,
  };
}

function parseGatewayStatus(output) {
  const gatewaySectionMatch = String(output ?? "").match(/Gateway Service[\s\S]*?Status:\s*(?:[✓✗]\s*)?([a-z_ -]+)/i);
  if (gatewaySectionMatch) {
    return normalizeRuntimeStatus(gatewaySectionMatch[1]);
  }
  const simpleMatch = String(output ?? "").match(/gateway(?: service)?:\s*([a-z_ -]+)/i);
  if (simpleMatch) {
    return normalizeRuntimeStatus(simpleMatch[1]);
  }
  return "unknown";
}

function normalizeRuntimeStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[^a-z_ -].*$/, "").trim();
  if (normalized.includes("running") || normalized.includes("started") || normalized.includes("active")) return "running";
  if (normalized.includes("stopped") || normalized.includes("not running") || normalized.includes("inactive")) return "stopped";
  if (normalized.includes("disabled")) return "disabled";
  return normalized || "unknown";
}

function runtimeAuthNotes(output) {
  const notes = [];
  if (/OpenAI\s+✓/i.test(output)) notes.push("openai_api_key_present");
  if (/OpenAI Codex\s+✗/i.test(output)) notes.push("openai_codex_auth_missing");
  if (/Nous Portal\s+✓ logged in/i.test(output)) notes.push("nous_portal_logged_in");
  return notes;
}

function runtimeMessagingNotes(output) {
  const notes = [];
  if (/Telegram\s+✗ not configured/i.test(output)) notes.push("telegram_not_configured");
  if (/Discord\s+✗ not configured/i.test(output)) notes.push("discord_not_configured");
  return notes;
}

function runtimeDiagnosticActions({ hasMissingCommand, hasFailure, runtimeFindings }) {
  if (hasMissingCommand) {
    return [
      runtimeDiagnosticAction({
        id: "install_or_expose_hermes",
        command: "command -v hermes",
        reason: "Hermes CLI is missing from PATH; expose the existing install before enabling automation.",
      }),
    ];
  }
  const actions = [];
  if (runtimeFindings.gateway_service_status === "stopped") {
    actions.push(runtimeDiagnosticAction({
      id: "start_gateway_manual_review",
      command: "hermes gateway start",
      reason: "Hermes reports the gateway service stopped; start it only from an operator shell after reviewing status output.",
      mutatesRuntimeIfRun: true,
      requiresOperatorConfirmation: true,
    }));
  }
  if (runtimeFindings.doctor_status === "timed_out") {
    if (Number(runtimeFindings.doctor_timeout_ms) >= 5_000 && runtimeFindings.gateway_service_status === "running") {
      actions.push(runtimeDiagnosticAction({
        id: runtimeFindings.doctor_progress?.reached_api_connectivity
          ? "api_connectivity_timeout_review"
          : "persistent_doctor_timeout_review",
        command: "npm run hermes:runtime-check",
        reason: runtimeFindings.doctor_progress?.reached_api_connectivity
          ? "Hermes doctor reached API Connectivity before timing out; review network/provider connectivity manually instead of repeating doctor probes."
          : "Hermes doctor timed out after the full bounded runtime probe; stop repeating doctor probes and review runtime/update path manually.",
      }));
      actions.push(runtimeDiagnosticAction({
        id: "manual_hermes_update_review",
        command: "hermes update",
        reason: "Hermes version output may report an available update; update only from an operator shell after reviewing release risk.",
        mutatesRuntimeIfRun: true,
        requiresOperatorConfirmation: true,
      }));
    } else {
      actions.push(runtimeDiagnosticAction({
        id: "bounded_doctor_review",
        command: runtimeReviewCommand(runtimeFindings),
        reason: runtimeReviewReason(runtimeFindings),
      }));
    }
  }
  if (runtimeFindings.doctor_status === "failed") {
    actions.push(runtimeDiagnosticAction({
      id: "inspect_doctor_failure",
      command: "hermes doctor",
      reason: "Hermes doctor exited with a failure; inspect output locally before protected automation.",
    }));
  }
  if (!actions.length && hasFailure) {
    actions.push(runtimeDiagnosticAction({
      id: "inspect_runtime_failure",
      command: "npm run hermes:runtime-check",
      reason: "Runtime check is degraded; inspect sanitized command output before enabling channel automation.",
    }));
  }
  if (!actions.length) {
    actions.push(runtimeDiagnosticAction({
      id: "rerun_preflight",
      command: "npm run hermes:preflight",
      reason: "Runtime diagnostics are clean; rerun backend preflight before protected automation.",
    }));
  }
  return actions;
}

function runtimeDiagnosticAction({
  id,
  command,
  reason,
  mutatesRuntimeIfRun = false,
  requiresOperatorConfirmation = false,
}) {
  return {
    id,
    command,
    reason,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    mutates_runtime_if_run: Boolean(mutatesRuntimeIfRun),
    requires_operator_confirmation: Boolean(requiresOperatorConfirmation),
  };
}

function runtimeCheckActions({ hasMissingCommand, hasFailure, runtimeFindings }) {
  if (hasMissingCommand) {
    return [
      "Install or expose the Hermes CLI before enabling runtime automation.",
      "Keep using internal FastAPI packets while Hermes gateway is unavailable.",
    ];
  }
  if (runtimeFindings?.gateway_service_status === "stopped") {
    return [
      "Hermes gateway is stopped; review `hermes status` and start the gateway only from a local operator shell.",
      "Keep cron/Telegram routes in observe mode until the loopback gateway is reachable.",
    ];
  }
  if (runtimeFindings?.doctor_status === "timed_out") {
    return [
      `Hermes doctor timed out in bounded diagnostics; use ${runtimeReviewCommand(runtimeFindings)} instead of unbounded doctor calls.`,
      "Keep protected automation disabled until the gateway and channel checks are clean.",
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

function runtimeReviewCommand(runtimeFindings) {
  if (runtimeFindings?.gateway_service_status === "running"
    && runtimeFindings?.doctor_status === "timed_out"
    && (runtimeFindings?.blockers ?? []).includes("doctor_timed_out")) {
    return "npm run hermes:doctor-triage";
  }
  return "npm run hermes:runtime-check";
}

function runtimeReviewReason(runtimeFindings) {
  if (runtimeReviewCommand(runtimeFindings) === "npm run hermes:doctor-triage") {
    return "Hermes doctor timed out while the gateway is running; run bounded doctor triage before channel readiness.";
  }
  return "Hermes local runtime is missing or degraded; collect CLI diagnostics without repair.";
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
  replayBackfillEvidence,
  requestErrors = [],
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
  const enterpriseShadowProviders = replayLab.enterprise_shadow_providers ?? [];
  const activeCursorsRequiringResync = cursorsRequiringResync.filter((cursor) => (
    !isDeferredEnterpriseProvider(cursor.provider, apiOnboarding)
  ));
  const deferredEnterpriseCursors = cursorsRequiringResync.filter((cursor) => (
    isDeferredEnterpriseProvider(cursor.provider, apiOnboarding)
  ));
  const blockers = [
    ...requestErrors.map((error) => `backend_api:${error.label}`),
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
      replay_backfill_evidence: compactReplayBackfillEvidence(replayBackfillEvidence),
      enterprise_shadow_providers: enterpriseShadowProviders.map(compactReplayContractProvider),
      enterprise_shadow_provider_count: enterpriseShadowProviders.length,
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
      replay_backfill_seed_status: modelLab.replay_backfill_seed_status ?? "collecting",
      replay_backfill_seed_count: Number(modelLab.replay_backfill_seed_count ?? 0),
      closing_line_proxy_seed_ready: Boolean(modelLab.closing_line_proxy_seed_ready),
      paper_learning_seed_ready: Boolean(modelLab.paper_learning_seed_ready),
      signal_gate_regression_ready: Boolean(modelLab.signal_gate_regression_ready),
      can_use_replay_backfill_for_rehearsal: Boolean(modelLab.can_use_replay_backfill_for_rehearsal),
      can_promote_model_from_replay_seeds: Boolean(modelLab.can_promote_model_from_replay_seeds),
      can_run_live_backtest: modelLab.can_run_live_backtest,
    },
    cost_snapshot: {
      active_plan: costProfile.active_plan,
      estimated_monthly_spend_usd: costProfile.estimated_monthly_spend_usd,
      monthly_budget_usd: costProfile.monthly_budget_usd,
      coverage_scope: costProfile.coverage_scope ?? [],
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
      api_request_errors: requestErrors.slice(0, 10),
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

function buildEnterpriseReadinessReport(dashboardState, requestError = null) {
  const operationalState = dashboardState.operational_state ?? {};
  const sourceSummary = operationalState.source_summary ?? {};
  const replayLab = operationalState.replay_lab ?? {};
  const modelLab = operationalState.model_lab ?? {};
  const apiOnboarding = operationalState.api_onboarding ?? {};
  const executionStatus = operationalState.execution_status ?? {};
  const dataQuality = operationalState.data_quality ?? [];
  const providerHealth = operationalState.provider_health ?? [];
  const providerCursors = operationalState.provider_cursors ?? [];
  const ingestionRuns = operationalState.ingestion_runs ?? [];
  const costProfile = operationalState.cost_profile ?? {};
  const costReport = operationalState.daily_cost_report ?? {};
  const enterpriseShadowProviders = replayLab.enterprise_shadow_providers ?? [];
  const unhealthyProviders = providerHealth.filter(
    (health) => health.status !== "healthy" && !String(health.status ?? "").includes("disabled by")
  );
  const cursorsRequiringResync = providerCursors.filter((cursor) => cursor.resync_required);
  const activeCursorsRequiringResync = cursorsRequiringResync.filter((cursor) => (
    !isDeferredEnterpriseProvider(cursor.provider, apiOnboarding)
  ));
  const deferredEnterpriseCursors = cursorsRequiringResync.filter((cursor) => (
    isDeferredEnterpriseProvider(cursor.provider, apiOnboarding)
  ));
  const staleQuality = dataQuality.filter((snapshot) => {
    const sequenceHealth = Number(snapshot.sequence_health ?? 1);
    const staleTicks = Number(snapshot.stale_ticks ?? 0);
    const blockedSignals = Number(snapshot.blocked_signals ?? 0);
    return sequenceHealth < 1 || staleTicks > 0 || blockedSignals > 0;
  });
  const recentIngestionFailures = ingestionRuns
    .filter((run) => ["failed", "degraded"].includes(run.status))
    .slice(0, 5);
  const requestErrors = requestError ? [requestError] : [];
  const blockers = [
    ...requestErrors.map((error) => `backend_api:${error.label}`),
    ...unhealthyProviders.map((health) => `provider:${health.provider}:${health.status}`),
    ...activeCursorsRequiringResync.map((cursor) => `cursor:${cursor.provider}:${cursor.stream}`),
    ...staleQuality.map((snapshot) => (
      `data_quality:${snapshot.provider ?? "unknown"}:${snapshot.feed ?? snapshot.id ?? "unknown"}`
    )),
    ...(executionStatus.can_submit_real_orders ? ["execution:real_orders_enabled"] : []),
  ];
  return {
    generated_at: new Date().toISOString(),
    mode: requestError ? "investigate" : "enterprise_readiness_probe",
    severity: requestError ? "high" : "low",
    summary: requestError
      ? "Enterprise readiness could not read dashboard operational evidence."
      : "Enterprise readiness used focused dashboard operational evidence.",
    recommended_actions: requestError
      ? ["Restore FastAPI dashboard live-state evidence before enterprise review."]
      : ["Keep enterprise feeds deferred until budget chain and paper evidence pass."],
    safety: {
      real_execution_hard_block: requestError ? true : executionStatus.real_execution_hard_block === true,
      can_submit_real_orders: executionStatus.can_submit_real_orders === true,
      execution_stage: executionStatus.stage ?? "paper",
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
    },
    signal_snapshot: {
      entry_signals: 0,
      blocked_signals: 0,
      total_signals: 0,
      briefing_entry_signals: 0,
    },
    data_snapshot: {
      provider_mode: operationalState.provider_mode,
      source_total_matches: sourceSummary.total_matches ?? 0,
      persisted_matches: sourceSummary.persisted_matches ?? 0,
      match_freshness: compactMatchFreshness(sourceSummary.match_freshness ?? []),
      replay_contract_ready: replayLab.status ?? "unknown",
      enterprise_shadow_providers: enterpriseShadowProviders.map(compactReplayContractProvider),
      enterprise_shadow_provider_count: enterpriseShadowProviders.length,
      data_quality_non_pass: staleQuality.length,
      unhealthy_providers: unhealthyProviders.length,
      cursors_requiring_resync: activeCursorsRequiringResync.length,
      deferred_enterprise_cursors: deferredEnterpriseCursors.length,
      recent_ingestion_failures: recentIngestionFailures.length,
    },
    learning_snapshot: {
      readiness_status: modelLab.readiness_status ?? modelLab.status ?? "unknown",
      roi: null,
      clv: null,
      settled_orders: 0,
      model_lab_status: modelLab.status,
      production_training_examples: modelLab.production_training_examples,
      replay_backfill_seed_status: modelLab.replay_backfill_seed_status ?? "collecting",
      replay_backfill_seed_count: Number(modelLab.replay_backfill_seed_count ?? 0),
      closing_line_proxy_seed_ready: Boolean(modelLab.closing_line_proxy_seed_ready),
      paper_learning_seed_ready: Boolean(modelLab.paper_learning_seed_ready),
      signal_gate_regression_ready: Boolean(modelLab.signal_gate_regression_ready),
      can_use_replay_backfill_for_rehearsal: Boolean(modelLab.can_use_replay_backfill_for_rehearsal),
      can_promote_model_from_replay_seeds: Boolean(modelLab.can_promote_model_from_replay_seeds),
      can_run_live_backtest: modelLab.can_run_live_backtest,
    },
    cost_snapshot: {
      active_plan: costProfile.active_plan,
      estimated_monthly_spend_usd: costProfile.estimated_monthly_spend_usd,
      monthly_budget_usd: costProfile.monthly_budget_usd,
      coverage_scope: costProfile.coverage_scope ?? [],
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
      balance: null,
      currency: null,
      open_exposure: 0,
      daily_pnl: 0,
      weekly_pnl: 0,
    },
    blockers,
    degraded_items: {
      preflight_failed: [],
      preflight_warnings: [],
      provider_health: unhealthyProviders.map(compactProviderHealth),
      provider_cursors: activeCursorsRequiringResync.map(compactProviderCursor),
      deferred_enterprise_cursors: deferredEnterpriseCursors.map(compactProviderCursor),
      data_quality: staleQuality.map(compactDataQuality),
      ingestion_runs: recentIngestionFailures.map(compactIngestionRun),
      api_request_errors: requestErrors,
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

function compactReplayContractProvider(provider) {
  return {
    provider: provider.provider,
    adapter_contract: provider.adapter_contract,
    fake_api: provider.fake_api,
    status: provider.status,
    scenarios: (provider.scenarios ?? []).slice(0, 6),
    output_contracts: (provider.output_contracts ?? []).slice(0, 8),
    notes: (provider.notes ?? []).slice(0, 3),
  };
}

function compactReplayBackfillEvidence(evidence = {}) {
  return {
    status: evidence.status ?? "collecting",
    source: evidence.source ?? "operational_state_replay_lab",
    contract_id: evidence.contract_id ?? "replay_backfill_to_operational_truth",
    adapter_boundary: evidence.adapter_boundary ?? "internal_fastapi_read_models",
    provider_api_call_allowed: Boolean(evidence.provider_api_call_allowed),
    can_submit_real_orders: Boolean(evidence.can_submit_real_orders),
    replay_lab_status: evidence.replay_lab_status ?? "unknown",
    replay_contract_ready: Boolean(evidence.replay_contract_ready),
    last_contract_run_id: evidence.last_contract_run_id ?? null,
    last_replay_run_id: evidence.last_replay_run_id ?? null,
    persisted_matches: Number(evidence.persisted_matches ?? 0),
    score_ticks: Number(evidence.score_ticks ?? 0),
    odds_ticks: Number(evidence.odds_ticks ?? 0),
    raw_payloads_saved: Number(evidence.raw_payloads_saved ?? 0),
    score_ticks_saved: Number(evidence.score_ticks_saved ?? 0),
    odds_ticks_saved: Number(evidence.odds_ticks_saved ?? 0),
    cursors_saved: Number(evidence.cursors_saved ?? 0),
    provider_latency_saved: Number(evidence.provider_latency_saved ?? 0),
    resync_required: Boolean(evidence.resync_required),
    scenarios_passed: (evidence.scenarios_passed ?? []).slice(0, 6),
    scenarios_blocked: (evidence.scenarios_blocked ?? []).slice(0, 6),
    closing_line_proxy_seed_ready: Boolean(evidence.closing_line_proxy_seed_ready),
    paper_learning_seed_ready: Boolean(evidence.paper_learning_seed_ready),
    signal_gate_regression_ready: Boolean(evidence.signal_gate_regression_ready),
    gates: evidence.gates ?? {},
    notes: (evidence.notes ?? []).slice(0, 4),
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

function buildSafeLoop({
  runtime,
  report,
  eventPlan,
  budgetPlan,
  unblock,
  playbookPlan,
  liveStatsPlan,
  quotaPlan,
  learningPlan,
}) {
  const safeCommands = safeLoopCommands({
    runtime,
    eventPlan,
    budgetPlan,
    unblock,
    playbookPlan,
    liveStatsPlan,
    quotaPlan,
  });
  const nextBestCommand = chooseSafeLoopCommand({ runtime, unblock, eventPlan, safeCommands });
  const readOnlyRuntimeRoute = buildReadOnlyRuntimeRoute(runtime);
  return {
    generated_at: new Date().toISOString(),
    mode: "safe_loop",
    status: safeLoopStatus({ runtime, eventPlan }),
    summary: `Hermes safe loop: runtime=${runtime.status}, phase=${playbookPlan.active_phase}, mode=${report.mode}`,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    active_phase: playbookPlan.active_phase,
    source_mode: report.mode,
    runtime: {
      status: runtime.status,
      commands: runtime.commands.map((item) => ({
        name: item.name,
        exit_code: item.exit_code,
        timed_out: item.timed_out,
        error_code: item.error_code,
      })),
      next_actions: runtime.next_actions,
      runtime_findings: runtime.runtime_findings,
      capability_summary: runtime.capability_summary,
      autonomy_impact: runtime.autonomy_impact,
      diagnostic_actions: runtime.diagnostic_actions,
    },
    runtime_capability: runtime.capability_summary ?? null,
    runtime_autonomy_impact: runtime.autonomy_impact ?? null,
    read_only_runtime_route: readOnlyRuntimeRoute,
    event_summary: {
      severity: eventPlan.severity,
      can_run_paper_autopilot: eventPlan.can_run_paper_autopilot,
      events: eventPlan.events.map((item) => ({
        type: item.type,
        severity: item.severity,
        can_create_orders: item.can_create_orders,
      })),
    },
    live_stats: {
      collection_status: liveStatsPlan.collection_status?.status,
      processing_status: liveStatsPlan.processing_status?.status,
      health_scores: liveStatsPlan.health_scores,
      sampling_policy: liveStatsPlan.sampling_policy,
    },
    budget_chain: {
      completed: budgetPlan.budget_chain_completed,
      enterprise_eligible: budgetPlan.enterprise_eligible,
      current_step_label: budgetPlan.current_step_label,
      current_step: budgetPlan.current_step,
      provider_api_call_allowed: false,
    },
    quota_plan: {
      status: quotaPlan.status,
      throttle_level: quotaPlan.throttle?.level,
      budget_utilization: quotaPlan.throttle?.budget_utilization,
      effective_target_count: quotaPlan.effective_targets.length,
      provider_command_count: quotaPlan.provider_commands.length,
      provider_api_call_allowed: false,
    },
    learning_review: {
      review_status: learningPlan.review_status,
      model_route: learningPlan.model_route,
      real_execution_recommendation: learningPlan.real_execution_recommendation,
    },
    next_best_command: nextBestCommand,
    safe_commands: safeCommands,
    forbidden_actions: report.forbidden_collection_paths ?? [],
    allowed_collection_paths: report.allowed_collection_paths ?? [],
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function buildAutonomyBrief({ loop, runtimePriorities }) {
  const recommendedLane = chooseAutonomyLane(loop, runtimePriorities);
  const actionQueue = buildAutonomyActionQueue(loop, runtimePriorities);
  return {
    generated_at: new Date().toISOString(),
    mode: "autonomy_brief",
    status: loop.status,
    summary: `Hermes autonomy brief: lane=${recommendedLane.id}, status=${loop.status}, phase=${loop.active_phase}`,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    autonomy_role: "local_safe_orchestrator",
    decision_source: "deterministic_backend_state_and_local_operator_ledger",
    recommended_lane: recommendedLane,
    autonomy_matrix: buildAutonomyMatrix(loop),
    action_queue: actionQueue,
    safe_jailbreak_paths: loop.allowed_collection_paths ?? [],
    forbidden_actions: loop.forbidden_actions ?? [],
    research_principles: [
      {
        id: "event_driven_wakeups",
        source: "OpenClaw cron and Cloudflare scheduled-agent patterns",
        application: "Wake Hermes on summarized events, not every odds tick.",
      },
      {
        id: "tool_guardrails",
        source: "OpenAI Agents SDK guardrail pattern",
        application: "Keep writes, provider calls, paper orders and real execution behind deterministic backend gates.",
      },
      {
        id: "event_sourced_replay",
        source: "JetStream/Postgres replay architecture",
        application: "Use persisted ticks and replay/contracts before live paid feed spend.",
      },
    ],
    safety: {
      real_execution_hard_block: loop.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      provider_api_call_allowed: false,
      can_create_paper_orders: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function buildSourceDiscovery({ report, eventPlan }) {
  const cursorsBlocked = report.cursor_summary?.resync_required > 0
    || eventPlan.events.some((event) => event.type === "cursor_resync_required");
  const budgetCompleted = Boolean(report.budget_chain_snapshot?.budget_chain_completed);
  const providerRoutes = buildProviderRoutes(report, cursorsBlocked);
  return {
    generated_at: new Date().toISOString(),
    mode: "source_discovery",
    status: cursorsBlocked || eventPlan.severity === "high" ? "blocked" : "monitor",
    source_mode: report.mode,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    discovery_scope: [
      "score_state",
      "odds_live",
      "odds_archive",
      "closing_line_proxy",
      "live_statistics",
      "public_context",
      "operator_notes",
      "replay_backfill",
      "historical_public_backfill",
    ],
    acquisition_matrix: {
      score_state: acquisitionRoute({
        primaryPath: "licensed_provider_api",
        status: budgetCompleted ? "candidate" : "monitor",
        command: "npm --silent run hermes:budget-chain",
        reason: "Score state must come from licensed score adapters or persisted replay, never page scraping.",
      }),
      odds_live: acquisitionRoute({
        primaryPath: "provider_websocket",
        status: cursorsBlocked ? "blocked" : "candidate",
        command: cursorsBlocked ? "npm --silent run hermes:events" : "npm --silent run hermes:collection-plan",
        reason: cursorsBlocked
          ? "Odds websocket cursor requires resync; freeze live odds decisions until internal state clears."
          : "Live odds may be watched only through configured provider websocket and backend gates.",
        blockers: cursorsBlocked ? ["cursor_resync_required"] : [],
      }),
      odds_archive: acquisitionRoute({
        primaryPath: "licensed_provider_api",
        status: "candidate",
        command: "npm --silent run hermes:budget-chain",
        reason: "Archive odds are the lowest-risk paid smoke path for budget onboarding.",
      }),
      closing_line_proxy: acquisitionRoute({
        primaryPath: "persisted_postgres_replay",
        status: "monitor",
        command: "npm run api:check:operational-truth -- --pretty",
        reason: "Use stored odds ticks and settlements before relying on live closing-line claims.",
      }),
      live_statistics: acquisitionRoute({
        primaryPath: "internal_fastapi_endpoint",
        status: "monitor",
        command: "npm --silent run hermes:live-stats",
        reason: "Statistics are derived from canonical backend state; Hermes summarizes thresholds only.",
      }),
      public_context: acquisitionRoute({
        primaryPath: "public_allowed_research",
        status: "operator_note_only",
        command: "Record a manual operator note; do not scrape restricted sites.",
        reason: "Public news/research may explain injuries or schedule context only when access is allowed.",
      }),
      operator_notes: acquisitionRoute({
        primaryPath: "manual_operator_note",
        status: "operator_note_only",
        command: "Add a local operator note with source and timestamp.",
        reason: "Human-verified context is allowed when it stays local and does not include secrets.",
      }),
      replay_backfill: acquisitionRoute({
        primaryPath: "persisted_postgres_replay",
        status: "ready",
        command: "npm run api:check:operational-truth -- --pretty",
        reason: "Replay is the safest way to validate collection and processing before live spend.",
      }),
      historical_public_backfill: acquisitionRoute({
        primaryPath: "public_historical_csv_or_git",
        status: "operator_review",
        command: "npm --silent run hermes:historical-backfill-plan",
        reason: "Use public historical ATP/WTA/Slam datasets only after license/attribution review; never scrape live scoreboards.",
      }),
    },
    provider_routes: providerRoutes,
    next_safe_command: chooseSourceDiscoveryCommand({ cursorsBlocked, budgetCompleted, providerRoutes }),
    safe_jailbreak_policy: {
      meaning: "Find lower-cost allowed routes through licensed APIs, internal endpoints, replay and operator notes.",
      bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      credential_or_session_extraction_allowed: false,
      provider_quota_spend_requires_operator: true,
    },
    allowed_collection_paths: report.allowed_collection_paths ?? [],
    forbidden_actions: report.forbidden_collection_paths ?? [],
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      provider_api_call_allowed: false,
      can_create_paper_orders: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function buildSourceRouteMatrix({ report, eventPlan, sourcePlan }) {
  const routes = buildSourceRouteRows({ report, eventPlan, sourcePlan });
  const blockedRoutes = routes.filter((route) => route.status === "blocked");
  const nextRoute = routes.find((route) => route.status === "ready_now")
    ?? routes.find((route) => route.status === "monitor")
    ?? routes[0]
    ?? null;
  return {
    generated_at: new Date().toISOString(),
    mode: "source_route_matrix",
    status: blockedRoutes.length === routes.length ? "blocked" : "ready",
    source_mode: report.mode,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    objective: "rank_allowed_data_routes_for_budget_first_live_stats_without_bypass",
    next_route: nextRoute,
    routes,
    event_policy: {
      wake_on_events_not_ticks: true,
      allowed_triggers: [
        "provider_cursor_gap",
        "new_entry_signal",
        "stale_score_or_odds",
        "quota_guardrail",
        "paper_settlement",
        "daily_ops_window",
        "historical_backfill_review",
      ],
      blocked_triggers: [
        "browser_sportsbook_scrape",
        "credential_session_reuse",
        "provider_quota_spend_without_operator",
        "llm_per_odds_tick",
      ],
    },
    research_basis: [
      "Cloudflare scheduled-agent pattern: wake on schedules/events, not every tick.",
      "OpenAI Agents guardrail pattern: validate tool use before sensitive actions.",
      "Odds websocket pattern: block live decisions on cursor gaps/resync instead of trusting stale stream state.",
      "Public historical datasets can improve priors/backtests only after license review and offline ingestion.",
    ],
    safe_jailbreak_policy: {
      meaning: "Use allowed alternate paths around cost/latency gaps: replay, internal APIs, licensed providers, and manual notes.",
      bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      credential_or_session_extraction_allowed: false,
      provider_quota_spend_requires_operator: true,
    },
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function buildSourceRouteLedger(matrix) {
  const path = sourceRouteLedgerPath();
  const record = {
    generated_at: new Date().toISOString(),
    mode: "source_route_ledger_record",
    outcome: "observed",
    action_executed: false,
    route_command_executed: false,
    provider_command_executed: false,
    bypass_attempted: false,
    status: matrix.status,
    next_route_id: matrix.next_route?.id ?? null,
    next_route_status: matrix.next_route?.status ?? null,
    next_route_command: matrix.next_route?.command ?? null,
    next_route_cost_tier: matrix.next_route?.cost_tier ?? null,
    ready_route_ids: (matrix.routes ?? [])
      .filter((route) => ["ready_now", "monitor", "operator_ready"].includes(route.status))
      .map((route) => route.id),
    blocked_route_ids: (matrix.routes ?? [])
      .filter((route) => route.status === "blocked")
      .map((route) => route.id),
    operator_required_route_ids: (matrix.routes ?? [])
      .filter((route) => route.operator_required)
      .map((route) => route.id),
    safe_jailbreak_bypass_allowed: matrix.safe_jailbreak_policy?.bypass_allowed === true,
    matrix,
    safety: matrix.safety,
  };
  return {
    generated_at: new Date().toISOString(),
    mode: "source_route_ledger",
    status: matrix.status,
    next_route_id: matrix.next_route?.id ?? null,
    read_only: false,
    writes: true,
    write_scope: "local_source_route_jsonl_only",
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    executed_commands: [],
    ledger: {
      path,
      format: "jsonl",
      retention_note: "Local Hermes source-route trace; do not commit runtime logs.",
    },
    record,
    safety: {
      real_execution_hard_block: matrix.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function sourceRouteLedgerPath() {
  return process.env.HERMES_SOURCE_ROUTE_LEDGER_PATH || "hermes/runs/source-route-ledger.jsonl";
}

function writeSourceRouteLedger(record) {
  const path = sourceRouteLedgerPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

function readSourceRouteLedgerRecords() {
  const path = sourceRouteLedgerPath();
  if (!existsSync(path)) {
    return { path, records: [], invalid_rows: 0 };
  }
  const content = readFileSync(path, "utf8");
  let invalidRows = 0;
  const records = content
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        invalidRows += 1;
        return [];
      }
    });
  return { path, records, invalid_rows: invalidRows };
}

function buildSourceRouteLedgerReport({ path, records, invalid_rows: invalidRows }) {
  const nextRouteCounts = rankedCounts(records.map((record) => record.next_route_id).filter(Boolean));
  const nextCommandCounts = rankedCounts(records.map((record) => record.next_route_command).filter(Boolean));
  return {
    generated_at: new Date().toISOString(),
    mode: "source_route_ledger_report",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    ledger: {
      path,
      format: "jsonl",
      invalid_rows: invalidRows,
    },
    total_records: records.length,
    action_executed_count: records.filter((record) => record.action_executed === true).length,
    route_command_executed_count: records.filter((record) => record.route_command_executed === true).length,
    provider_command_executed_count: records.filter((record) => record.provider_command_executed === true).length,
    bypass_attempted_count: records.filter((record) => record.bypass_attempted === true || record.safe_jailbreak_bypass_allowed === true).length,
    status_counts: countValues(records.map((record) => record.status).filter(Boolean)),
    next_route_counts: nextRouteCounts,
    next_route_command_counts: nextCommandCounts,
    next_route_cost_tier_counts: countValues(records.map((record) => record.next_route_cost_tier).filter(Boolean)),
    blocked_route_counts: countValues(records.flatMap((record) => record.blocked_route_ids ?? [])),
    operator_required_route_counts: countValues(records.flatMap((record) => record.operator_required_route_ids ?? [])),
    top_next_route: nextRouteCounts[0]?.command ?? null,
    top_next_command: nextCommandCounts[0]?.command ?? null,
    latest_record: records[records.length - 1] ?? null,
    next_recommendation: sourceRouteLedgerRecommendation({ records, nextRouteCounts, nextCommandCounts }),
    safety: {
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function sourceRouteLedgerRecommendation({ records, nextRouteCounts, nextCommandCounts }) {
  if (!records.length) {
    return {
      id: "collect_source_route_evidence",
      command: "npm --silent run hermes:source-route-ledger",
      reason: "No source-route evidence exists yet; collect a local JSONL row before changing collection code.",
      executes_now: false,
      provider_api_call_allowed: false,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
    };
  }
  const topRoute = nextRouteCounts[0]?.command ?? null;
  const topCommand = nextCommandCounts[0]?.command ?? "npm --silent run hermes:source-route-matrix";
  return {
    id: topRoute ? `review_repeated_${topRoute}` : "review_source_routes",
    command: topCommand,
    reason: topRoute
      ? `Source-route ledger repeatedly recommends ${topRoute}; inspect allowed route evidence before adding provider spend or importers.`
      : "Review source-route evidence before changing collection code.",
    route: topRoute,
    executes_now: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
  };
}

function buildSourceRouteRows({ report, eventPlan, sourcePlan }) {
  const matrix = sourcePlan.acquisition_matrix ?? {};
  const providerRoutes = sourcePlan.provider_routes ?? [];
  const budgetCompleted = Boolean(report.budget_chain_snapshot?.budget_chain_completed);
  const cursorBlocked = eventPlan.events.some((event) => event.type === "cursor_resync_required")
    || matrix.odds_live?.blockers?.includes("cursor_resync_required");
  const archiveRoute = providerRoutes.find((route) => route.provider === "theoddsapi");
  const oddsRoute = providerRoutes.find((route) => route.provider === "odds_api_io");
  const scoreRoute = providerRoutes.find((route) => route.provider === "api_tennis");
  return [
    sourceRouteRow({
      id: "replay_backfill",
      priority: 10,
      lane: "replay",
      purpose: "Validate collection, processing, and signal gates from persisted canonical state before spending live quota.",
      source: matrix.replay_backfill,
      status: "ready_now",
      costTier: "free_local",
      trigger: "daily_ops_window",
      maxCadence: "operator_or_hourly_read_only",
      successEvidence: ["replay_contract_ready", "persisted_matches", "signals_fail_closed_in_replay"],
    }),
    sourceRouteRow({
      id: "live_statistics",
      priority: 20,
      lane: "internal_api",
      purpose: "Summarize score/odds freshness, signal readiness, cost, and learning state without LLM per tick.",
      source: matrix.live_statistics,
      status: "monitor",
      costTier: "free_local",
      trigger: "stale_score_or_odds",
      maxCadence: "frequent_when_runtime_ready",
      successEvidence: ["collection_status", "processing_status", "freshness_buckets", "sampling_policy"],
    }),
    sourceRouteRow({
      id: "closing_line_proxy",
      priority: 30,
      lane: "replay",
      purpose: "Use persisted odds ticks and paper settlements to compute CLV proxies before model promotion.",
      source: matrix.closing_line_proxy,
      status: "monitor",
      costTier: "free_local",
      trigger: "paper_settlement",
      maxCadence: "daily",
      successEvidence: ["closing_line_snapshot", "paper_settlement", "training_example"],
    }),
    sourceRouteRow({
      id: "historical_public_backfill",
      priority: 35,
      lane: "public_historical",
      purpose: "Backfill ATP/WTA/Slam match, ranking and point-level priors from allowed public historical datasets after license review.",
      source: matrix.historical_public_backfill,
      status: "operator_review",
      costTier: "free_public_with_license_constraints",
      trigger: "historical_backfill_review",
      maxCadence: "manual_or_weekly_offline",
      blockedWhen: ["license_not_reviewed", "commercial_use_not_cleared", "attribution_missing", "live_scraping_requested"],
      successEvidence: ["source_manifest_recorded", "license_reviewed", "offline_import_fixture_ready", "no_live_provider_calls"],
      operatorRequired: true,
    }),
    sourceRouteRow({
      id: "odds_archive_budget_smoke",
      priority: 40,
      lane: "licensed_provider",
      purpose: "Onboard the cheapest historical odds route before live websocket spend.",
      source: matrix.odds_archive,
      status: archiveRoute?.status === "ready_next" || String(report.budget_chain_snapshot?.current_step ?? "").includes("theoddsapi")
        ? "operator_ready"
        : "monitor",
      costTier: "budget_paid_or_existing_key",
      trigger: "budget_chain_next_step",
      maxCadence: "operator_smoke_only",
      provider: "theoddsapi",
      blockedWhen: ["missing_key", "operator_not_ready"],
      successEvidence: ["archive_odds_smoke_completed", "raw_payload_saved", "odds_ticks_saved"],
      operatorRequired: true,
    }),
    sourceRouteRow({
      id: "score_state_budget",
      priority: 50,
      lane: "licensed_provider",
      purpose: "Collect fixtures/livescore only through API-Tennis or persisted replay.",
      source: matrix.score_state,
      status: budgetCompleted || scoreRoute?.configured ? "monitor" : "operator_ready",
      costTier: "budget_paid",
      trigger: "daily_ops_window",
      maxCadence: "budget_profile_cadence",
      provider: "api_tennis",
      blockedWhen: ["missing_key", "coverage_gate_outside_budget"],
      successEvidence: ["score_ticks_saved", "provider_latency_saved", "canonical_match_id"],
      operatorRequired: !scoreRoute?.configured,
    }),
    sourceRouteRow({
      id: "odds_live_websocket",
      priority: 60,
      lane: "provider_websocket",
      purpose: "Use websocket odds only after cursor health is clean; freeze signals on gaps/resync.",
      source: matrix.odds_live,
      status: cursorBlocked ? "blocked" : oddsRoute?.configured ? "monitor" : "operator_ready",
      costTier: "budget_paid_live_addon",
      trigger: "new_entry_signal",
      maxCadence: "event_driven_watchlist_only",
      provider: "odds_api_io",
      blockedWhen: ["cursor_resync_required", "stale_odds", "missing_moneyline", "missing_key"],
      successEvidence: ["last_seq_monotonic", "resync_required=false", "odds_ticks_saved"],
      operatorRequired: !oddsRoute?.configured,
    }),
    sourceRouteRow({
      id: "public_context_operator_note",
      priority: 70,
      lane: "operator_note",
      purpose: "Capture injury/news/schedule context only from allowed public access as a local note with source timestamp.",
      source: matrix.public_context,
      status: "operator_note_only",
      costTier: "free_or_manual",
      trigger: "anomaly_review",
      maxCadence: "manual_only",
      blockedWhen: ["paywall", "terms_restricted", "login_required_scraping"],
      successEvidence: ["operator_note_source", "operator_note_timestamp", "no_secret_content"],
      operatorRequired: true,
    }),
    sourceRouteRow({
      id: "manual_operator_note",
      priority: 80,
      lane: "operator_note",
      purpose: "Let the operator add verified local context without touching provider quota.",
      source: matrix.operator_notes,
      status: "operator_note_only",
      costTier: "free_local",
      trigger: "operator_review",
      maxCadence: "manual_only",
      successEvidence: ["operator_note_source", "operator_note_timestamp"],
      operatorRequired: true,
    }),
  ].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function sourceRouteRow({
  id,
  priority,
  lane,
  purpose,
  source,
  status,
  costTier,
  trigger,
  maxCadence,
  provider = null,
  blockedWhen = [],
  successEvidence = [],
  operatorRequired = false,
}) {
  const command = source?.command ?? "npm --silent run hermes:source-discovery";
  return {
    id,
    priority,
    lane,
    purpose,
    status,
    provider,
    primary_path: source?.primary_path ?? "internal_fastapi_endpoint",
    command,
    trigger,
    max_cadence: maxCadence,
    cost_tier: costTier,
    operator_required: Boolean(operatorRequired),
    blocked_when: blockedWhen,
    success_evidence: successEvidence,
    reason: source?.reason ?? purpose,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
  };
}

function buildReplayBackfillContract({
  report,
  eventPlan,
  sourcePlan,
  sourceRoutes,
  sourceRouteReport,
  sourceIntakeReport = emptySourceIntakeLedgerReport(),
}) {
  const route = sourceRoutes.routes?.find((item) => item.id === "replay_backfill") ?? null;
  const persistedMatches = Number(report.data_snapshot?.persisted_matches ?? 0);
  const backendEvidence = report.data_snapshot?.replay_backfill_evidence ?? {};
  const replayStatus = report.data_snapshot?.replay_contract_ready ?? "unknown";
  const replayReady = replayStatus === "ready";
  const routeReady = route?.status === "ready_now";
  const sourceIntakeAllowedReplay = sourceIntakeReport.top_allowed_contract === "route:replay_backfill"
    || sourceIntakeReport.top_next_intake === "route:replay_backfill";
  const sourceRoutePressure = sourceRouteReport.top_next_route === "replay_backfill"
    ? "observed"
    : sourceRouteReport.total_records > 0
      ? "other_route_observed"
      : "collecting";
  const sourceIntakePressure = sourceIntakeAllowedReplay
    ? "allowed_contract_observed"
    : sourceIntakeReport.total_records > 0
      ? "other_intake_observed"
      : "collecting";
  const safeCounters = sourceRouteReport.route_command_executed_count === 0
    && sourceRouteReport.provider_command_executed_count === 0
    && sourceRouteReport.bypass_attempted_count === 0
    && sourceIntakeReport.action_executed_count === 0
    && sourceIntakeReport.intake_command_executed_count === 0
    && sourceIntakeReport.dataset_fetch_attempted_count === 0
    && sourceIntakeReport.provider_command_executed_count === 0
    && sourceIntakeReport.bypass_attempted_count === 0;
  const gates = replayBackfillContractGates({
    routeReady,
    replayReady,
    persistedMatches,
    sourceRouteReport,
    sourceIntakeReport,
    sourceIntakeAllowedReplay,
    backendEvidence,
    safeCounters,
    eventPlan,
  });
  const blockingGates = gates.filter((gate) => gate.status !== "pass");
  return {
    generated_at: new Date().toISOString(),
    mode: "replay_backfill_contract",
    status: blockingGates.length ? "collecting" : "ready",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    objective: "turn_replay_backfill_route_into_offline_operational_truth_contract_without_provider_calls",
    source_route: route,
    source_route_pressure: sourceRoutePressure,
    source_intake_pressure: sourceIntakePressure,
    offline_contract: {
      id: "replay_backfill_to_operational_truth",
      adapter_boundary: "internal_fastapi_read_models",
      route_id: "replay_backfill",
      input_contracts: [
        "operational_state.source_summary",
        "ReplayLabSnapshot",
        "ProviderCursor",
        "score_ticks",
        "odds_ticks",
        "signals",
        "paper_orders",
      ],
      output_contracts: [
        "ReplayBackfillEvidence",
        "DataQualitySnapshot",
        "SignalGateRegressionEvidence",
        "ClosingLineProxySeed",
        "PaperLearningSeed",
      ],
      validation_command: "npm run api:check:operational-truth -- --pretty",
      provider_api_call_allowed: false,
      browser_sportsbook_automation_allowed: false,
      bypass_allowed: false,
      writes: false,
    },
    evidence: {
      provider_mode: report.data_snapshot?.provider_mode ?? "unknown",
      persisted_matches: persistedMatches,
      replay_contract_ready: replayStatus,
      source_route_total_records: sourceRouteReport.total_records,
      source_route_top_next_route: sourceRouteReport.top_next_route,
      source_route_top_next_command: sourceRouteReport.top_next_command,
      blocked_route_counts: sourceRouteReport.blocked_route_counts,
      operator_required_route_counts: sourceRouteReport.operator_required_route_counts,
      route_command_executed_count: sourceRouteReport.route_command_executed_count,
      source_intake_total_records: sourceIntakeReport.total_records,
      source_intake_top_allowed_contract: sourceIntakeReport.top_allowed_contract,
      source_intake_top_next_intake: sourceIntakeReport.top_next_intake,
      source_intake_top_next_intake_lane: sourceIntakeReport.top_next_intake_lane,
      source_intake_top_next_intake_command: sourceIntakeReport.top_next_intake_command,
      source_intake_allowed_contract_counts: sourceIntakeReport.allowed_contract_counts,
      intake_command_executed_count: sourceIntakeReport.intake_command_executed_count,
      dataset_fetch_attempted_count: sourceIntakeReport.dataset_fetch_attempted_count,
      provider_command_executed_count: sourceRouteReport.provider_command_executed_count,
      source_intake_provider_command_executed_count: sourceIntakeReport.provider_command_executed_count,
      backend_replay_backfill_status: backendEvidence.status ?? "collecting",
      backend_replay_backfill_contract_id: backendEvidence.contract_id ?? null,
      backend_replay_backfill_persisted_matches: backendEvidence.persisted_matches ?? 0,
      backend_replay_backfill_score_ticks: backendEvidence.score_ticks ?? 0,
      backend_replay_backfill_odds_ticks: backendEvidence.odds_ticks ?? 0,
      backend_replay_backfill_closing_line_proxy_seed_ready: Boolean(backendEvidence.closing_line_proxy_seed_ready),
      backend_replay_backfill_paper_learning_seed_ready: Boolean(backendEvidence.paper_learning_seed_ready),
      backend_replay_backfill_signal_gate_regression_ready: Boolean(backendEvidence.signal_gate_regression_ready),
      backend_replay_backfill_gates: backendEvidence.gates ?? {},
      bypass_attempted_count: sourceRouteReport.bypass_attempted_count + sourceIntakeReport.bypass_attempted_count,
      data_quality_non_pass: report.data_snapshot?.data_quality_non_pass ?? 0,
      cursors_requiring_resync: report.data_snapshot?.cursors_requiring_resync ?? 0,
    },
    implementation_steps: [
      "inspect_operational_truth_replay_contract_output",
      "use_source_intake_allowed_contract_when_it_proves_route_replay_backfill",
      "map_persisted_matches_score_ticks_odds_ticks_and_signals_into_replay_backfill_evidence",
      "add_or_update_backend_tests_for_replay_backfill_evidence_without_provider_calls",
      "surface_replay_backfill_evidence_in_hermes_source_route_packets",
      "prove_no_provider_api_calls_no_browser_scraping_and_no_bypass",
    ],
    acceptance_criteria: [
      "replay_backfill.route.status=ready_now",
      "offline_contract.id=replay_backfill_to_operational_truth",
      "validation_command=npm run api:check:operational-truth -- --pretty",
      "backend_replay_backfill_evidence.status=ready",
      "provider_api_call_allowed=false",
      "browser_sportsbook_automation_allowed=false",
      "bypass_allowed=false",
      "route_command_executed_count=0",
      "intake_command_executed_count=0",
      "dataset_fetch_attempted_count=0",
      "provider_command_executed_count=0",
      "bypass_attempted_count=0",
    ],
    validation_commands: [
      "npm --silent run hermes:replay-backfill-contract",
      "npm --silent run hermes:source-route-ledger-report",
      "npm --silent run hermes:source-intake-ledger-report",
      "npm run api:check:operational-truth -- --pretty",
      "python3 scripts/check_private_runtime.py",
    ],
    gates,
    next_action: replayBackfillNextAction({ blockingGates, sourceRouteReport, sourceIntakeReport, route }),
    allowed_inputs: [
      "persisted_postgres_replay",
      "internal_fastapi_read_models",
      "local_source_route_ledger",
      "local_source_intake_ledger",
      "offline_replay_contract_evidence",
    ],
    forbidden_actions: [
      ...(sourcePlan.forbidden_actions ?? []),
      "live_provider_call_from_hermes",
      "sportsbook_ui_automation",
      "browser_sportsbook_scrape",
      "anti_bot_bypass",
      "geolocation_bypass",
      "credential_or_session_extraction",
      "paywall_or_terms_bypass",
    ],
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      anti_bot_bypass_allowed: false,
      geolocation_bypass_allowed: false,
      credential_or_session_extraction_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function replayBackfillContractGates({
  routeReady,
  replayReady,
  persistedMatches,
  sourceRouteReport,
  sourceIntakeReport,
  sourceIntakeAllowedReplay,
  backendEvidence,
  safeCounters,
  eventPlan,
}) {
  return [
    replayBackfillGate({
      id: "source_route_ready",
      status: routeReady ? "pass" : "blocked",
      evidence: [`route_ready=${routeReady}`],
      command: "npm --silent run hermes:source-route-matrix",
    }),
    replayBackfillGate({
      id: "replay_lab_ready",
      status: replayReady ? "pass" : "collecting",
      evidence: [`replay_contract_ready=${replayReady}`],
      command: "npm run api:check:operational-truth -- --pretty",
    }),
    replayBackfillGate({
      id: "persisted_canonical_state",
      status: persistedMatches > 0 || Number(backendEvidence.persisted_matches ?? 0) > 0 ? "pass" : "collecting",
      evidence: [`persisted_matches=${persistedMatches}`],
      command: "npm run api:check:operational-truth -- --pretty",
    }),
    replayBackfillGate({
      id: "backend_replay_backfill_evidence",
      status: backendEvidence.status === "ready" ? "pass" : "collecting",
      evidence: [
        `status=${backendEvidence.status ?? "collecting"}`,
        `contract_id=${backendEvidence.contract_id ?? "none"}`,
        `closing_line_proxy_seed_ready=${Boolean(backendEvidence.closing_line_proxy_seed_ready)}`,
        `paper_learning_seed_ready=${Boolean(backendEvidence.paper_learning_seed_ready)}`,
        `signal_gate_regression_ready=${Boolean(backendEvidence.signal_gate_regression_ready)}`,
      ],
      command: "curl -fsS http://127.0.0.1:8000/api/v1/replay/backfill-evidence",
    }),
    replayBackfillGate({
      id: "source_route_pressure",
      status: sourceRouteReport.top_next_route === "replay_backfill" || sourceIntakeAllowedReplay ? "pass" : "collecting",
      evidence: [
        `top_next_route=${sourceRouteReport.top_next_route ?? "none"}`,
        `top_allowed_contract=${sourceIntakeReport.top_allowed_contract ?? "none"}`,
        `top_next_intake=${sourceIntakeReport.top_next_intake ?? "none"}`,
        `source_route_records=${sourceRouteReport.total_records}`,
        `source_intake_records=${sourceIntakeReport.total_records}`,
      ],
      command: sourceIntakeAllowedReplay
        ? "npm --silent run hermes:source-intake-ledger-report"
        : "npm --silent run hermes:source-route-ledger-report",
    }),
    replayBackfillGate({
      id: "no_protected_action_claims",
      status: safeCounters ? "pass" : "blocked",
      evidence: [
        `route_command_executed_count=${sourceRouteReport.route_command_executed_count}`,
        `intake_command_executed_count=${sourceIntakeReport.intake_command_executed_count}`,
        `dataset_fetch_attempted_count=${sourceIntakeReport.dataset_fetch_attempted_count}`,
        `provider_command_executed_count=${sourceRouteReport.provider_command_executed_count + sourceIntakeReport.provider_command_executed_count}`,
        `bypass_attempted_count=${sourceRouteReport.bypass_attempted_count + sourceIntakeReport.bypass_attempted_count}`,
      ],
      command: "npm --silent run hermes:source-intake-ledger-report",
    }),
    replayBackfillGate({
      id: "budget_first_safety",
      status: eventPlan.events.some((event) => event.type === "real_execution_safety_violation") ? "blocked" : "pass",
      evidence: [
        "provider_api_call_allowed=false",
        "can_submit_real_orders=false",
        "browser_sportsbook_automation_allowed=false",
      ],
      command: "python3 scripts/check_private_runtime.py",
    }),
  ];
}

function replayBackfillGate({ id, status, evidence, command }) {
  return {
    id,
    status,
    evidence,
    command,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
  };
}

function replayBackfillNextAction({ blockingGates, sourceRouteReport, sourceIntakeReport, route }) {
  if (!sourceRouteReport.total_records && !sourceIntakeReport.total_records) {
    return {
      id: "collect_source_route_evidence",
      command: "npm --silent run hermes:source-route-ledger",
      reason: "Collect a local source-route ledger row before implementing replay backfill contracts.",
      executes_now: false,
      provider_api_call_allowed: false,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
    };
  }
  const gate = blockingGates[0];
  if (gate) {
    return {
      id: `resolve_${gate.id}`,
      command: gate.command,
      reason: `Replay backfill contract is waiting on ${gate.id}.`,
      executes_now: false,
      provider_api_call_allowed: false,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
    };
  }
  return {
    id: "implement_replay_backfill_evidence",
    command: route?.command ?? "npm run api:check:operational-truth -- --pretty",
    reason: "Replay backfill evidence is ready to become a backend/read-model implementation task without provider spend.",
    executes_now: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
  };
}

function buildSourceUseManifest({
  report,
  eventPlan,
  sourcePlan,
  sourceRoutes,
  historicalBackfill,
  enterpriseReadiness,
}) {
  const sourceRows = [
    ...(sourceRoutes.routes ?? []).map((route) => sourceUseManifestRouteRow({ route, sourcePlan })),
    ...(historicalBackfill.sources ?? []).map((source) => sourceUseManifestHistoricalRow(source)),
    ...(enterpriseReadiness.replay_gate?.providers ?? []).map((provider) => (
      sourceUseManifestEnterpriseRow(provider, enterpriseReadiness)
    )),
  ].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const blockedRows = sourceRows.filter((row) => row.decision === "forbidden");
  const operatorRows = sourceRows.filter((row) => row.decision === "operator_required");
  const deferredRows = sourceRows.filter((row) => row.decision === "deferred");
  const allowedRows = sourceRows.filter((row) => row.decision === "allowed");
  const sourceIds = new Set(sourceRows.map((row) => row.id));
  const requiredIds = [
    "route:replay_backfill",
    "route:live_statistics",
    "route:historical_public_backfill",
    "route:odds_live_websocket",
    "historical:jeff_sackmann_atp",
    "historical:jeff_sackmann_wta",
    "historical:tennis_data_results_odds",
    "enterprise:sportradar",
    "enterprise:betradar_uof",
    "enterprise:txodds",
    "enterprise:betfair",
  ];
  const missingRequiredIds = requiredIds.filter((id) => !sourceIds.has(id));
  const gates = sourceUseManifestGates({
    report,
    eventPlan,
    sourcePlan,
    sourceRows,
    missingRequiredIds,
  });
  const failingGates = gates.filter((gate) => gate.status !== "pass");
  return {
    generated_at: new Date().toISOString(),
    mode: "source_use_manifest",
    objective: "turn_safe_jailbreak_routes_into_auditable_source_use_contracts_before_collection_or_import",
    status: failingGates.some((gate) => gate.status === "fail") || blockedRows.length
      ? "blocked"
      : operatorRows.length || deferredRows.length
        ? "review_required"
        : "ready",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    safe_jailbreak_policy: {
      meaning: "Use only permitted alternate routes: internal APIs, persisted replay, licensed provider contracts, license-reviewed historical data and operator notes with source metadata.",
      allowed_paths: [
        "internal_fastapi_endpoint",
        "persisted_postgres_replay",
        "licensed_provider_api",
        "provider_websocket_after_cursor_health",
        "license_reviewed_historical_file",
        "manual_operator_note_with_source_manifest",
      ],
      forbidden_paths: [
        "sportsbook_ui_automation",
        "browser_sportsbook_scrape",
        "anti_bot_bypass",
        "geolocation_bypass",
        "credential_or_session_extraction",
        "paywall_or_terms_bypass",
        "llm_per_odds_tick",
        "provider_quota_spend_without_operator",
        "real_money_execution",
      ],
    },
    summary: {
      total_sources: sourceRows.length,
      allowed: allowedRows.length,
      operator_required: operatorRows.length,
      deferred: deferredRows.length,
      forbidden: blockedRows.length,
      missing_required_ids: missingRequiredIds,
      budget_chain_completed: Boolean(report.budget_chain_snapshot?.budget_chain_completed),
      enterprise_eligible: Boolean(report.budget_chain_snapshot?.enterprise_eligible),
      cursor_resync_required: Number(report.cursor_summary?.resync_required ?? 0),
    },
    manifest: sourceRows,
    gates,
    next_action: sourceUseManifestNextAction({ failingGates, operatorRows, deferredRows, allowedRows }),
    acceptance_criteria: [
      "every_collection_route_has_source_use_manifest_row",
      "historical_sources_require_license_review_before_import",
      "enterprise_sources_remain_deferred_until_enterprise_eligible",
      "odds_websocket_requires_resync_required=false_before_use",
      "sportsbook_browser_scraping_and_bypass_are_forbidden",
      "provider_api_call_allowed=false",
      "can_submit_real_orders=false",
    ],
    validation_commands: [
      "npm --silent run hermes:source-use-manifest",
      "npm --silent run hermes:source-route-matrix",
      "npm --silent run hermes:historical-backfill-plan",
      "npm --silent run hermes:enterprise-readiness",
      "python3 scripts/check_private_runtime.py",
    ],
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block === true,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      anti_bot_bypass_allowed: false,
      geolocation_bypass_allowed: false,
      credential_or_session_extraction_allowed: false,
      paywall_or_terms_bypass_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function sourceUseManifestRouteRow({ route, sourcePlan }) {
  const protectedRoute = ["odds_live_websocket", "score_state_budget", "odds_archive_budget_smoke"].includes(route.id);
  const operatorRequired = Boolean(route.operator_required || protectedRoute);
  const decision = sourceUseDecision({
    routeStatus: route.status,
    operatorRequired,
    deferred: false,
    forbidden: route.status === "blocked",
  });
  return {
    id: `route:${route.id}`,
    source_id: route.id,
    source_type: "collection_route",
    priority: route.priority,
    decision,
    status: route.status,
    lane: route.lane,
    primary_path: route.primary_path,
    command: route.command,
    cost_tier: route.cost_tier,
    operator_required: operatorRequired,
    provider: route.provider,
    license_review_required: ["historical_public_backfill", "public_context_operator_note"].includes(route.id),
    attribution_required: ["historical_public_backfill", "public_context_operator_note", "manual_operator_note"].includes(route.id),
    quota_spend_allowed: false,
    import_allowed_now: route.id === "replay_backfill" || route.id === "live_statistics",
    required_evidence: route.success_evidence ?? [],
    blocked_when: route.blocked_when ?? [],
    forbidden_actions: sourceUseForbiddenActions(sourcePlan),
    reason: route.reason,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function sourceUseManifestHistoricalRow(source) {
  const licenseBlocked = Boolean(source.license_review_required || source.commercial_clearance_required);
  return {
    id: `historical:${source.id}`,
    source_id: source.id,
    source_type: "historical_backfill_source",
    priority: 200 + Number(source.priority ?? 0),
    decision: sourceUseDecision({
      routeStatus: source.status,
      operatorRequired: licenseBlocked,
      deferred: false,
      forbidden: false,
    }),
    status: source.status,
    provider: source.provider,
    dataset: source.dataset,
    coverage: source.coverage ?? [],
    use_cases: source.use_cases ?? [],
    source_url: source.source_url,
    command: source.command,
    cost_tier: source.cost_tier,
    license: source.license,
    license_review_required: Boolean(source.license_review_required),
    commercial_clearance_required: Boolean(source.commercial_clearance_required),
    attribution_required: Boolean(source.attribution_required),
    quota_spend_allowed: false,
    import_allowed_now: !licenseBlocked && source.status === "ready",
    required_evidence: [
      "source_url_or_local_path",
      "license_terms_reviewed",
      "attribution_recorded",
      "source_timestamp",
      "offline_import_fixture",
      "no_live_scraping",
    ],
    blocked_when: source.blockers ?? [],
    forbidden_actions: [
      "live_scoreboard_scraping",
      "terms_restricted_scraping",
      "paywall_bypass",
      "credential_or_session_extraction",
    ],
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function sourceUseManifestEnterpriseRow(provider, readiness) {
  const enterpriseEligible = Boolean(readiness.budget_gate?.enterprise_eligible);
  return {
    id: `enterprise:${provider.provider}`,
    source_id: provider.provider,
    source_type: "enterprise_shadow_contract",
    priority: 500,
    decision: enterpriseEligible ? "operator_required" : "deferred",
    status: provider.status,
    provider: provider.provider,
    adapter_contract: provider.adapter_contract,
    fake_api: provider.fake_api,
    scenarios: provider.scenarios ?? [],
    output_contracts: provider.output_contracts ?? [],
    command: "npm --silent run hermes:enterprise-readiness",
    cost_tier: "enterprise_contract_deferred",
    license_review_required: true,
    commercial_clearance_required: true,
    attribution_required: false,
    quota_spend_allowed: false,
    import_allowed_now: false,
    required_evidence: [
      "operator_contract_review",
      "sample_payload_terms",
      "timestamp_semantics",
      "latency_sla",
      "redistribution_restrictions",
      "offline_replay_fixture",
    ],
    blocked_when: enterpriseEligible ? ["operator_contract_not_reviewed"] : ["enterprise_eligible=false"],
    forbidden_actions: [
      "provider_api_call_from_manifest",
      "credential_or_session_extraction",
      "provider_quota_spend_without_operator_contract",
      "real_money_execution",
    ],
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function sourceUseDecision({ routeStatus, operatorRequired, deferred, forbidden }) {
  if (forbidden || routeStatus === "blocked") return "forbidden";
  if (deferred || routeStatus === "deferred" || String(routeStatus).startsWith("locked")) return "deferred";
  if (operatorRequired || ["operator_ready", "operator_review", "operator_note_only"].includes(routeStatus)) {
    return "operator_required";
  }
  return "allowed";
}

function sourceUseForbiddenActions(sourcePlan) {
  return [
    ...(sourcePlan.forbidden_actions ?? []),
    "sportsbook_ui_automation",
    "browser_sportsbook_scrape",
    "anti_bot_bypass",
    "geolocation_bypass",
    "credential_or_session_extraction",
    "paywall_or_terms_bypass",
    "provider_quota_spend_without_operator",
  ];
}

function sourceUseManifestGates({ report, eventPlan, sourcePlan, sourceRows, missingRequiredIds }) {
  const cursorBlocked = eventPlan.events.some((event) => event.type === "cursor_resync_required");
  const protectedClaims = sourceRows.filter((row) => (
    row.provider_api_call_allowed === true
      || row.can_submit_real_orders === true
      || row.live_api_calls === true
  ));
  return [
    sourceUseGate({
      id: "manifest_coverage",
      status: missingRequiredIds.length ? "fail" : "pass",
      evidence: [`missing_required_ids=${missingRequiredIds.join(",") || "none"}`],
      command: "npm --silent run hermes:source-use-manifest",
    }),
    sourceUseGate({
      id: "safe_jailbreak_policy",
      status: sourcePlan.safe_jailbreak_policy?.bypass_allowed === false ? "pass" : "fail",
      evidence: [
        `bypass_allowed=${sourcePlan.safe_jailbreak_policy?.bypass_allowed}`,
        "sportsbook_browser_automation_allowed=false",
      ],
      command: "npm --silent run hermes:source-discovery",
    }),
    sourceUseGate({
      id: "no_protected_execution",
      status: protectedClaims.length ? "fail" : "pass",
      evidence: [`protected_claim_count=${protectedClaims.length}`],
      command: "python3 scripts/check_private_runtime.py",
    }),
    sourceUseGate({
      id: "real_execution_hard_block",
      status: report.safety?.real_execution_hard_block === true ? "pass" : "fail",
      evidence: [`real_execution_hard_block=${report.safety?.real_execution_hard_block}`],
      command: "npm --silent run hermes:preflight",
    }),
    sourceUseGate({
      id: "cursor_resync_blocks_live_odds",
      status: cursorBlocked
        ? sourceRows.some((row) => row.id === "route:odds_live_websocket" && row.decision === "forbidden")
          ? "pass"
          : "fail"
        : "pass",
      evidence: [`cursor_resync_required=${cursorBlocked}`],
      command: "npm --silent run hermes:events",
    }),
    sourceUseGate({
      id: "license_review_visible",
      status: sourceRows.some((row) => row.license_review_required) ? "pass" : "warn",
      evidence: [`license_review_rows=${sourceRows.filter((row) => row.license_review_required).length}`],
      command: "npm --silent run hermes:historical-backfill-plan",
    }),
  ];
}

function sourceUseGate({ id, status, evidence, command }) {
  return {
    id,
    status,
    evidence,
    command,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
  };
}

function sourceUseManifestNextAction({ failingGates, operatorRows, deferredRows, allowedRows }) {
  const hardGate = failingGates.find((gate) => gate.status === "fail");
  if (hardGate) {
    return {
      id: `resolve_${hardGate.id}`,
      command: hardGate.command,
      reason: `Source-use manifest is blocked by ${hardGate.id}.`,
      executes_now: false,
      provider_api_call_allowed: false,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
    };
  }
  const replay = allowedRows.find((row) => row.id === "route:replay_backfill");
  if (replay) {
    return {
      id: "implement_allowed_replay_or_internal_route",
      command: "npm --silent run hermes:replay-backfill-contract",
      reason: "Free local replay/internal source routes are allowed and should be hardened before provider spend.",
      executes_now: false,
      provider_api_call_allowed: false,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
    };
  }
  const operatorRow = operatorRows[0];
  if (operatorRow) {
    return {
      id: `operator_review_${operatorRow.source_id}`,
      command: operatorRow.command,
      reason: `${operatorRow.source_id} requires operator review before collection/import.`,
      executes_now: false,
      provider_api_call_allowed: false,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
    };
  }
  const deferredRow = deferredRows[0];
  if (deferredRow) {
    return {
      id: `keep_deferred_${deferredRow.source_id}`,
      command: deferredRow.command,
      reason: `${deferredRow.source_id} remains deferred until gates pass.`,
      executes_now: false,
      provider_api_call_allowed: false,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
    };
  }
  return {
    id: "monitor_source_manifest",
    command: "npm --silent run hermes:source-use-manifest",
    reason: "All source-use rows are allowed or safely accounted for.",
    executes_now: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
  };
}

function buildSourceUseLedger(manifest) {
  const path = sourceUseLedgerPath();
  const rows = manifest.manifest ?? [];
  const record = {
    generated_at: new Date().toISOString(),
    mode: "source_use_ledger_record",
    outcome: "observed",
    action_executed: false,
    manifest_command_executed: false,
    provider_command_executed: false,
    bypass_attempted: false,
    status: manifest.status,
    next_action_id: manifest.next_action?.id ?? null,
    next_action_command: manifest.next_action?.command ?? null,
    decision_counts: countValues(rows.map((row) => row.decision).filter(Boolean)),
    allowed_source_ids: rows.filter((row) => row.decision === "allowed").map((row) => row.id),
    operator_required_source_ids: rows.filter((row) => row.decision === "operator_required").map((row) => row.id),
    deferred_source_ids: rows.filter((row) => row.decision === "deferred").map((row) => row.id),
    forbidden_source_ids: rows.filter((row) => row.decision === "forbidden").map((row) => row.id),
    license_review_source_ids: rows.filter((row) => row.license_review_required).map((row) => row.id),
    quota_spend_allowed_source_ids: rows.filter((row) => row.quota_spend_allowed === true).map((row) => row.id),
    safe_jailbreak_bypass_allowed: false,
    manifest,
    safety: manifest.safety,
  };
  return {
    generated_at: new Date().toISOString(),
    mode: "source_use_ledger",
    status: manifest.status,
    read_only: false,
    writes: true,
    write_scope: "local_source_use_jsonl_only",
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    executed_commands: [],
    ledger: {
      path,
      format: "jsonl",
      retention_note: "Local Hermes source-use trace; do not commit runtime logs.",
    },
    record,
    safety: {
      real_execution_hard_block: manifest.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function sourceUseLedgerPath() {
  return process.env.HERMES_SOURCE_USE_LEDGER_PATH || "hermes/runs/source-use-ledger.jsonl";
}

function writeSourceUseLedger(record) {
  const path = sourceUseLedgerPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

function readSourceUseLedgerRecords() {
  const path = sourceUseLedgerPath();
  if (!existsSync(path)) {
    return { path, records: [], invalid_rows: 0 };
  }
  const content = readFileSync(path, "utf8");
  let invalidRows = 0;
  const records = content
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        invalidRows += 1;
        return [];
      }
    });
  return { path, records, invalid_rows: invalidRows };
}

function buildSourceUseLedgerReport({ path, records, invalid_rows: invalidRows }) {
  const nextActionCounts = rankedCounts(records.map((record) => record.next_action_id).filter(Boolean));
  const nextCommandCounts = rankedCounts(records.map((record) => record.next_action_command).filter(Boolean));
  const operatorRequiredCounts = rankedCounts(records.flatMap((record) => record.operator_required_source_ids ?? []));
  const deferredCounts = rankedCounts(records.flatMap((record) => record.deferred_source_ids ?? []));
  const forbiddenCounts = rankedCounts(records.flatMap((record) => record.forbidden_source_ids ?? []));
  const licenseReviewCounts = rankedCounts(records.flatMap((record) => record.license_review_source_ids ?? []));
  return {
    generated_at: new Date().toISOString(),
    mode: "source_use_ledger_report",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    ledger: {
      path,
      format: "jsonl",
      invalid_rows: invalidRows,
    },
    total_records: records.length,
    action_executed_count: records.filter((record) => record.action_executed === true).length,
    manifest_command_executed_count: records.filter((record) => record.manifest_command_executed === true).length,
    provider_command_executed_count: records.filter((record) => record.provider_command_executed === true).length,
    bypass_attempted_count: records.filter((record) => record.bypass_attempted === true || record.safe_jailbreak_bypass_allowed === true).length,
    status_counts: countValues(records.map((record) => record.status).filter(Boolean)),
    decision_counts: sumObjectCounts(records.map((record) => record.decision_counts ?? {})),
    next_action_counts: nextActionCounts,
    next_action_command_counts: nextCommandCounts,
    operator_required_source_counts: operatorRequiredCounts,
    deferred_source_counts: deferredCounts,
    forbidden_source_counts: forbiddenCounts,
    license_review_source_counts: licenseReviewCounts,
    quota_spend_allowed_count: records.flatMap((record) => record.quota_spend_allowed_source_ids ?? []).length,
    top_next_action: nextActionCounts[0]?.command ?? null,
    top_operator_required_source: operatorRequiredCounts[0]?.command ?? null,
    top_deferred_source: deferredCounts[0]?.command ?? null,
    top_forbidden_source: forbiddenCounts[0]?.command ?? null,
    latest_record: records[records.length - 1] ?? null,
    next_recommendation: sourceUseLedgerRecommendation({
      records,
      nextActionCounts,
      operatorRequiredCounts,
      deferredCounts,
      forbiddenCounts,
    }),
    safety: {
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function sourceUseLedgerRecommendation({
  records,
  nextActionCounts,
  operatorRequiredCounts,
  deferredCounts,
  forbiddenCounts,
}) {
  if (!records.length) {
    return sourceUseLedgerAction({
      id: "collect_source_use_evidence",
      command: "npm --silent run hermes:source-use-ledger",
      reason: "No source-use evidence exists yet; collect a local JSONL row before changing collection or import code.",
    });
  }
  if (forbiddenCounts[0]) {
    return sourceUseLedgerAction({
      id: `review_forbidden_${forbiddenCounts[0].command}`,
      command: "npm --silent run hermes:source-use-manifest",
      reason: `Source-use ledger repeatedly marks ${forbiddenCounts[0].command} as forbidden; keep implementation blocked until the route is removed or justified by allowed access.`,
    });
  }
  if (operatorRequiredCounts[0]) {
    return sourceUseLedgerAction({
      id: `review_operator_required_${operatorRequiredCounts[0].command}`,
      command: "npm --silent run hermes:source-use-manifest",
      reason: `${operatorRequiredCounts[0].command} repeatedly requires operator/license/quota review before import or provider spend.`,
    });
  }
  if (deferredCounts[0]) {
    return sourceUseLedgerAction({
      id: `keep_deferred_${deferredCounts[0].command}`,
      command: "npm --silent run hermes:enterprise-readiness",
      reason: `${deferredCounts[0].command} remains deferred until budget-chain and enterprise gates pass.`,
    });
  }
  return sourceUseLedgerAction({
    id: nextActionCounts[0] ? `review_${nextActionCounts[0].command}` : "review_source_use_manifest",
    command: "npm --silent run hermes:source-use-manifest",
    reason: "Review source-use evidence before adding collection/import code or spending provider quota.",
  });
}

function sourceUseLedgerAction({ id, command, reason }) {
  return {
    id,
    command,
    reason,
    executes_now: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
  };
}

function buildSourceIntakePlan({
  report,
  eventPlan,
  sourcePlan,
  historicalBackfill,
  enterpriseReadiness,
  manifest,
  sourceUseReport,
}) {
  const rows = manifest.manifest ?? [];
  const allowedContracts = rows
    .filter((row) => row.decision === "allowed" && row.import_allowed_now === true)
    .map((row) => sourceIntakeItem({ row, lane: "allowed_contract" }));
  const operatorReviewQueue = rows
    .filter((row) => row.decision === "operator_required")
    .map((row) => sourceIntakeItem({ row, lane: "operator_review" }));
  const deferredQueue = rows
    .filter((row) => row.decision === "deferred")
    .map((row) => sourceIntakeItem({ row, lane: "deferred" }));
  const forbiddenQuarantine = rows
    .filter((row) => row.decision === "forbidden")
    .map((row) => sourceIntakeItem({ row, lane: "forbidden_quarantine" }));
  const nextIntake = allowedContracts[0] ?? operatorReviewQueue[0] ?? deferredQueue[0] ?? forbiddenQuarantine[0] ?? null;
  return {
    generated_at: new Date().toISOString(),
    mode: "source_intake_plan",
    objective: "turn_source_use_manifest_into_safe_offline_import_contracts_without_fetching_data",
    status: nextIntake ? "ready" : "collecting",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    next_intake: nextIntake,
    intake_queues: {
      allowed_contracts: allowedContracts,
      operator_review: operatorReviewQueue,
      deferred: deferredQueue,
      forbidden_quarantine: forbiddenQuarantine,
    },
    queue_summary: {
      allowed_contracts: allowedContracts.length,
      operator_review: operatorReviewQueue.length,
      deferred: deferredQueue.length,
      forbidden_quarantine: forbiddenQuarantine.length,
      license_review_required: operatorReviewQueue.filter((item) => item.license_review_required).length,
      source_use_ledger_records: sourceUseReport.total_records,
      top_operator_required_source: sourceUseReport.top_operator_required_source,
      top_deferred_source: sourceUseReport.top_deferred_source,
      top_forbidden_source: sourceUseReport.top_forbidden_source,
    },
    manifest_status: {
      status: manifest.status,
      missing_required_ids: manifest.summary?.missing_required_ids ?? [],
      budget_chain_completed: Boolean(manifest.summary?.budget_chain_completed),
      enterprise_eligible: Boolean(manifest.summary?.enterprise_eligible),
      cursor_resync_required: Number(manifest.summary?.cursor_resync_required ?? 0),
    },
    source_context: {
      source_mode: sourcePlan.source_mode,
      historical_next_source: historicalBackfill.next_source?.id ?? null,
      historical_license_review_required: historicalBackfill.review_summary?.license_review_required ?? 0,
      enterprise_readiness_status: enterpriseReadiness.status,
      active_events: eventPlan.events.map((event) => event.type),
    },
    recommended_action: sourceIntakeRecommendedAction({ nextIntake, sourceUseReport, manifest }),
    intake_contract: sourceIntakeContract(nextIntake),
    validation_commands: [
      "npm --silent run hermes:source-intake-plan",
      "npm --silent run hermes:source-use-manifest",
      "npm --silent run hermes:source-use-ledger-report",
      "npm --silent run hermes:historical-backfill-plan",
      "python3 scripts/check_private_runtime.py",
    ],
    acceptance_criteria: [
      "source_intake_plan.mode=source_intake_plan",
      "allowed_contracts_before_operator_review_before_deferred_before_forbidden",
      "dataset_fetch_allowed=false",
      "provider_api_call_allowed=false",
      "can_submit_real_orders=false",
      "sportsbook_browser_automation_allowed=false",
      "license_review_required_sources_are_operator_gated",
    ],
    safe_jailbreak_policy: {
      meaning: "Hermes may route around missing coverage only by selecting allowed contracts, internal replay, operator-reviewed licenses, deferred enterprise contracts and forbidden-route quarantine.",
      allowed_paths: [
        "persisted_postgres_replay",
        "internal_fastapi_read_model",
        "license_reviewed_historical_file",
        "operator_reviewed_provider_contract",
        "manual_operator_note_with_source_manifest",
      ],
      forbidden_paths: manifest.safe_jailbreak_policy?.forbidden_paths ?? [],
      bypass_allowed: false,
      dataset_fetch_allowed: false,
      provider_quota_spend_allowed: false,
      browser_sportsbook_automation_allowed: false,
      credential_or_session_extraction_allowed: false,
      llm_per_tick_allowed: false,
    },
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block === true,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      anti_bot_bypass_allowed: false,
      geolocation_bypass_allowed: false,
      credential_or_session_extraction_allowed: false,
      paywall_or_terms_bypass_allowed: false,
      dataset_fetch_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function sourceIntakeItem({ row, lane }) {
  return {
    id: row.id,
    source_id: row.source_id,
    source_type: row.source_type,
    lane,
    decision: row.decision,
    status: row.status,
    priority: row.priority,
    provider: row.provider ?? null,
    dataset: row.dataset ?? null,
    command: sourceIntakeCommand(row),
    cost_tier: row.cost_tier ?? null,
    license_review_required: Boolean(row.license_review_required),
    commercial_clearance_required: Boolean(row.commercial_clearance_required),
    attribution_required: Boolean(row.attribution_required),
    import_allowed_now: row.decision === "allowed" && row.import_allowed_now === true,
    required_evidence: row.required_evidence ?? [],
    blocked_when: row.blocked_when ?? [],
    forbidden_actions: row.forbidden_actions ?? [],
    source_url: row.source_url ?? null,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    dataset_fetch_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function sourceIntakeCommand(row) {
  if (row.id === "route:replay_backfill") return "npm --silent run hermes:replay-backfill-contract";
  if (row.id === "route:live_statistics") return "npm --silent run hermes:live-stats";
  if (row.source_type === "enterprise_shadow_contract") return "npm --silent run hermes:enterprise-readiness";
  if (row.source_type === "historical_backfill_source") return "npm --silent run hermes:historical-backfill-plan";
  return row.command ?? "npm --silent run hermes:source-use-manifest";
}

function sourceIntakeRecommendedAction({ nextIntake, sourceUseReport, manifest }) {
  if (!nextIntake) {
    return sourceIntakeAction({
      id: "collect_source_intake_evidence",
      command: "npm --silent run hermes:source-use-manifest",
      reason: "No source-use manifest rows are available; collect read-only source-use evidence before import work.",
    });
  }
  if (!sourceUseReport.total_records && manifest.status !== "ready") {
    return sourceIntakeAction({
      id: "persist_source_use_decisions",
      command: "npm --silent run hermes:source-use-ledger",
      reason: "Source-use manifest has review blockers; persist local ledger evidence before implementing importers.",
    });
  }
  if (nextIntake.lane === "allowed_contract") {
    return sourceIntakeAction({
      id: `prepare_${nextIntake.source_id}_contract`,
      command: nextIntake.command,
      reason: `${nextIntake.id} is allowed for offline/internal intake and can become an implementation contract without provider spend.`,
    });
  }
  if (nextIntake.lane === "operator_review") {
    return sourceIntakeAction({
      id: `operator_review_${nextIntake.source_id}`,
      command: "npm --silent run hermes:source-use-ledger-report",
      reason: `${nextIntake.id} requires license, attribution, quota or operator review before any fetch/import.`,
    });
  }
  if (nextIntake.lane === "deferred") {
    return sourceIntakeAction({
      id: `defer_${nextIntake.source_id}`,
      command: "npm --silent run hermes:enterprise-readiness",
      reason: `${nextIntake.id} remains deferred behind budget-chain and enterprise gates.`,
    });
  }
  return sourceIntakeAction({
    id: `quarantine_${nextIntake.source_id}`,
    command: "npm --silent run hermes:source-use-manifest",
    reason: `${nextIntake.id} is forbidden or blocked; keep it quarantined and do not implement collection.`,
  });
}

function sourceIntakeAction({ id, command, reason }) {
  return {
    id,
    command,
    reason,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    dataset_fetch_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function sourceIntakeContract(nextIntake) {
  if (!nextIntake) return null;
  if (nextIntake.lane !== "allowed_contract") {
    return {
      id: `${nextIntake.source_id}_operator_gate`,
      status: nextIntake.lane,
      reason: "Not an allowed contract yet; operator/license/deferred/quarantine gates must close first.",
      provider_api_call_allowed: false,
      dataset_fetch_allowed: false,
      can_submit_real_orders: false,
    };
  }
  return {
    id: `${nextIntake.source_id}_intake_contract`,
    status: "ready",
    source_id: nextIntake.source_id,
    input_contracts: nextIntake.source_id === "replay_backfill"
      ? ["OperationalStateSnapshot", "ReplayLabSnapshot", "PersistedTicks"]
      : ["InternalFastApiReadModel", "ProviderHealthSnapshot", "DataQualitySnapshot"],
    output_contracts: nextIntake.source_id === "replay_backfill"
      ? ["ReplayBackfillEvidence", "ClosingLineProxySeed", "FeatureBackfillSeed"]
      : ["LiveStatsSnapshot", "FreshnessSignal", "CollectionThrottleEvidence"],
    validation_command: nextIntake.command,
    provider_api_call_allowed: false,
    dataset_fetch_allowed: false,
    can_submit_real_orders: false,
  };
}

function buildSourceIntakeLedger(plan) {
  const path = sourceIntakeLedgerPath();
  const record = {
    generated_at: new Date().toISOString(),
    mode: "source_intake_ledger_record",
    outcome: "observed",
    action_executed: false,
    intake_command_executed: false,
    dataset_fetch_attempted: false,
    provider_command_executed: false,
    bypass_attempted: false,
    status: plan.status,
    next_intake_id: plan.next_intake?.id ?? null,
    next_intake_lane: plan.next_intake?.lane ?? null,
    next_intake_command: plan.next_intake?.command ?? null,
    recommended_action_id: plan.recommended_action?.id ?? null,
    recommended_action_command: plan.recommended_action?.command ?? null,
    allowed_contract_ids: (plan.intake_queues?.allowed_contracts ?? []).map((item) => item.id),
    operator_review_ids: (plan.intake_queues?.operator_review ?? []).map((item) => item.id),
    deferred_ids: (plan.intake_queues?.deferred ?? []).map((item) => item.id),
    forbidden_quarantine_ids: (plan.intake_queues?.forbidden_quarantine ?? []).map((item) => item.id),
    queue_summary: plan.queue_summary,
    manifest_status: plan.manifest_status,
    source_context: plan.source_context,
    source_intake_plan: plan,
    safety: plan.safety,
  };
  return {
    generated_at: new Date().toISOString(),
    mode: "source_intake_ledger",
    status: plan.status,
    read_only: false,
    writes: true,
    write_scope: "local_source_intake_jsonl_only",
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    executed_commands: [],
    ledger: {
      path,
      format: "jsonl",
      retention_note: "Local Hermes source-intake trace; do not commit runtime logs.",
    },
    record,
    safety: {
      real_execution_hard_block: plan.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      dataset_fetch_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function sourceIntakeLedgerPath() {
  return process.env.HERMES_SOURCE_INTAKE_LEDGER_PATH || "hermes/runs/source-intake-ledger.jsonl";
}

function writeSourceIntakeLedger(record) {
  const path = sourceIntakeLedgerPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

function readSourceIntakeLedgerRecords() {
  const path = sourceIntakeLedgerPath();
  if (!existsSync(path)) {
    return { path, records: [], invalid_rows: 0 };
  }
  const content = readFileSync(path, "utf8");
  let invalidRows = 0;
  const records = content
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        invalidRows += 1;
        return [];
      }
    });
  return { path, records, invalid_rows: invalidRows };
}

function buildSourceIntakeLedgerReport({ path, records, invalid_rows: invalidRows }) {
  const nextIntakeCounts = rankedCounts(records.map((record) => record.next_intake_id).filter(Boolean));
  const nextIntakeLaneCounts = rankedCounts(records.map((record) => record.next_intake_lane).filter(Boolean));
  const nextIntakeCommandCounts = rankedCounts(records.map((record) => record.next_intake_command).filter(Boolean));
  const recommendedActionCounts = rankedCounts(records.map((record) => record.recommended_action_id).filter(Boolean));
  const allowedContractCounts = rankedCounts(records.flatMap((record) => record.allowed_contract_ids ?? []));
  const operatorReviewCounts = rankedCounts(records.flatMap((record) => record.operator_review_ids ?? []));
  const deferredCounts = rankedCounts(records.flatMap((record) => record.deferred_ids ?? []));
  const forbiddenCounts = rankedCounts(records.flatMap((record) => record.forbidden_quarantine_ids ?? []));
  return {
    generated_at: new Date().toISOString(),
    mode: "source_intake_ledger_report",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    ledger: {
      path,
      format: "jsonl",
      invalid_rows: invalidRows,
    },
    total_records: records.length,
    action_executed_count: records.filter((record) => record.action_executed === true).length,
    intake_command_executed_count: records.filter((record) => record.intake_command_executed === true).length,
    dataset_fetch_attempted_count: records.filter((record) => record.dataset_fetch_attempted === true).length,
    provider_command_executed_count: records.filter((record) => record.provider_command_executed === true).length,
    bypass_attempted_count: records.filter((record) => record.bypass_attempted === true).length,
    status_counts: countValues(records.map((record) => record.status).filter(Boolean)),
    next_intake_counts: nextIntakeCounts,
    next_intake_lane_counts: nextIntakeLaneCounts,
    next_intake_command_counts: nextIntakeCommandCounts,
    recommended_action_counts: recommendedActionCounts,
    allowed_contract_counts: allowedContractCounts,
    operator_review_counts: operatorReviewCounts,
    deferred_counts: deferredCounts,
    forbidden_quarantine_counts: forbiddenCounts,
    top_next_intake: nextIntakeCounts[0]?.command ?? null,
    top_next_intake_lane: nextIntakeLaneCounts[0]?.command ?? null,
    top_next_intake_command: nextIntakeCommandCounts[0]?.command ?? null,
    top_allowed_contract: allowedContractCounts[0]?.command ?? null,
    top_operator_review: operatorReviewCounts[0]?.command ?? null,
    top_deferred: deferredCounts[0]?.command ?? null,
    top_forbidden_quarantine: forbiddenCounts[0]?.command ?? null,
    latest_record: records[records.length - 1] ?? null,
    next_recommendation: sourceIntakeLedgerRecommendation({
      records,
      nextIntakeCounts,
      operatorReviewCounts,
      deferredCounts,
      forbiddenCounts,
    }),
    safety: {
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      dataset_fetch_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function sourceIntakeLedgerRecommendation({
  records,
  nextIntakeCounts,
  operatorReviewCounts,
  deferredCounts,
  forbiddenCounts,
}) {
  if (!records.length) {
    return sourceIntakeAction({
      id: "collect_source_intake_evidence",
      command: "npm --silent run hermes:source-intake-ledger",
      reason: "No source-intake evidence exists yet; collect a local JSONL row before implementing an intake contract.",
    });
  }
  if (forbiddenCounts[0]) {
    return sourceIntakeAction({
      id: `quarantine_${forbiddenCounts[0].command}`,
      command: "npm --silent run hermes:source-intake-plan",
      reason: `${forbiddenCounts[0].command} repeatedly lands in forbidden quarantine; keep it blocked before implementation.`,
    });
  }
  if (operatorReviewCounts[0]) {
    return sourceIntakeAction({
      id: `operator_review_${operatorReviewCounts[0].command}`,
      command: "npm --silent run hermes:source-use-ledger-report",
      reason: `${operatorReviewCounts[0].command} repeatedly requires operator/license review before any fetch or import.`,
    });
  }
  if (deferredCounts[0]) {
    return sourceIntakeAction({
      id: `defer_${deferredCounts[0].command}`,
      command: "npm --silent run hermes:enterprise-readiness",
      reason: `${deferredCounts[0].command} repeatedly remains deferred behind enterprise gates.`,
    });
  }
  return sourceIntakeAction({
    id: nextIntakeCounts[0] ? `prepare_${nextIntakeCounts[0].command}` : "review_source_intake_plan",
    command: "npm --silent run hermes:source-intake-plan",
    reason: "Review repeated intake decisions before implementing the next offline/internal source contract.",
  });
}

function sumObjectCounts(items) {
  const totals = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item ?? {})) {
      totals[key] = (totals[key] ?? 0) + Number(value ?? 0);
    }
  }
  return totals;
}

function buildTriggerPolicy({ loop, sourcePlan, grandSlam = null }) {
  const triggers = buildWakeTriggers({ loop, sourcePlan, grandSlam });
  return {
    generated_at: new Date().toISOString(),
    mode: "trigger_policy",
    status: loop.status,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    wakeup_channels: ["cron", "telegram", "dashboard", "cloudflare_agent", "openclaw_gateway"],
    debounce_policy: {
      min_seconds_between_same_trigger: 300,
      coalesce_by: ["trigger_id", "command"],
      llm_per_tick_allowed: false,
      provider_api_call_allowed: false,
      reason: "Wake on summarized state changes; deterministic Python/Postgres handles tick math.",
    },
    next_wakeup: triggers[0] ?? null,
    triggers,
    source_discovery: {
      status: sourcePlan.status,
      next_safe_command: sourcePlan.next_safe_command,
      safe_jailbreak_policy: sourcePlan.safe_jailbreak_policy,
    },
    grand_slam_readiness: grandSlam ? {
      status: grandSlam.status,
      prediction_ready: grandSlam.prediction_ready,
      paper_ready: grandSlam.paper_ready,
      active_grand_slams: grandSlam.active_grand_slams,
      visible_matches: grandSlam.matches?.grand_slam_visible ?? 0,
      prediction_rows: grandSlam.matches?.prediction_rows ?? 0,
      next_action: grandSlam.next_action,
    } : null,
    forbidden_actions: loop.forbidden_actions ?? sourcePlan.forbidden_actions ?? [],
    safety: {
      real_execution_hard_block: loop.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      provider_api_call_allowed: false,
      can_create_paper_orders: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function buildOpsCompiler({
  loop,
  sourcePlan,
  triggerPlan,
  grandSlam,
  autonomyPlan,
  operator,
  effectiveness = null,
  enterpriseReadiness = null,
  enterpriseAccuracy = null,
  sourceUseManifest = null,
  scorelineForecast = null,
}) {
  const compiledAction = compileNextAction({ loop, triggerPlan, autonomyPlan, operator });
  return {
    generated_at: new Date().toISOString(),
    mode: "ops_compiler",
    status: loop.status,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    compiled_action: compiledAction,
    execution_graph: buildExecutionGraph({
      triggerPlan,
      sourcePlan,
      grandSlam,
      autonomyPlan,
      operator,
      effectiveness,
      enterpriseReadiness,
      enterpriseAccuracy,
      sourceUseManifest,
      scorelineForecast,
    }),
    model_router: buildOpsModelRouter({ loop, triggerPlan }),
    operator_packet: {
      priority: operator.priority,
      headline: operator.headline,
      short_message: operator.short_message,
      next_action: operator.next_action,
      read_only_route: operator.read_only_route,
      cost_guard: operator.cost_guard,
      runtime: operator.runtime,
    },
    source_discovery: {
      status: sourcePlan.status,
      discovery_scope: sourcePlan.discovery_scope,
      next_safe_command: sourcePlan.next_safe_command,
      provider_routes: sourcePlan.provider_routes,
    },
    trigger_policy: {
      next_wakeup: triggerPlan.next_wakeup,
      trigger_count: triggerPlan.triggers.length,
      debounce_policy: triggerPlan.debounce_policy,
    },
    grand_slam_readiness: grandSlam ? {
      status: grandSlam.status,
      prediction_ready: grandSlam.prediction_ready,
      paper_ready: grandSlam.paper_ready,
      active_grand_slams: grandSlam.active_grand_slams,
      visible_matches: grandSlam.matches?.grand_slam_visible ?? 0,
      prediction_rows: grandSlam.matches?.prediction_rows ?? 0,
      next_action: grandSlam.next_action,
    } : null,
    autonomy_brief: {
      recommended_lane: autonomyPlan.recommended_lane,
      autonomy_matrix: autonomyPlan.autonomy_matrix,
    },
    autonomy_effectiveness: autonomyEffectivenessSummary(effectiveness),
    enterprise_readiness: enterpriseReadinessSummary(enterpriseReadiness),
    enterprise_accuracy: enterpriseAccuracySummary(enterpriseAccuracy),
    source_use_manifest: sourceUseManifestSummary(sourceUseManifest),
    grand_slam_scoreline_forecast: scorelineForecast ? grandSlamScorelineForecastSummary(scorelineForecast) : null,
    safe_jailbreak_policy: sourcePlan.safe_jailbreak_policy,
    forbidden_actions: loop.forbidden_actions ?? sourcePlan.forbidden_actions ?? [],
    safety: {
      real_execution_hard_block: loop.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      provider_api_call_allowed: false,
      can_create_paper_orders: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function compileNextAction({ loop, triggerPlan, autonomyPlan, operator }) {
  const preferred = triggerPlan.next_wakeup?.command
    ? {
        id: triggerPlan.next_wakeup.id,
        command: triggerPlan.next_wakeup.command,
        reason: triggerPlan.next_wakeup.reason,
        source: "trigger_policy",
      }
    : {
        id: autonomyPlan.recommended_lane?.id ?? operator.next_action?.id ?? "observe",
        command: operator.next_action?.command ?? loop.next_best_command?.command ?? "npm --silent run hermes:intelligence",
        reason: autonomyPlan.recommended_lane?.reason ?? operator.next_action?.reason ?? "Observe current state.",
        source: "autonomy_brief",
      };
  return {
    id: preferred.id,
    command: preferred.command,
    reason: preferred.reason,
    source: preferred.source,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    requires_admin_token: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
  };
}

function buildExecutionGraph({
  triggerPlan,
  sourcePlan,
  grandSlam,
  autonomyPlan,
  operator,
  effectiveness = null,
  enterpriseReadiness = null,
  enterpriseAccuracy = null,
  sourceUseManifest = null,
  scorelineForecast = null,
}) {
  const nodes = [
    graphNode({
      id: "trigger_policy",
      command: "npm --silent run hermes:trigger-policy",
      reason: "Decide when Hermes should wake across channels.",
      status: triggerPlan.status,
    }),
    graphNode({
      id: "source_discovery",
      command: "npm --silent run hermes:source-discovery",
      reason: "Map safe acquisition paths before collection work.",
      status: sourcePlan.status,
    }),
    graphNode({
      id: "grand_slam_readiness",
      command: "npm --silent run hermes:grand-slam-readiness",
      reason: grandSlam
        ? `Grand Slam readiness is ${grandSlam.status}; prediction_ready=${Boolean(grandSlam.prediction_ready)}.`
        : "Evaluate Grand Slam prediction readiness when a Slam window or match rows are present.",
      status: grandSlam?.status ?? "unknown",
    }),
    graphNode({
      id: "autonomy_brief",
      command: "npm --silent run hermes:autonomy-brief",
      reason: `Current lane is ${autonomyPlan.recommended_lane?.id ?? "unknown"}.`,
      status: autonomyPlan.status,
    }),
    graphNode({
      id: "operator_packet",
      command: "npm --silent run hermes:operator-packet",
      reason: "Send compact channel-safe summary.",
      status: operator.status,
    }),
  ];
  if (effectiveness) {
    nodes.push(graphNode({
      id: "autonomy_effectiveness",
      command: "npm --silent run hermes:autonomy-effectiveness",
      reason: `Autonomy effectiveness is ${effectiveness.status}; score=${effectiveness.score}.`,
      status: effectiveness.status,
    }));
  }
  if (enterpriseReadiness) {
    nodes.push(graphNode({
      id: "enterprise_readiness",
      command: "npm --silent run hermes:enterprise-readiness",
      reason: `Enterprise readiness is ${enterpriseReadiness.status}; blockers=${enterpriseReadiness.activation_blockers?.length ?? 0}.`,
      status: enterpriseReadiness.status,
    }));
  }
  if (enterpriseAccuracy) {
    nodes.push(graphNode({
      id: "enterprise_accuracy_plan",
      command: "npm --silent run hermes:enterprise-accuracy-plan",
      reason: `Enterprise accuracy plan is ${enterpriseAccuracy.status}; providers=${enterpriseAccuracy.no_budget_provider_stack?.length ?? 0}.`,
      status: enterpriseAccuracy.status,
    }));
  }
  if (sourceUseManifest) {
    nodes.push(graphNode({
      id: "source_use_manifest",
      command: "npm --silent run hermes:source-use-manifest",
      reason: `Source-use manifest is ${sourceUseManifest.status}; operator_required=${sourceUseManifest.summary?.operator_required ?? 0}; deferred=${sourceUseManifest.summary?.deferred ?? 0}.`,
      status: sourceUseManifest.status,
    }));
  }
  if (scorelineForecast) {
    nodes.push(graphNode({
      id: "grand_slam_scoreline_forecast",
      command: "npm --silent run hermes:grand-slam-scoreline-forecast",
      reason: `Grand Slam scoreline forecast is ${scorelineForecast.status}; forecasts=${scorelineForecast.forecasts?.length ?? 0}.`,
      status: scorelineForecast.status,
    }));
  }
  return nodes;
}

function graphNode({ id, command, reason, status }) {
  return {
    id,
    command,
    reason,
    status,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
  };
}

function buildOpsModelRouter({ loop, triggerPlan }) {
  const severe = loop.status === "safety_stop"
    || loop.status === "runtime_degraded"
    || loop.status === "runtime_partial"
    || triggerPlan.triggers.some((trigger) => ["critical", "high"].includes(trigger.severity));
  return {
    routine_model: "gpt-5.4-mini",
    critical_model: "gpt-5.5",
    selected_model: severe ? "gpt-5.5" : "gpt-5.4-mini",
    reason: severe
      ? "Use critical model for high-severity runtime/provider/data-quality review; deterministic gates still decide actions."
      : "Use routine model for summaries and routing; no LLM per tick.",
    llm_per_tick_allowed: false,
  };
}

function buildCapabilityAudit({ loop, report, eventPlan, sourcePlan, autonomyPlan, opsPacket }) {
  const capabilities = buildCapabilityRows({ loop, report, eventPlan, sourcePlan, autonomyPlan, opsPacket });
  const nextSafeCommand = capabilityNextCommand({ loop, capabilities });
  return {
    generated_at: new Date().toISOString(),
    mode: "capability_audit",
    objective: "maximize_safe_hermes_autonomy",
    status: capabilityAuditStatus({ loop, capabilities }),
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    overall_score: Math.round(
      capabilities.reduce((total, capability) => total + capability.score, 0) / Math.max(1, capabilities.length)
    ),
    autonomy_ceiling: capabilityAutonomyCeiling({ loop, capabilities }),
    next_safe_command: nextSafeCommand,
    capabilities,
    safe_jailbreak_policy: sourcePlan.safe_jailbreak_policy,
    allowed_routes: sourcePlan.allowed_collection_paths ?? [],
    forbidden_actions: loop.forbidden_actions ?? sourcePlan.forbidden_actions ?? [],
    blocked_routes: [
      "real_money_execution",
      "sportsbook_ui_automation",
      "anti_bot_bypass",
      "geolocation_bypass",
      "credential_or_session_extraction",
      "paywall_or_tos_circumvention",
      "llm_per_tick_decisioning",
      "provider_quota_spend_without_operator",
    ],
    research_findings: [
      {
        id: "local_runtime_with_narrow_skills",
        conclusion: "OpenClaw/Hermes should run local scheduled skills, but every skill command must stay narrow and auditable.",
      },
      {
        id: "event_driven_not_tick_driven",
        conclusion: "Hermes should wake on summarized backend events instead of running LLM reasoning on every score or odds tick.",
      },
      {
        id: "backend_owned_risk",
        conclusion: "Provider calls, paper orders, model promotion and future execution remain deterministic backend decisions.",
      },
    ],
    safety: {
      real_execution_hard_block: loop.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      provider_api_call_allowed: false,
      can_create_paper_orders: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function buildAutonomyGates({ loop, report, eventPlan, sourcePlan, capabilityAuditPlan, activation }) {
  const gates = buildAutonomyGateRows({
    loop,
    report,
    eventPlan,
    sourcePlan,
    capabilityAuditPlan,
    activation,
  });
  const activeCeiling = highestPassedAutonomyGate(gates);
  return {
    generated_at: new Date().toISOString(),
    mode: "autonomy_gates",
    objective: "prove_safe_autonomy_ceiling_before_budget_or_enterprise_escalation",
    status: gates.some((gate) => gate.status === "blocked") ? "blocked" : "ready",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    active_ceiling: activeCeiling,
    next_required_gate: nextAutonomyGate({ gates, activeCeiling }),
    gates,
    capability_audit: {
      status: capabilityAuditPlan.status,
      autonomy_ceiling: capabilityAuditPlan.autonomy_ceiling,
      overall_score: capabilityAuditPlan.overall_score,
    },
    safe_jailbreak_policy: sourcePlan.safe_jailbreak_policy,
    blocked_routes: capabilityAuditPlan.blocked_routes,
    forbidden_actions: loop.forbidden_actions ?? sourcePlan.forbidden_actions ?? [],
    safety: {
      real_execution_hard_block: loop.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      provider_api_call_allowed: false,
      can_create_paper_orders: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function buildAutonomyGateRows({ loop, report, eventPlan, sourcePlan, activation }) {
  const activationFailures = (activation.checks ?? []).filter((check) => check.status !== "pass");
  const paperBlockers = [];
  if (!eventPlan.can_run_paper_autopilot) paperBlockers.push("event_router_not_paper_ready");
  if (!envConfigured(["ADMIN_API_TOKEN", "TENNIS_EDGE_ADMIN_API_TOKEN"])) paperBlockers.push("local_admin_secret_missing");
  if (loop.safety?.real_execution_hard_block !== true) paperBlockers.push("real_execution_hard_block_missing");
  const learningReady = loop.learning_review?.review_status === "ready";
  const enterpriseEligible = loop.budget_chain?.enterprise_eligible === true;
  const runtimeFindings = loop.runtime?.runtime_findings ?? {};
  return [
    autonomyGate({
      id: "observe",
      label: "Observe internal state safely",
      status: loop.safety?.real_execution_hard_block === true
        && sourcePlan.safe_jailbreak_policy?.bypass_allowed === false
        ? "pass"
        : "blocked",
      command: "npm --silent run hermes:safe-loop",
      reason: "Observation is allowed only while real execution and unsafe source bypasses remain blocked.",
      evidence: [
        `real_execution_hard_block=${loop.safety?.real_execution_hard_block}`,
        `bypass_allowed=${sourcePlan.safe_jailbreak_policy?.bypass_allowed}`,
      ],
      blockers: [
        ...(loop.safety?.real_execution_hard_block === true ? [] : ["real_execution_hard_block_missing"]),
        ...(sourcePlan.safe_jailbreak_policy?.bypass_allowed === false ? [] : ["unsafe_source_bypass_not_blocked"]),
      ],
    }),
    autonomyGate({
      id: "channel_ready",
      label: "Use local channels and runtime packets",
      status: loop.runtime?.status === "ready"
        && runtimeFindings.gateway_service_status === "running"
        && !["timed_out", "failed"].includes(runtimeFindings.doctor_status)
        ? "pass"
        : "blocked",
      command: channelReadyGateCommand(runtimeFindings),
      reason: "Telegram, dashboard, cron and local channel packets need a healthy local runtime first.",
      evidence: [
        `runtime.status=${loop.runtime?.status ?? "unknown"}`,
        `gateway_service_status=${runtimeFindings.gateway_service_status ?? "unknown"}`,
        `doctor_status=${runtimeFindings.doctor_status ?? "unknown"}`,
      ],
      blockers: runtimeFindings.blockers ?? [],
    }),
    autonomyGate({
      id: "cron_ready",
      label: "Manually activate read-only scheduled checks",
      status: activation.activation_allowed ? "pass" : "blocked",
      command: "npm run hermes:activation-checklist",
      reason: "Cron activation is allowed only when the proposal contains read-only, non-quota, non-order jobs.",
      evidence: [
        `activation_allowed=${activation.activation_allowed}`,
        `failed_checks=${activationFailures.map((check) => check.id).join(",") || "none"}`,
      ],
      blockers: activationFailures.map((check) => check.id),
    }),
    autonomyGate({
      id: "paper_ready",
      label: "Protected paper autopilot may be operator-triggered",
      status: paperBlockers.length ? "blocked" : "pass",
      command: "npm run hermes:autopilot",
      reason: "Paper orders still require the protected backend endpoint and admin token; this gate never creates them.",
      evidence: [
        `event_can_run_paper_autopilot=${eventPlan.can_run_paper_autopilot}`,
        `entry_signals=${report.signal_snapshot?.entry_signals ?? 0}`,
        `admin_token_configured=${envConfigured(["ADMIN_API_TOKEN", "TENNIS_EDGE_ADMIN_API_TOKEN"])}`,
      ],
      blockers: paperBlockers,
      requiresAdminToken: true,
    }),
    autonomyGate({
      id: "learning_ready",
      label: "Run learning/readiness review",
      status: learningReady ? "pass" : "blocked",
      command: "npm --silent run hermes:learning-review",
      reason: "Learning review needs enough settled paper evidence before model or staking review.",
      evidence: [
        `review_status=${loop.learning_review?.review_status ?? "unknown"}`,
        `model=${loop.learning_review?.model_route?.model ?? "unknown"}`,
      ],
      blockers: learningReady ? [] : ["learning_review_not_ready"],
    }),
    autonomyGate({
      id: "enterprise_review",
      label: "Review enterprise feed eligibility",
      status: enterpriseEligible ? "pass" : "locked",
      command: "npm run api:check:operational-truth -- --pretty",
      reason: "Enterprise remains locked until the full budget chain proves replay, smokes and healthy cursor evidence.",
      evidence: [
        `budget_chain_completed=${loop.budget_chain?.completed}`,
        `enterprise_eligible=${loop.budget_chain?.enterprise_eligible}`,
        `current_step=${loop.budget_chain?.current_step_label ?? "none"}`,
      ],
      blockers: enterpriseEligible ? [] : ["budget_chain_not_enterprise_eligible"],
    }),
  ];
}

function channelReadyGateCommand(runtimeFindings) {
  return runtimeReviewCommand(runtimeFindings);
}

function autonomyGate({
  id,
  label,
  status,
  command,
  reason,
  evidence,
  blockers = [],
  requiresAdminToken = false,
}) {
  return {
    id,
    label,
    status,
    command,
    reason,
    evidence,
    blockers,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    requires_admin_token: Boolean(requiresAdminToken),
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
  };
}

function highestPassedAutonomyGate(gates) {
  const contiguousPassed = [];
  for (const gate of gates) {
    if (gate.status !== "pass") break;
    contiguousPassed.push(gate);
  }
  const gate = contiguousPassed.at(-1) ?? gates[0] ?? null;
  return gate ? autonomyGateCeiling(gate) : null;
}

function nextAutonomyGate({ gates, activeCeiling }) {
  const index = gates.findIndex((gate) => gate.id === activeCeiling?.id);
  return gates.slice(Math.max(0, index + 1)).find((gate) => gate.status !== "pass") ?? null;
}

function autonomyGateCeiling(gate) {
  return {
    id: gate.id,
    label: gate.label,
    reason: gate.reason,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    executes_now: false,
  };
}

function buildHistoricalBackfillPlan({ report, eventPlan, sourcePlan, sourceRoutes, grandSlam }) {
  const sources = buildHistoricalBackfillSources({ report, grandSlam });
  const readyNow = sources.filter((source) => source.status === "ready_now");
  const operatorReady = sources.filter((source) => source.status === "operator_review");
  const blocked = sources.filter((source) => source.status === "blocked");
  const nextSource = readyNow[0] ?? operatorReady[0] ?? sources[0] ?? null;
  return {
    generated_at: new Date().toISOString(),
    mode: "historical_backfill_plan",
    status: nextSource ? "ready" : "blocked",
    source_mode: report.mode,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    objective: "rank_allowed_historical_backfill_sources_for_tennis_prediction_without_live_scraping",
    next_source: nextSource,
    sources,
    source_route: sourceRoutes.routes?.find((route) => route.id === "historical_public_backfill") ?? null,
    grand_slam_context: {
      status: grandSlam?.status ?? "unknown",
      active_grand_slams: grandSlam?.active_grand_slams ?? [],
      visible_matches: grandSlam?.matches?.grand_slam_visible ?? 0,
      prediction_rows: grandSlam?.matches?.prediction_rows ?? 0,
    },
    review_summary: {
      ready_now: readyNow.length,
      operator_review: operatorReady.length,
      blocked: blocked.length,
      total_sources: sources.length,
      license_review_required: sources.filter((source) => source.license_review_required).length,
      commercial_clearance_required: sources.filter((source) => source.commercial_clearance_required).length,
    },
    gates: historicalBackfillGates({ report, eventPlan, sourcePlan, sources }),
    operator_steps: [
      "Review each source license and attribution requirement before import.",
      "Create a local source manifest before any download/import script is allowed.",
      "Use historical backfill only for offline priors, backtests and calibration; live decisions still require fresh score/odds state.",
      "Do not scrape live scoreboards, sportsbook UIs, anti-bot protected pages, paywalled data, or login-only sources.",
    ],
    research_basis: [
      {
        id: "jeff_sackmann_tennis_atp_wta",
        url: "https://github.com/JeffSackmann/tennis_atp",
        note: "ATP/WTA historical tennis results, rankings and stats are useful for priors; license requires attribution and non-commercial use.",
      },
      {
        id: "tennis_data_csv",
        url: "https://www.tennis-data.co.uk/data.php",
        note: "Historical tennis results and betting odds CSVs can help odds/backtest features after terms review.",
      },
      {
        id: "tennis_slam_pointbypoint",
        url: "https://github.com/JeffSackmann/tennis_slam_pointbypoint",
        note: "Grand Slam point-by-point history can help BO5/BO3 and point-state calibration after license review.",
      },
    ],
    safe_jailbreak_policy: {
      meaning: "Use public/licensed historical sources as offline backfill routes; never bypass access controls or treat old data as live state.",
      bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      credential_or_session_extraction_allowed: false,
      provider_quota_spend_requires_operator: true,
      live_scraping_allowed: false,
    },
    forbidden_actions: [
      ...(report.forbidden_collection_paths ?? []),
      "live_scoreboard_scraping",
      "sportsbook_ui_automation",
      "paywall_or_terms_bypass",
      "commercial_use_without_license_clearance",
    ],
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function buildHistoricalBackfillSources({ report, grandSlam }) {
  const persistedMatches = Number(report.data_snapshot?.persisted_matches ?? 0);
  const productionExamples = Number(report.learning_snapshot?.production_training_examples ?? 0);
  return [
    historicalBackfillSource({
      id: "internal_persisted_replay",
      priority: 10,
      provider: "tennis_live_edge_postgres",
      dataset: "Persisted canonical matches, score ticks, odds ticks, paper settlements and training examples",
      coverage: ["ATP main", "Grand Slam men", "Grand Slam women", "persisted provider/replay fixtures"],
      useCases: ["pipeline_validation", "closing_line_proxy", "signal_gate_regression", "paper_learning"],
      status: persistedMatches > 0 ? "ready_now" : "blocked",
      costTier: "free_local",
      license: "internal_private_operational_data",
      licenseReviewRequired: false,
      commercialClearanceRequired: false,
      command: "npm run api:check:operational-truth -- --pretty",
      evidence: [
        `persisted_matches=${persistedMatches}`,
        `production_training_examples=${productionExamples}`,
      ],
      blockers: persistedMatches > 0 ? [] : ["no_persisted_matches"],
    }),
    historicalBackfillSource({
      id: "jeff_sackmann_atp",
      priority: 20,
      provider: "JeffSackmann/tennis_atp",
      dataset: "ATP historical rankings, results and match stats CSV files",
      coverage: ["ATP main", "ATP qualifiers/challenger/futures where available", "Grand Slam men"],
      useCases: ["surface_elo_seed", "ranking_trend_features", "serve_return_priors", "BO5_history"],
      status: "operator_review",
      costTier: "free_public_noncommercial",
      license: "CC BY-NC-SA 4.0 per Tennis Abstract repository",
      licenseReviewRequired: true,
      commercialClearanceRequired: true,
      attributionRequired: true,
      command: "Create a local source manifest; then run a future offline importer only after license review.",
      evidence: ["public_git_csv_available", "noncommercial_license_requires_review"],
      blockers: ["license_review_required", "source_manifest_missing"],
      sourceUrl: "https://github.com/JeffSackmann/tennis_atp",
    }),
    historicalBackfillSource({
      id: "jeff_sackmann_wta",
      priority: 30,
      provider: "JeffSackmann/tennis_wta",
      dataset: "WTA historical rankings, results and match stats CSV files",
      coverage: ["WTA tour", "Grand Slam women"],
      useCases: ["grand_slam_women_priors", "surface_elo_seed", "ranking_trend_features"],
      status: "operator_review",
      costTier: "free_public_noncommercial",
      license: "CC BY-NC-SA 4.0 per Tennis Abstract repository",
      licenseReviewRequired: true,
      commercialClearanceRequired: true,
      attributionRequired: true,
      command: "Create a local source manifest; then run a future offline importer only after license review.",
      evidence: ["public_git_csv_available", "noncommercial_license_requires_review"],
      blockers: ["license_review_required", "source_manifest_missing"],
      sourceUrl: "https://github.com/JeffSackmann/tennis_wta",
    }),
    historicalBackfillSource({
      id: "jeff_sackmann_slam_pointbypoint",
      priority: 40,
      provider: "JeffSackmann/tennis_slam_pointbypoint",
      dataset: "Grand Slam point-by-point historical data",
      coverage: ["Australian Open", "Roland Garros", "Wimbledon", "US Open"],
      useCases: ["markov_point_engine_calibration", "tiebreak_and_pressure_features", "BO5_point_state_priors"],
      status: "operator_review",
      costTier: "free_public_noncommercial",
      license: "CC BY-NC-SA 4.0 per Tennis Abstract repository",
      licenseReviewRequired: true,
      commercialClearanceRequired: true,
      attributionRequired: true,
      command: "Create a local source manifest; then run a future offline point-state importer only after license review.",
      evidence: [
        "public_grand_slam_point_history_available",
        `current_grand_slam_status=${grandSlam?.status ?? "unknown"}`,
      ],
      blockers: ["license_review_required", "source_manifest_missing"],
      sourceUrl: "https://github.com/JeffSackmann/tennis_slam_pointbypoint",
    }),
    historicalBackfillSource({
      id: "tennis_data_results_odds",
      priority: 50,
      provider: "Tennis-Data.co.uk",
      dataset: "Historical tennis results and fixed odds CSV/Excel files",
      coverage: ["ATP historical results/odds", "WTA historical results/odds where available"],
      useCases: ["market_prior_features", "closing_line_proxy_baseline", "odds_bucket_calibration"],
      status: "operator_review",
      costTier: "free_public_terms_review",
      license: "Public historical CSVs; terms and attribution must be reviewed before import.",
      licenseReviewRequired: true,
      commercialClearanceRequired: true,
      attributionRequired: true,
      command: "Create a local source manifest; then run a future offline odds/results importer only after terms review.",
      evidence: ["public_csv_available", "historical_odds_available"],
      blockers: ["terms_review_required", "source_manifest_missing"],
      sourceUrl: "https://www.tennis-data.co.uk/data.php",
    }),
    historicalBackfillSource({
      id: "theoddsapi_archive",
      priority: 60,
      provider: "TheOddsAPI",
      dataset: "Licensed historical odds/archive snapshots",
      coverage: ["provider-supported tennis markets"],
      useCases: ["archive_odds_comparison", "closing_line_proxy", "provider_crosscheck"],
      status: report.budget_chain_snapshot?.current_step && String(report.budget_chain_snapshot.current_step).includes("theoddsapi")
        ? "operator_review"
        : "monitor",
      costTier: "budget_paid_or_existing_key",
      license: "Paid API terms; private use only, no redistribution.",
      licenseReviewRequired: true,
      commercialClearanceRequired: false,
      command: "npm --silent run hermes:budget-chain",
      evidence: [
        `budget_chain_completed=${Boolean(report.budget_chain_snapshot?.budget_chain_completed)}`,
        `current_step=${report.budget_chain_snapshot?.current_step ?? "none"}`,
      ],
      blockers: ["operator_smoke_required", "quota_review_required"],
    }),
  ].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function historicalBackfillSource({
  id,
  priority,
  provider,
  dataset,
  coverage,
  useCases,
  status,
  costTier,
  license,
  licenseReviewRequired,
  commercialClearanceRequired,
  attributionRequired = false,
  command,
  evidence,
  blockers,
  sourceUrl = null,
}) {
  return {
    id,
    priority,
    provider,
    dataset,
    coverage,
    use_cases: useCases,
    status,
    cost_tier: costTier,
    license,
    license_review_required: Boolean(licenseReviewRequired),
    commercial_clearance_required: Boolean(commercialClearanceRequired),
    attribution_required: Boolean(attributionRequired),
    source_url: sourceUrl,
    command,
    evidence,
    blockers,
    execute_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function historicalBackfillGates({ report, eventPlan, sourcePlan, sources }) {
  return [
    historicalBackfillGate({
      id: "real_execution_hard_block",
      status: report.safety?.real_execution_hard_block === true ? "pass" : "fail",
      summary: "Real execution must remain hard-blocked while building backfill.",
    }),
    historicalBackfillGate({
      id: "safe_jailbreak_policy",
      status: sourcePlan.safe_jailbreak_policy?.bypass_allowed === false ? "pass" : "fail",
      summary: "Backfill can only use licensed/public allowed paths, never bypass.",
    }),
    historicalBackfillGate({
      id: "no_cursor_resync_before_live_use",
      status: eventPlan.events.some((event) => event.type === "cursor_resync_required") ? "warn" : "pass",
      summary: "Historical backfill may be planned during cursor gaps, but live decisions still freeze on resync.",
    }),
    historicalBackfillGate({
      id: "license_review_queue_visible",
      status: sources.some((source) => source.license_review_required) ? "pass" : "warn",
      summary: `${sources.filter((source) => source.license_review_required).length} sources require license/terms review before import.`,
    }),
  ];
}

function historicalBackfillGate({ id, status, summary }) {
  return { id, status, summary };
}

function buildEnterpriseAccuracyPlan({
  loop,
  report,
  eventPlan,
  sourcePlan,
  sourceRoutes,
  historicalBackfill,
  grandSlam,
}) {
  const budget = report.budget_chain_snapshot ?? {};
  const enterpriseEligible = Boolean(budget.enterprise_eligible);
  const stack = enterpriseAccuracyProviderStack({ enterpriseEligible, report, sourceRoutes });
  const access = enterpriseAccuracyAccessRequirements(stack);
  const nextProvider = stack.find((provider) => provider.status === "contract_required")
    ?? stack.find((provider) => provider.status === "operator_ready")
    ?? stack[0]
    ?? null;
  const nextAction = enterpriseAccuracyNextAction({ enterpriseEligible, budget, nextProvider });
  return {
    generated_at: new Date().toISOString(),
    mode: "enterprise_accuracy_plan",
    objective: "maximize_grand_slam_tennis_prediction_accuracy_without_budget_limit_or_unsafe_collection",
    status: enterpriseEligible ? "ready_for_enterprise_contracting" : "locked_on_budget_chain",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    budget_gate: {
      budget_chain_completed: Boolean(budget.budget_chain_completed),
      enterprise_eligible: enterpriseEligible,
      current_step: budget.current_step ?? null,
      next_safe_command: enterpriseEligible
        ? "npm --silent run hermes:enterprise-accuracy-plan"
        : "npm run api:check:operational-truth -- --pretty",
      reason: enterpriseEligible
        ? "Budget evidence is complete enough to prepare enterprise contracting and adapters."
        : "Enterprise stays locked until replay, smokes and healthy odds cursor prove the budget chain.",
    },
    grand_slam_context: {
      status: grandSlam.status,
      active_grand_slams: grandSlam.active_grand_slams ?? [],
      visible_matches: grandSlam.matches?.grand_slam_visible ?? 0,
      prediction_rows: grandSlam.matches?.prediction_rows ?? 0,
      paper_ready: Boolean(grandSlam.paper_ready),
    },
    source_context: {
      source_mode: sourcePlan.source_mode,
      next_budget_route: sourceRoutes.next_route?.id ?? null,
      historical_next_source: historicalBackfill.next_source?.id ?? null,
      historical_license_review_required: historicalBackfill.review_summary?.license_review_required ?? 0,
      trigger_events: eventPlan.events.map((event) => event.type),
    },
    no_budget_provider_stack: stack,
    access_requirements: access,
    enterprise_data_due_diligence: enterpriseDataDueDiligenceMatrix(),
    hermes_enterprise_playbook: enterpriseHermesDataPlaybook(),
    model_architecture: enterpriseAccuracyModelArchitecture(),
    scoreline_forecast_contract: enterpriseScorelineForecastContract(),
    hermes_operating_role: enterpriseHermesOperatingRole({ loop, report }),
    next_action: nextAction,
    research_basis: enterpriseAccuracyResearchBasis(),
    safe_jailbreak_policy: {
      meaning: "Hermes may route around missing coverage only through licensed APIs, persisted replay, license-reviewed historical files and operator-provided notes.",
      allowed_paths: [
        "licensed_enterprise_api_contract",
        "official_exchange_or_market_stream",
        "persisted_postgres_replay",
        "license_reviewed_historical_backfill",
        "manual_operator_note_with_source_url",
      ],
      bypass_allowed: false,
      anti_bot_bypass_allowed: false,
      paywall_bypass_allowed: false,
      geolocation_bypass_allowed: false,
      credential_or_session_extraction_allowed: false,
      browser_sportsbook_automation_allowed: false,
      live_scoreboard_scraping_allowed: false,
      llm_per_tick_allowed: false,
    },
    forbidden_actions: [
      ...(report.forbidden_collection_paths ?? []),
      "live_scoreboard_scraping",
      "sportsbook_ui_automation",
      "provider_or_paywall_bypass",
      "credential_or_session_extraction",
      "provider_quota_spend_without_operator_contract",
      "real_money_execution",
    ],
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block === true,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function buildEnterpriseReadinessPacket({ report, eventPlan }) {
  const budget = report.budget_chain_snapshot ?? {};
  const data = report.data_snapshot ?? {};
  const learning = report.learning_snapshot ?? {};
  const safety = report.safety ?? {};
  const shadowProviders = data.enterprise_shadow_providers ?? [];
  const providerIds = new Set(shadowProviders.map((provider) => provider.provider));
  const requiredProviders = ["sportradar", "betradar_uof", "txodds", "betfair"];
  const missingShadowProviders = requiredProviders.filter((provider) => !providerIds.has(provider));
  const budgetChainCompleted = Boolean(budget.budget_chain_completed);
  const enterpriseEligible = Boolean(budget.enterprise_eligible);
  const backendUnavailable = (report.blockers ?? []).some((blocker) => (
    String(blocker).startsWith("backend_api:")
  ));
  const safetyHardBlocked = safety.real_execution_hard_block === true
    && safety.can_submit_real_orders === false;
  const replayReady = data.replay_contract_ready === "ready";
  const activationBlockers = [
    ...(backendUnavailable ? ["backend_evidence_unavailable"] : []),
    ...(!budgetChainCompleted ? ["budget_chain_incomplete"] : []),
    ...(!enterpriseEligible ? ["enterprise_eligible_false"] : []),
    ...(!replayReady ? ["budget_replay_lab_not_ready"] : []),
    ...(!safetyHardBlocked ? ["real_execution_hard_block_not_proven"] : []),
    ...missingShadowProviders.map((provider) => `missing_shadow_provider:${provider}`),
  ];
  const operatorContractReviewAllowed = activationBlockers.length === 0;
  return {
    generated_at: new Date().toISOString(),
    mode: "enterprise_readiness_packet",
    status: enterpriseReadinessStatus({
      budgetChainCompleted,
      enterpriseEligible,
      replayReady,
      missingShadowProviders,
      safetyHardBlocked,
      backendUnavailable,
    }),
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    operator_contract_review_allowed: operatorContractReviewAllowed,
    budget_gate: {
      budget_chain_completed: budgetChainCompleted,
      enterprise_eligible: enterpriseEligible,
      current_step: budget.current_step ?? null,
      core_ready: Boolean(budget.core_ready),
      warnings: budget.warnings ?? [],
    },
    replay_gate: {
      budget_replay_status: data.replay_contract_ready ?? "unknown",
      shadow_contract_source: "operational_state.replay_lab.enterprise_shadow_providers",
      shadow_provider_count: shadowProviders.length,
      required_shadow_providers: requiredProviders,
      missing_shadow_providers: missingShadowProviders,
      providers: shadowProviders,
    },
    learning_gate: {
      model_lab_status: learning.model_lab_status ?? "unknown",
      production_training_examples: learning.production_training_examples ?? 0,
      can_run_live_backtest: Boolean(learning.can_run_live_backtest),
      readiness_status: learning.readiness_status ?? "unknown",
      note: "Learning evidence is required for model activation, not for offline enterprise contract visibility.",
    },
    event_context: {
      mode: report.mode,
      blockers: report.blockers ?? [],
      trigger_events: eventPlan.events.map((event) => event.type),
      degraded_items: report.degraded_items ?? {},
    },
    activation_blockers: activationBlockers,
    next_action: enterpriseReadinessNextAction({
      budgetChainCompleted,
      enterpriseEligible,
      replayReady,
      missingShadowProviders,
      safetyHardBlocked,
      backendUnavailable,
    }),
    safe_jailbreak_policy: {
      meaning: "Hermes may find lower-cost permitted routes around missing data only through internal APIs, offline fixtures, persisted replay, licensed provider contracts and operator-provided notes.",
      allowed_routes: [
        "internal_fastapi_read_model",
        "enterprise_shadow_fixture",
        "persisted_postgres_replay",
        "licensed_provider_contract_or_sandbox",
        "operator_note_with_source_manifest",
      ],
      browser_or_sportsbook_automation_allowed: false,
      anti_bot_bypass_allowed: false,
      geolocation_bypass_allowed: false,
      paywall_bypass_allowed: false,
      credential_or_session_extraction_allowed: false,
      provider_quota_spend_allowed_from_this_command: false,
    },
    safety: {
      real_execution_hard_block: safety.real_execution_hard_block === true,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function enterpriseReadinessStatus({
  budgetChainCompleted,
  enterpriseEligible,
  replayReady,
  missingShadowProviders,
  safetyHardBlocked,
  backendUnavailable,
}) {
  if (backendUnavailable) return "blocked_by_backend_evidence";
  if (!safetyHardBlocked) return "blocked_by_safety";
  if (missingShadowProviders.length) return "missing_shadow_contracts";
  if (!replayReady) return "blocked_by_replay_lab";
  if (!budgetChainCompleted) return "locked_on_budget_chain";
  if (!enterpriseEligible) return "blocked_by_enterprise_gate";
  return "ready_for_operator_contract_review";
}

function enterpriseReadinessNextAction({
  budgetChainCompleted,
  enterpriseEligible,
  replayReady,
  missingShadowProviders,
  safetyHardBlocked,
  backendUnavailable,
}) {
  if (backendUnavailable) {
    return enterpriseReadinessAction({
      id: "restore_backend_evidence",
      command: "npm --silent run hermes:backend-latency-triage",
      reason: "FastAPI evidence is unavailable or timing out; restore backend read models before enterprise readiness review.",
    });
  }
  if (!safetyHardBlocked) {
    return enterpriseReadinessAction({
      id: "restore_real_execution_hard_block",
      command: "npm --silent run hermes:preflight",
      reason: "Safety evidence is not hard-blocked; inspect preflight before any enterprise work.",
    });
  }
  if (missingShadowProviders.length) {
    return enterpriseReadinessAction({
      id: "complete_enterprise_shadow_contracts",
      command: "npm --silent run hermes:enterprise-accuracy-plan",
      reason: `Missing shadow providers: ${missingShadowProviders.join(", ")}.`,
    });
  }
  if (!replayReady) {
    return enterpriseReadinessAction({
      id: "harden_budget_replay_lab",
      command: "npm run api:replay:contracts",
      reason: "Budget replay lab must be ready before enterprise activation review.",
    });
  }
  if (!budgetChainCompleted || !enterpriseEligible) {
    return enterpriseReadinessAction({
      id: "complete_budget_chain_before_enterprise",
      command: "npm --silent run hermes:budget-chain",
      reason: "Enterprise remains locked until budget_chain_completed and enterprise_eligible are true.",
    });
  }
  return enterpriseReadinessAction({
    id: "operator_enterprise_contract_review",
    command: "npm --silent run hermes:enterprise-accuracy-plan",
    reason: "Enterprise shadow evidence is complete; prepare human-reviewed provider contract/sample-payload requests.",
  });
}

function enterpriseReadinessAction({ id, command, reason }) {
  return {
    id,
    command,
    reason,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function enterpriseAccuracyProviderStack({ enterpriseEligible, report, sourceRoutes }) {
  const status = enterpriseEligible ? "contract_required" : "locked_until_budget_gate";
  return [
    enterpriseAccuracyProvider({
      id: "sportradar_tennis_tier1",
      rank: 1,
      provider: "Sportradar Tennis",
      role: "primary official score_state and point_by_point spine",
      coverage: ["ATP", "WTA", "ITF", "Grand Slam"],
      unlocks: ["point_state_markov", "retirement_delay_walkover_events", "canonical_competitor_ids", "match_timeline_replay"],
      latencyTarget: "official low-latency tennis feed by contracted tier",
      status,
      access: ["SPORTRADAR_API_KEY", "Sportradar sales contract", "coverage tier matrix"],
      evidence: [
        `enterprise_eligible=${enterpriseEligible}`,
        `provider_mode=${report.data_snapshot?.provider_mode ?? "unknown"}`,
      ],
      sourceUrl: "https://developer.sportradar.com/tennis/docs/ig-api-basics",
    }),
    enterpriseAccuracyProvider({
      id: "tennis_data_innovations_atp_official",
      rank: 2,
      provider: "Tennis Data Innovations",
      role: "official ATP/Challenger data and streaming rights route for contracted products",
      coverage: ["ATP Tour", "ATP Challenger", "ATP Media products"],
      unlocks: ["official_atp_identity_spine", "atp_match_context", "atp_live_streaming_rights_review", "atp_data_license_clarity"],
      latencyTarget: "official contracted ATP data route by product tier",
      status,
      access: ["TDI commercial agreement", "permitted-use terms", "ATP data product scope"],
      evidence: [`enterprise_eligible=${enterpriseEligible}`],
      sourceUrl: "https://www.tennisdata.com/",
    }),
    enterpriseAccuracyProvider({
      id: "stats_perform_opta_wta_fast_data",
      rank: 3,
      provider: "Stats Perform / Opta WTA",
      role: "official WTA shot_by_shot and deep match statistics",
      coverage: ["WTA Tour", "WTA qualifiers", "WTA live video where licensed"],
      unlocks: ["shot_by_shot_features", "serve_return_quality_live", "rally_length_pressure", "wta_scoreline_calibration"],
      latencyTarget: "official WTA fast data by commercial contract",
      status,
      access: ["STATS_PERFORM_WTA_ACCESS", "commercial data agreement", "permitted-use terms"],
      evidence: [`wta_grand_slam_budget_scope=${(report.coverage_scope ?? []).includes("grand_slam_women")}`],
      sourceUrl: "https://www.statsperform.com/wta/",
    }),
    enterpriseAccuracyProvider({
      id: "txodds_fusion_in_running",
      rank: 4,
      provider: "TXODDS",
      role: "ultra_low_latency in_running odds and historical market archive",
      coverage: ["global tennis odds", "in-play markets", "historical odds"],
      unlocks: ["market_microstructure", "line_move_velocity", "suspension_timing", "closing_line_proxy"],
      latencyTarget: "sub-second or better by contracted product",
      status,
      access: ["TXODDS_USER", "TXODDS_PASSWORD", "market package", "historical archive package"],
      evidence: [`next_budget_route=${sourceRoutes.next_route?.id ?? "none"}`],
      sourceUrl: "https://txodds.net/developer-hub/",
    }),
    enterpriseAccuracyProvider({
      id: "betradar_uof_market_state",
      rank: 5,
      provider: "Betradar UOF",
      role: "market_state, odds, suspensions and settlement-grade reference",
      coverage: ["bookmaker market feeds", "in-running tennis markets"],
      unlocks: ["market_suspension_block", "bookmaker_alias_mapping", "odds_consensus", "settlement_audit"],
      latencyTarget: "enterprise feed by market package",
      status,
      access: ["BETRADAR_UOF_TOKEN", "UOF package", "bookmaker market rights"],
      evidence: [`real_execution_hard_block=${report.safety?.real_execution_hard_block}`],
      sourceUrl: "https://docs.sportradar.com/uof/introduction/overview",
    }),
    enterpriseAccuracyProvider({
      id: "betfair_exchange_stream_market_data",
      rank: 6,
      provider: "Betfair Exchange Stream API",
      role: "exchange order_book, traded_volume and closing_line_reference",
      coverage: ["exchange tennis markets where account jurisdiction permits"],
      unlocks: ["liquidity_weighted_edge", "queue_fill_simulation", "closing_line_value", "market_depth_confidence"],
      latencyTarget: "streaming market data after account/KYC/app-key approval",
      status,
      access: ["BETFAIR_APP_KEY", "BETFAIR_CERT_PATH", "BETFAIR_KEY_PATH", "market data stream access"],
      evidence: ["execution remains hard-blocked; market data only in this phase"],
      sourceUrl: null,
    }),
    enterpriseAccuracyProvider({
      id: "premium_point_by_point_fallback",
      rank: 7,
      provider: "Goalserve / Data Sports Group / Podium Sports fallback review",
      role: "secondary point_by_point coverage and redundancy if official primary feeds miss events",
      coverage: ["Grand Slam", "ATP", "WTA", "ITF depending on contract"],
      unlocks: ["redundant_point_events", "provider_disagreement_alerts", "coverage_gap_fill", "fallback_replay_payloads"],
      latencyTarget: "fallback only; must be measured against official primary feeds",
      status: enterpriseEligible ? "vendor_review_required" : "locked_until_budget_gate",
      access: ["commercial trial", "sample payloads", "license review", "latency SLA"],
      evidence: ["fallback must never override fresher official primary data without conflict review"],
      sourceUrl: "https://datasportsgroup.com/coverage/tennis/",
    }),
    enterpriseAccuracyProvider({
      id: "opticodds_or_theoddsapi_consensus",
      rank: 8,
      provider: "OpticOdds / TheOddsAPI / Odds-API.io",
      role: "odds consensus, archive fallback and provider disagreement checks",
      coverage: ["bookmaker odds comparison", "REST archive", "WebSocket where licensed"],
      unlocks: ["fallback_fair_price", "provider_disagreement", "quota_resilience", "book_availability"],
      latencyTarget: "fallback/comparison, not primary enterprise line",
      status: "budget_or_fallback",
      access: ["THE_ODDS_API_KEY", "ODDS_API_IO_KEY", "OPTICODDS_API_KEY if chosen"],
      evidence: ["keep as fallback even after enterprise providers are contracted"],
      sourceUrl: "https://developer.opticodds.com/docs/odds-api-getting-started-guide",
    }),
  ];
}

function enterpriseAccuracyProvider({
  id,
  rank,
  provider,
  role,
  coverage,
  unlocks,
  latencyTarget,
  status,
  access,
  evidence,
  sourceUrl,
}) {
  return {
    id,
    rank,
    provider,
    role,
    coverage,
    unlocks,
    latency_target: latencyTarget,
    status,
    access_required: access,
    evidence,
    source_url: sourceUrl,
    execute_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function enterpriseAccuracyAccessRequirements(stack) {
  return stack.map((provider) => ({
    provider_id: provider.id,
    provider: provider.provider,
    priority: provider.rank,
    access_required: provider.access_required,
    operator_action: provider.status === "locked_until_budget_gate"
      ? "finish_budget_chain_before_contracting"
      : "request_contract_or_sandbox_and_store_credentials_locally",
    free_or_low_cost: provider.id === "opticodds_or_theoddsapi_consensus",
    blocks_accuracy_lane: provider.rank <= 4,
  }));
}

function enterpriseDataDueDiligenceMatrix() {
  return [
    enterpriseDataDueDiligenceRow({
      id: "official_score_and_identity",
      objective: "Lock canonical match/player/tournament identity before any model or market decision.",
      primaryProviders: ["sportradar_tennis_tier1", "tennis_data_innovations_atp_official", "stats_perform_opta_wta_fast_data"],
      requiredFields: ["canonical_match_id", "canonical_player_id", "tour", "round", "surface", "best_of_sets", "retirement_walkover_delay"],
      proofArtifacts: ["provider_sample_payload", "canonical_mapping_test", "conflict_review_queue"],
      acceptanceTests: [
        "same player names map to stable internal IDs across providers",
        "Grand Slam ATP rows resolve BO5 and WTA rows resolve BO3",
        "retirement, walkover and delay states block scoreline forecasts",
      ],
      accuracyImpact: "highest",
    }),
    enterpriseDataDueDiligenceRow({
      id: "point_by_point_live_state",
      objective: "Feed the Markov engine with current server, point score, game score and tiebreak state.",
      primaryProviders: ["sportradar_tennis_tier1", "premium_point_by_point_fallback"],
      requiredFields: ["server_player_id", "point_score", "game_score", "set_score", "tiebreak_state", "break_point", "timestamp"],
      proofArtifacts: ["replay_contract", "sequence_gap_test", "latency_histogram"],
      acceptanceTests: [
        "missed point sequence triggers resync_required and blocks signals",
        "tiebreak and deciding-set rules are preserved in replay",
        "source timestamp and ingest timestamp are stored for every point",
      ],
      accuracyImpact: "highest",
    }),
    enterpriseDataDueDiligenceRow({
      id: "shot_and_rally_quality",
      objective: "Improve live serve/return/fatigue estimates beyond scoreboard state.",
      primaryProviders: ["stats_perform_opta_wta_fast_data", "tennis_data_innovations_atp_official"],
      requiredFields: ["serve_speed", "serve_location", "return_depth", "rally_length", "winner_error_type", "movement_or_fatigue_proxy"],
      proofArtifacts: ["sample_payload_dictionary", "feature_snapshot", "model_ablation_report"],
      acceptanceTests: [
        "feature snapshots are timestamped before prediction time",
        "ablation improves Brier/log loss or CLV without worse drawdown",
        "missing shot data downgrades confidence instead of fabricating features",
      ],
      accuracyImpact: "high",
    }),
    enterpriseDataDueDiligenceRow({
      id: "market_microstructure",
      objective: "Separate true model edge from stale odds and sharp market information.",
      primaryProviders: ["txodds_fusion_in_running", "betradar_uof_market_state", "betfair_exchange_stream_market_data"],
      requiredFields: ["moneyline_price", "suspension_state", "bookmaker", "sequence_id", "traded_volume_or_depth", "closing_line_proxy"],
      proofArtifacts: ["odds_tick_replay", "market_suspension_test", "clv_report"],
      acceptanceTests: [
        "stale odds and market suspension hard-block signals",
        "closing-line proxy is unavailable at decision timestamp and added only after settlement",
        "provider disagreement is visible before stake sizing",
      ],
      accuracyImpact: "high",
    }),
    enterpriseDataDueDiligenceRow({
      id: "historical_backtest_depth",
      objective: "Train and calibrate only on time-valid examples with enough surface/tour/odds coverage.",
      primaryProviders: ["txodds_fusion_in_running", "opticodds_or_theoddsapi_consensus", "premium_point_by_point_fallback"],
      requiredFields: ["pre_match_odds", "in_play_odds", "score_state_history", "match_result", "closing_price", "provider_latency"],
      proofArtifacts: ["source_manifest", "license_review", "walk_forward_backtest"],
      acceptanceTests: [
        "no post-match or closing-line features appear before simulated decision time",
        "calibration is reported by odds bucket, surface, tour and provider",
        "challenger/fallback data cannot promote a production model alone",
      ],
      accuracyImpact: "medium_high",
    }),
  ];
}

function enterpriseDataDueDiligenceRow({
  id,
  objective,
  primaryProviders,
  requiredFields,
  proofArtifacts,
  acceptanceTests,
  accuracyImpact,
}) {
  return {
    id,
    objective,
    primary_provider_ids: primaryProviders,
    required_fields: requiredFields,
    proof_artifacts: proofArtifacts,
    acceptance_tests: acceptanceTests,
    accuracy_impact: accuracyImpact,
    hermes_role: "compile_requirements_and_review_evidence_only",
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function enterpriseHermesDataPlaybook() {
  return {
    operating_model: "Hermes is the enterprise data operations analyst, not a scraper, model executor or betting executor.",
    safe_jailbreak_definition: "Find permitted routes around missing coverage by ranking licensed APIs, replay, historical manifests and operator-provided evidence.",
    stages: [
      {
        id: "rfp_packet",
        command: "npm --silent run hermes:enterprise-accuracy-plan",
        purpose: "Produce provider questions, sample-payload requirements and feature proof criteria.",
        provider_api_call_allowed: false,
      },
      {
        id: "sample_payload_review",
        command: "npm run api:check:operational-truth -- --pretty",
        purpose: "Validate sample payloads only after operator stores them in approved local fixtures.",
        provider_api_call_allowed: false,
      },
      {
        id: "replay_contracts",
        command: "npm run api:replay:contracts",
        purpose: "Prove parser, timestamp, cursor and block behavior before live credentials are used.",
        provider_api_call_allowed: false,
      },
      {
        id: "operator_live_smoke",
        command: "npm run hermes:provider-smoke -- --execute-provider-call",
        purpose: "Run only from a local operator shell after contracts, keys and quotas are explicitly approved.",
        provider_api_call_allowed: false,
        operator_must_enable_provider_call: true,
      },
      {
        id: "model_ablation",
        command: "npm --silent run hermes:learning-review",
        purpose: "Promote features only through walk-forward ROI, CLV, Brier/log-loss, calibration and drawdown evidence.",
        provider_api_call_allowed: false,
      },
    ],
    forbidden_shortcuts: [
      "scoreboard_scraping",
      "sportsbook_browser_automation",
      "paywall_or_geolocation_bypass",
      "credential_or_session_extraction",
      "provider_quota_spend_from_cron",
      "real_money_execution",
    ],
  };
}

function enterpriseAccuracyModelArchitecture() {
  return [
    {
      id: "prematch_strength_ensemble",
      purpose: "Estimate baseline match win and set distribution before first point.",
      inputs: ["surface_elo_glicko", "serve_return_strength", "rest_travel_fatigue", "rank_trend", "injury_retirement_history", "bookmaker_prior"],
      output: ["match_win_probability", "set_score_distribution", "uncertainty_interval"],
    },
    {
      id: "live_markov_point_engine",
      purpose: "Update match and scoreline probabilities from point/game/set state.",
      inputs: ["server", "point_score", "game_score", "set_score", "bo3_bo5", "tiebreak_rules", "bayesian_hold_break_updates"],
      output: ["match_win_probability_live", "next_game_break_probability", "projected_final_score"],
    },
    {
      id: "shot_and_rally_feature_layer",
      purpose: "Use top-tier shot/rally feeds when available to improve live form and fatigue estimates.",
      inputs: ["serve_speed", "first_serve_location", "return_depth", "rally_length", "forced_unforced_errors", "movement_or_video_metrics_if_licensed"],
      output: ["serve_quality_now", "return_pressure_now", "fatigue_pressure_index"],
    },
    {
      id: "market_microstructure_layer",
      purpose: "Separate model edge from stale or information-lagged market prices.",
      inputs: ["odds_velocity", "book_disagreement", "market_suspensions", "exchange_depth", "traded_volume", "closing_line_proxy"],
      output: ["fair_market_probability", "price_confidence", "stale_or_sharp_move_block"],
    },
    {
      id: "calibration_and_abstention",
      purpose: "Improve ROI/CLV by refusing weak or uncalibrated forecasts.",
      inputs: ["walk_forward_isotonic_calibration", "brier_log_loss", "roi_clv_bucket", "drawdown", "data_quality_tier"],
      output: ["calibrated_edge", "confidence_tier", "abstain_or_paper_signal"],
    },
  ];
}

function enterpriseScorelineForecastContract() {
  return {
    output_schema: {
      match_id: "canonical_match_id",
      predicted_winner_id: "player_id",
      projected_score: "e.g. 3-1 or 2-1 plus set-score bands",
      match_win_probability: "0..1 calibrated",
      scoreline_distribution: "top N exact set-score outcomes",
      confidence_tier: "Alta | Media | Baixa",
      uncertainty_drivers: ["data_quality", "surface_fit", "market_disagreement", "injury_or_retirement_hazard"],
    },
    acceptance_gates: [
      "fresh_score_state",
      "complete_moneyline_or_market_prior",
      "canonical_player_mapping",
      "surface_and_format_known",
      "calibration_bucket_available",
      "market_suspension_absent",
    ],
    blocked_states: [
      "retirement_or_walkover_uncertain",
      "score_feed_stale",
      "odds_cursor_resync_required",
      "single_source_marginal_edge",
      "volatile_point_without_large_edge",
    ],
  };
}

function enterpriseHermesOperatingRole({ loop, report }) {
  return {
    primary_role: "operator_orchestrator_not_model_or_executor",
    autonomy_ceiling: loop.autonomy?.active_ceiling?.id ?? loop.active_phase ?? "unknown",
    responsibilities: [
      "watch internal FastAPI/Postgres truth",
      "route provider-health and cursor anomalies",
      "schedule replay/backtest/model-readiness reports",
      "summarize Grand Slam match-day readiness",
      "prepare enterprise access checklists",
      "create implementation handoffs from repeated local evidence",
    ],
    explicitly_not_allowed: [
      "LLM per odds tick",
      "scrape live scoreboards or sportsbooks",
      "bypass paywalls, geolocation or anti-bot controls",
      "hold provider secrets in prompts",
      "submit real orders",
    ],
    current_runtime: {
      status: loop.status,
      provider_mode: report.data_snapshot?.provider_mode ?? "unknown",
      real_execution_hard_block: report.safety?.real_execution_hard_block === true,
    },
  };
}

function enterpriseAccuracyNextAction({ enterpriseEligible, budget, nextProvider }) {
  if (!enterpriseEligible) {
    return {
      id: "complete_budget_chain_before_enterprise_accuracy",
      command: "npm run api:check:operational-truth -- --pretty",
      reason: `Enterprise accuracy is locked until budget_chain_completed and enterprise_eligible pass; current_step=${budget.current_step ?? "unknown"}.`,
      executes_now: false,
      writes: false,
      live_api_calls: false,
      provider_api_call_allowed: false,
      can_create_paper_orders: false,
      can_submit_real_orders: false,
      llm_per_tick_allowed: false,
    };
  }
  return {
    id: nextProvider?.id ?? "enterprise_provider_contracting",
    command: "npm --silent run hermes:enterprise-accuracy-plan",
    reason: nextProvider
      ? `Start operator-reviewed contracting/sandbox setup for ${nextProvider.provider}; Hermes only tracks readiness.`
      : "Review enterprise provider access requirements.",
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function enterpriseAccuracyResearchBasis() {
  return [
    {
      id: "sportradar_tennis_api",
      url: "https://developer.sportradar.com/tennis/docs/ig-api-basics",
      takeaway: "Sportradar Tennis has tiered global tennis coverage and is the candidate primary official scoring/point data spine.",
    },
    {
      id: "stats_perform_wta_fast_data",
      url: "https://www.statsperform.com/wta/",
      takeaway: "Stats Perform/Opta is the official WTA data and streaming partner with shot-by-shot and deep WTA data products.",
    },
    {
      id: "txodds_developer_hub",
      url: "https://txodds.net/developer-hub/",
      takeaway: "TXODDS positions its feed around ultra-low-latency pre-match, live and historical odds for trading systems.",
    },
    {
      id: "opticodds_api",
      url: "https://developer.opticodds.com/docs/odds-api-getting-started-guide",
      takeaway: "OpticOdds can be a fallback/comparison odds aggregator, not the only enterprise primary source.",
    },
    {
      id: "the_odds_api_tennis",
      url: "https://the-odds-api.com/sports/tennis-odds.html",
      takeaway: "TheOddsAPI covers major tennis odds and remains useful for archive/fallback/comparison in private analysis.",
    },
  ];
}

function enterpriseAccuracySummary(plan) {
  if (!plan) return null;
  return {
    status: plan.status,
    objective: plan.objective,
    budget_gate: plan.budget_gate,
    top_provider: plan.no_budget_provider_stack?.[0] ? {
      id: plan.no_budget_provider_stack[0].id,
      provider: plan.no_budget_provider_stack[0].provider,
      status: plan.no_budget_provider_stack[0].status,
      role: plan.no_budget_provider_stack[0].role,
    } : null,
    provider_count: plan.no_budget_provider_stack?.length ?? 0,
    due_diligence_area_count: plan.enterprise_data_due_diligence?.length ?? 0,
    scoreline_gate_count: plan.scoreline_forecast_contract?.acceptance_gates?.length ?? 0,
    next_action: plan.next_action,
    safe_jailbreak_policy: plan.safe_jailbreak_policy,
  };
}

function enterpriseReadinessSummary(packet) {
  if (!packet) return null;
  return {
    status: packet.status,
    operator_contract_review_allowed: Boolean(packet.operator_contract_review_allowed),
    budget_gate: packet.budget_gate,
    replay_gate: {
      budget_replay_status: packet.replay_gate?.budget_replay_status ?? "unknown",
      shadow_provider_count: packet.replay_gate?.shadow_provider_count ?? 0,
      missing_shadow_providers: packet.replay_gate?.missing_shadow_providers ?? [],
    },
    activation_blockers: packet.activation_blockers ?? [],
    next_action: packet.next_action,
    safe_jailbreak_policy: packet.safe_jailbreak_policy,
  };
}

function sourceUseManifestSummary(packet) {
  if (!packet) return null;
  return {
    status: packet.status,
    objective: packet.objective,
    summary: packet.summary,
    next_action: packet.next_action,
    gate_status_counts: countValues((packet.gates ?? []).map((gate) => gate.status)),
    allowed_source_ids: (packet.manifest ?? [])
      .filter((row) => row.decision === "allowed")
      .map((row) => row.id),
    operator_required_source_ids: (packet.manifest ?? [])
      .filter((row) => row.decision === "operator_required")
      .map((row) => row.id),
    deferred_source_ids: (packet.manifest ?? [])
      .filter((row) => row.decision === "deferred")
      .map((row) => row.id),
    forbidden_source_ids: (packet.manifest ?? [])
      .filter((row) => row.decision === "forbidden")
      .map((row) => row.id),
    safe_jailbreak_policy: packet.safe_jailbreak_policy,
  };
}

function buildGrandSlamScorelineForecast({
  backend,
  report,
  liveWindowPlan,
  pulse,
  sourceRoutes,
  matches,
  grandSlam,
}) {
  const pulseByMatchId = new Map((pulse.watchlist ?? []).map((row) => [row.match_id, row]));
  const slamRows = matches
    .map((analysis) => grandSlamMatchRow(analysis))
    .filter((row) => row.is_grand_slam)
    .map((row) => ({
      ...row,
      pulse: pulseByMatchId.get(row.match_id) ?? null,
    }));
  const forecasts = slamRows.map((row) => grandSlamScorelineForecastRow(row));
  const blockers = [...new Set(forecasts.flatMap((row) => row.blocked_reasons ?? []))];
  const status = grandSlamScorelineForecastStatus({
    backend,
    report,
    grandSlam,
    forecasts,
  });
  const providerStack = enterpriseAccuracyProviderStack({
    enterpriseEligible: Boolean(report.budget_chain_snapshot?.enterprise_eligible),
    report,
    sourceRoutes,
  });
  return {
    generated_at: new Date().toISOString(),
    mode: "grand_slam_scoreline_forecast",
    objective: "project Grand Slam match winners and plausible set scorelines from existing backend probabilities only",
    status,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    provider_mode: report.data_snapshot?.provider_mode ?? "unknown",
    grand_slam_readiness: {
      status: grandSlam.status,
      prediction_ready: Boolean(grandSlam.prediction_ready),
      paper_ready: Boolean(grandSlam.paper_ready),
      active_grand_slams: grandSlam.active_grand_slams ?? [],
      visible_matches: grandSlam.matches?.grand_slam_visible ?? 0,
      prediction_rows: grandSlam.matches?.prediction_rows ?? 0,
    },
    scoreline_contract: grandSlamScorelineContract(),
    summary: {
      total_grand_slam_rows: slamRows.length,
      forecast_ready_rows: forecasts.filter((row) => row.status === "forecast_ready").length,
      blocked_rows: forecasts.filter((row) => row.status === "blocked").length,
      top_forecast: forecasts.find((row) => row.status === "forecast_ready") ?? forecasts[0] ?? null,
    },
    forecasts,
    blockers,
    feature_gaps: grandSlamScorelineFeatureGaps(),
    enterprise_unlocks: providerStack.slice(0, 5).map((provider) => ({
      provider_id: provider.id,
      provider: provider.provider,
      unlocks: provider.unlocks,
      status: provider.status,
      provider_api_call_allowed: false,
    })),
    next_action: grandSlamScorelineNextAction({ status, grandSlam, liveWindowPlan }),
    safe_jailbreak_policy: {
      meaning: "Only internal FastAPI/Postgres rows, replay data, licensed providers and operator-reviewed historical sources may improve forecasts.",
      allowed_paths: [
        "internal_fastapi_packets",
        "persisted_postgres_replay",
        "licensed_provider_api_after_operator_approval",
        "license_reviewed_historical_backfill",
      ],
      bypass_allowed: false,
      live_scraping_allowed: false,
      sportsbook_browser_automation_allowed: false,
      provider_quota_spend_without_operator: false,
      llm_per_tick_allowed: false,
    },
    forbidden_actions: [
      ...(report.forbidden_collection_paths ?? []),
      "live_scoreboard_scraping",
      "sportsbook_ui_automation",
      "provider_quota_spend_without_operator",
      "paper_order_creation_from_scoreline_packet",
      "real_money_execution",
    ],
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block === true
        && backend.safety?.real_execution_hard_block === true,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function grandSlamScorelineForecastRow(row) {
  const projection = scorelineProjection(row);
  const blockedReasons = grandSlamScorelineBlockedReasons(row, projection);
  const warnings = grandSlamScorelineWarnings(row);
  return {
    match_id: row.match_id,
    tournament: row.tournament,
    grand_slam_id: row.grand_slam_id,
    grand_slam_label: row.grand_slam_label,
    tour: row.tour,
    surface: row.surface,
    round: row.round,
    status: blockedReasons.length ? "blocked" : "forecast_ready",
    match_status: row.status,
    format: projection.format,
    best_of_sets: projection.best_of_sets,
    players: {
      p1: row.player1,
      p2: row.player2,
    },
    projected_winner_id: projection.projected_winner_id,
    projected_winner_name: projection.projected_winner_name,
    winner_probability: projection.winner_probability,
    projected_scoreline: projection.projected_scoreline,
    scoreline_distribution: projection.scoreline_distribution,
    confidence: grandSlamScorelineConfidence({ row, projection, blockedReasons, warnings }),
    data_quality: {
      score_valid: Boolean(row.status),
      probability_valid: projection.probability_valid,
      format_known: projection.best_of_sets !== null,
      fresh_score: grandSlamFreshScore(row),
      fresh_odds: grandSlamFreshOdds(row),
      score_age_ms: Number.isFinite(Number(row.freshness?.score_age_ms)) ? Number(row.freshness.score_age_ms) : null,
      odds_age_ms: Number.isFinite(Number(row.freshness?.odds_age_ms)) ? Number(row.freshness.odds_age_ms) : null,
      signal_status: row.pulse?.signal?.status ?? null,
      attention: row.pulse?.attention ?? null,
    },
    blocked_reasons: blockedReasons,
    warnings,
    model_version: row.prediction?.model_version ?? null,
    notes: projection.notes,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function scorelineProjection(row) {
  const p1 = Number(row.prediction?.p1_win_prob);
  const p2 = Number(row.prediction?.p2_win_prob);
  const probabilityValid = Number.isFinite(p1) && Number.isFinite(p2);
  const format = grandSlamMatchFormat(row);
  if (!probabilityValid || !format.best_of_sets) {
    return {
      probability_valid: probabilityValid,
      format: format.id,
      best_of_sets: format.best_of_sets,
      projected_winner_id: null,
      projected_winner_name: null,
      winner_probability: null,
      projected_scoreline: null,
      scoreline_distribution: [],
      notes: ["missing_probability_or_format"],
    };
  }
  const p1Favored = p1 >= p2;
  const winnerProbability = Number(Math.max(p1, p2).toFixed(4));
  const winner = p1Favored ? row.player1 : row.player2;
  const distribution = grandSlamSetScoreDistribution({ winnerProbability, bestOfSets: format.best_of_sets });
  return {
    probability_valid: true,
    format: format.id,
    best_of_sets: format.best_of_sets,
    projected_winner_id: winner.id ?? null,
    projected_winner_name: winner.name ?? (p1Favored ? "Player 1" : "Player 2"),
    winner_probability: winnerProbability,
    projected_scoreline: distribution[0]?.scoreline ?? null,
    scoreline_distribution: distribution,
    notes: [
      "deterministic_set_score_heuristic",
      "uses_existing_backend_match_probability",
      "not_exact_game_score_prediction",
    ],
  };
}

function grandSlamMatchFormat(row) {
  const explicitBestOf = Number(row.best_of_sets ?? row.match_format?.best_of_sets);
  if ([3, 5].includes(explicitBestOf)) {
    return { id: explicitBestOf === 5 ? "bo5" : "bo3", best_of_sets: explicitBestOf };
  }
  const tour = String(row.tour ?? "").toUpperCase();
  if (tour === "ATP") return { id: "bo5", best_of_sets: 5 };
  if (tour === "WTA") return { id: "bo3", best_of_sets: 3 };
  return { id: "unknown", best_of_sets: null };
}

function grandSlamSetScoreDistribution({ winnerProbability, bestOfSets }) {
  const bands = bestOfSets === 5
    ? grandSlamBo5Distribution(winnerProbability)
    : grandSlamBo3Distribution(winnerProbability);
  return bands.map((item) => ({
    scoreline: item.scoreline,
    relative_probability: item.relative_probability,
    basis: "conditional_on_projected_winner",
  }));
}

function grandSlamBo5Distribution(probability) {
  if (probability >= 0.72) {
    return [
      { scoreline: "3-0", relative_probability: 0.48 },
      { scoreline: "3-1", relative_probability: 0.34 },
      { scoreline: "3-2", relative_probability: 0.18 },
    ];
  }
  if (probability >= 0.6) {
    return [
      { scoreline: "3-1", relative_probability: 0.42 },
      { scoreline: "3-0", relative_probability: 0.3 },
      { scoreline: "3-2", relative_probability: 0.28 },
    ];
  }
  return [
    { scoreline: "3-2", relative_probability: 0.46 },
    { scoreline: "3-1", relative_probability: 0.34 },
    { scoreline: "3-0", relative_probability: 0.2 },
  ];
}

function grandSlamBo3Distribution(probability) {
  if (probability >= 0.7) {
    return [
      { scoreline: "2-0", relative_probability: 0.58 },
      { scoreline: "2-1", relative_probability: 0.42 },
    ];
  }
  if (probability >= 0.58) {
    return [
      { scoreline: "2-1", relative_probability: 0.52 },
      { scoreline: "2-0", relative_probability: 0.48 },
    ];
  }
  return [
    { scoreline: "2-1", relative_probability: 0.65 },
    { scoreline: "2-0", relative_probability: 0.35 },
  ];
}

function grandSlamScorelineBlockedReasons(row, projection) {
  const reasons = [];
  if (!row.match_id) reasons.push("missing_match_id");
  if (!projection.probability_valid) reasons.push("missing_match_probability");
  if (!projection.best_of_sets) reasons.push("unknown_grand_slam_match_format");
  if (!row.player1?.id || !row.player2?.id) reasons.push("canonical_player_mapping_incomplete");
  if (!row.status) reasons.push("missing_score_state");
  return reasons;
}

function grandSlamScorelineWarnings(row) {
  const warnings = [];
  if (!grandSlamFreshScore(row)) warnings.push("score_state_not_fresh");
  if (!grandSlamFreshOdds(row)) warnings.push("odds_not_fresh_or_absent");
  if (!row.pulse?.signal) warnings.push("no_signal_row_attached");
  return warnings;
}

function grandSlamFreshScore(row) {
  const age = Number(row.freshness?.score_age_ms);
  if (!Number.isFinite(age)) return row.status === "scheduled";
  return age <= 30_000;
}

function grandSlamFreshOdds(row) {
  const age = Number(row.freshness?.odds_age_ms);
  if (!Number.isFinite(age)) return false;
  return age <= 15_000;
}

function grandSlamScorelineConfidence({ row, projection, blockedReasons, warnings }) {
  if (blockedReasons.length) return "Baixa";
  const modelConfidence = row.prediction?.confidence;
  if (modelConfidence) return modelConfidence;
  if (projection.winner_probability >= 0.68 && warnings.length <= 1) return "Alta";
  if (projection.winner_probability >= 0.58) return "Media";
  return "Baixa";
}

function grandSlamScorelineForecastStatus({ backend, report, grandSlam, forecasts }) {
  if (backend.status !== "ready" || report.safety?.real_execution_hard_block !== true) return "blocked";
  if (grandSlam.status === "blocked") return "blocked";
  if (grandSlam.status === "off_calendar") return "off_calendar";
  if (!forecasts.length) return "collecting";
  if (forecasts.some((row) => row.status === "forecast_ready")) {
    return grandSlam.paper_ready ? "paper_ready" : "forecast_ready";
  }
  return "collecting";
}

function grandSlamScorelineContract() {
  return {
    deterministic: true,
    prediction_unit: "set_scoreline_not_exact_game_score",
    model_source: "existing_fastapi_prediction_rows",
    bo5_scope: "ATP Grand Slam singles",
    bo3_scope: "WTA Grand Slam singles",
    bo5_outcomes: ["3-0", "3-1", "3-2"],
    bo3_outcomes: ["2-0", "2-1"],
    acceptance_gates: [
      "canonical_match_id",
      "canonical_player_mapping",
      "match_win_probability_present",
      "grand_slam_format_known",
      "score_state_present",
      "real_execution_hard_block",
    ],
    explicit_limits: [
      "does_not_predict_exact_game_scores",
      "does_not_call_live_provider_apis",
      "does_not_create_paper_orders",
      "does_not_submit_real_orders",
      "does_not_use_llm_per_tick",
    ],
  };
}

function grandSlamScorelineFeatureGaps() {
  return [
    {
      id: "point_by_point_state",
      impact: "highest_live_accuracy",
      unlock: "Markov point/game/set engine with current server, point score and tiebreak state.",
    },
    {
      id: "serve_return_priors",
      impact: "prematch_and_live_scoreline",
      unlock: "Surface-adjusted hold/break probability by player and opponent.",
    },
    {
      id: "odds_microstructure",
      impact: "market_confidence",
      unlock: "Line velocity, suspension timing, exchange depth and closing-line proxy.",
    },
    {
      id: "retirement_injury_hazard",
      impact: "risk_control",
      unlock: "Delay, medical timeout, retirement history and public injury-note integration.",
    },
    {
      id: "shot_by_shot_quality",
      impact: "enterprise_precision",
      unlock: "Serve quality, return depth, rally length, winners/errors and fatigue pressure.",
    },
  ];
}

function grandSlamScorelineNextAction({ status, grandSlam, liveWindowPlan }) {
  if (status === "blocked") {
    return grandSlamAction({
      id: "restore_operational_truth",
      command: "npm run api:check:operational-truth -- --pretty",
      reason: "Restore backend/safety gates before producing scoreline forecasts.",
    });
  }
  if (status === "off_calendar") {
    return grandSlamAction({
      id: "prepare_historical_priors",
      command: "npm --silent run hermes:historical-backfill-plan",
      reason: "No Grand Slam is active; improve future scoreline priors with licensed/offline historical data.",
    });
  }
  if (status === "collecting") {
    return grandSlamAction({
      id: "collect_grand_slam_prediction_rows",
      command: grandSlam.next_action?.command ?? "npm --silent run hermes:grand-slam-readiness",
      reason: "Wait for Grand Slam match rows with backend probabilities before scoreline forecasting.",
    });
  }
  if (status === "paper_ready") {
    return grandSlamAction({
      id: "observe_paper_ready_forecasts",
      command: liveWindowPlan.next_action?.command ?? "npm --silent run hermes:grand-slam-scoreline-forecast",
      reason: "Scoreline forecasts exist and paper gates are ready; only protected backend routes may create paper orders.",
    });
  }
  return grandSlamAction({
    id: "review_scoreline_forecasts",
    command: "npm --silent run hermes:grand-slam-scoreline-forecast",
    reason: "Review projected winners and set-score distributions from internal prediction rows.",
  });
}

function grandSlamScorelineForecastSummary(forecast) {
  return {
    status: forecast.status,
    total_grand_slam_rows: forecast.summary?.total_grand_slam_rows ?? 0,
    forecast_ready_rows: forecast.summary?.forecast_ready_rows ?? 0,
    blocked_rows: forecast.summary?.blocked_rows ?? 0,
    top_forecast: forecast.summary?.top_forecast ? {
      match_id: forecast.summary.top_forecast.match_id,
      projected_winner_name: forecast.summary.top_forecast.projected_winner_name,
      projected_scoreline: forecast.summary.top_forecast.projected_scoreline,
      winner_probability: forecast.summary.top_forecast.winner_probability,
      confidence: forecast.summary.top_forecast.confidence,
    } : null,
    next_action: forecast.next_action,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
  };
}

function buildGrandSlamMission({
  backend,
  report,
  eventPlan,
  liveStatsPlan,
  liveWindowPlan,
  pulse,
  collection,
  quota,
  sourceRoutes,
  historicalBackfill,
  grandSlam,
  scorelineForecast,
  learning,
  liveControllerPlan,
}) {
  const phase = grandSlamMissionPhase({ backend, grandSlam, liveWindowPlan, historicalBackfill });
  const phases = grandSlamMissionPhases({
    phase,
    backend,
    report,
    liveStatsPlan,
    liveWindowPlan,
    pulse,
    collection,
    quota,
    sourceRoutes,
    historicalBackfill,
    grandSlam,
    scorelineForecast,
    learning,
    liveControllerPlan,
  });
  const nextAction = grandSlamMissionNextAction({ phase, phases, grandSlam, historicalBackfill, liveControllerPlan });
  return {
    generated_at: new Date().toISOString(),
    mode: "grand_slam_mission",
    objective: "predict_and_monitor_grand_slam_matches_with_safe_hermes_autonomy",
    status: phase.status,
    active_phase: phase.id,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    mission_summary: [
      `grand_slam=${grandSlam.status}`,
      `backend=${backend.status}`,
      `live_window=${liveWindowPlan.status}`,
      `controller=${liveControllerPlan.status}`,
      `scoreline=${scorelineForecast.status}`,
      `historical_backfill=${historicalBackfill.status}`,
    ].join(" | "),
    next_action: nextAction,
    phases,
    grand_slam_readiness: {
      status: grandSlam.status,
      prediction_ready: grandSlam.prediction_ready,
      paper_ready: grandSlam.paper_ready,
      active_grand_slams: grandSlam.active_grand_slams,
      matches: grandSlam.matches,
      next_action: grandSlam.next_action,
    },
    grand_slam_scoreline_forecast: grandSlamScorelineForecastSummary(scorelineForecast),
    live_control: {
      status: liveControllerPlan.status,
      decision: liveControllerPlan.operator_decision,
      quota_throttle: quota.throttle,
      collection_status: collection.status,
      provider_command_count: collection.provider_commands.length,
      provider_commands_allowed: false,
    },
    historical_backfill: {
      status: historicalBackfill.status,
      next_source: historicalBackfill.next_source,
      review_summary: historicalBackfill.review_summary,
      license_gates: historicalBackfill.gates,
    },
    learning_review: {
      status: learning.review_status,
      metrics: learning.metrics,
      next_actions: learning.next_actions,
      real_execution_recommendation: learning.real_execution_recommendation,
    },
    evidence_contract: grandSlamMissionEvidenceContract(),
    safe_jailbreak_policy: {
      meaning: "Use Hermes to route around missing coverage with allowed internal, replay, licensed and historical-offline paths only.",
      allowed_paths: [
        "internal_fastapi_packets",
        "persisted_postgres_replay",
        "historical_public_backfill_after_license_review",
        "licensed_provider_api_after_operator_smoke",
        "manual_operator_notes_with_sources",
      ],
      bypass_allowed: false,
      live_scraping_allowed: false,
      sportsbook_browser_automation_allowed: false,
      credential_or_session_extraction_allowed: false,
      llm_per_tick_allowed: false,
    },
    forbidden_actions: [
      ...(report.forbidden_collection_paths ?? []),
      "grand_slam_live_scoreboard_scraping",
      "sportsbook_ui_automation",
      "provider_quota_spend_without_operator",
      "paper_order_creation_from_mission_packet",
      "real_money_execution",
    ],
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block === true
        && backend.safety?.real_execution_hard_block === true,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
    events: eventPlan.events.map((event) => ({
      type: event.type,
      severity: event.severity,
      allowed_command: event.allowed_command,
      can_create_orders: event.can_create_orders,
    })),
  };
}

function grandSlamMissionPhase({ backend, grandSlam, liveWindowPlan, historicalBackfill }) {
  if (backend.status !== "ready" || grandSlam.status === "blocked") {
    return {
      id: "restore_operational_truth",
      status: "blocked",
      reason: "Backend or Grand Slam readiness is blocked; restore internal operational truth before prediction work.",
    };
  }
  if (grandSlam.status === "off_calendar") {
    return {
      id: "offline_backfill",
      status: historicalBackfill.status === "ready" ? "ready" : "blocked",
      reason: "No active Grand Slam; maximize future accuracy with offline priors, backtests and license-reviewed data.",
    };
  }
  if (grandSlam.status === "waiting_for_draw_or_feed") {
    return {
      id: "feed_visibility",
      status: "monitor",
      reason: "Grand Slam window is open but canonical match rows are not visible yet.",
    };
  }
  if (grandSlam.status === "monitor") {
    return {
      id: "model_input_gap",
      status: "monitor",
      reason: "Grand Slam rows are visible but model probability rows are missing or incomplete.",
    };
  }
  if (grandSlam.status === "prediction_ready" && liveWindowPlan.status !== "paper_ready") {
    return {
      id: "prediction_watch",
      status: "ready",
      reason: "Grand Slam predictions exist; keep monitoring gates until paper/live-window readiness improves.",
    };
  }
  if (grandSlam.status === "paper_ready") {
    return {
      id: "paper_learning",
      status: "ready",
      reason: "Grand Slam predictions are paper-ready; protected backend routes control any paper order creation.",
    };
  }
  return {
    id: "observe",
    status: "monitor",
    reason: "No higher-autonomy Grand Slam mission phase is justified.",
  };
}

function grandSlamMissionPhases({
  phase,
  backend,
  report,
  liveStatsPlan,
  liveWindowPlan,
  pulse,
  collection,
  quota,
  sourceRoutes,
  historicalBackfill,
  grandSlam,
  scorelineForecast,
  learning,
  liveControllerPlan,
}) {
  return [
    grandSlamMissionPhaseRow({
      id: "operational_truth",
      status: backend.status === "ready" ? "pass" : "blocked",
      command: backend.next_action?.command ?? "npm --silent run hermes:backend-readiness",
      reason: "Internal FastAPI/Postgres evidence must be reachable before match-day predictions.",
      evidence: [
        `backend=${backend.status}`,
        `provider_mode=${report.data_snapshot?.provider_mode ?? "unknown"}`,
        `persisted_matches=${report.data_snapshot?.persisted_matches ?? 0}`,
      ],
      blockers: (backend.checks ?? []).filter((check) => check.status === "fail").map((check) => check.id),
      active: phase.id === "restore_operational_truth",
    }),
    grandSlamMissionPhaseRow({
      id: "historical_priors",
      status: historicalBackfill.status === "ready" ? "pass" : "monitor",
      command: "npm --silent run hermes:historical-backfill-plan",
      reason: "Offline historical sources improve priors and backtests without live scraping.",
      evidence: [
        `sources=${historicalBackfill.review_summary?.total_sources ?? 0}`,
        `license_review_required=${historicalBackfill.review_summary?.license_review_required ?? 0}`,
        `next_source=${historicalBackfill.next_source?.id ?? "none"}`,
      ],
      blockers: historicalBackfill.gates?.filter((gate) => gate.status === "fail").map((gate) => gate.id) ?? [],
      active: phase.id === "offline_backfill",
    }),
    grandSlamMissionPhaseRow({
      id: "grand_slam_visibility",
      status: grandSlam.matches?.grand_slam_visible > 0 ? "pass" : grandSlam.active_grand_slams?.length ? "monitor" : "waiting",
      command: "npm --silent run hermes:grand-slam-readiness",
      reason: "Grand Slam window and canonical match visibility determine whether today's score prediction mission can run.",
      evidence: [
        `active_slams=${grandSlam.active_grand_slams?.length ?? 0}`,
        `visible_matches=${grandSlam.matches?.grand_slam_visible ?? 0}`,
        `prediction_rows=${grandSlam.matches?.prediction_rows ?? 0}`,
      ],
      blockers: grandSlam.blockers ?? [],
      active: ["feed_visibility", "model_input_gap", "prediction_watch", "paper_learning"].includes(phase.id),
    }),
    grandSlamMissionPhaseRow({
      id: "live_collection_control",
      status: ["paper_ready", "live_watch", "throttled"].includes(liveControllerPlan.status) ? "pass" : liveControllerPlan.status,
      command: liveControllerPlan.operator_decision?.next_safe_command?.command ?? "npm --silent run hermes:live-controller",
      reason: "Collection and quota decisions stay event-driven and operator-gated.",
      evidence: [
        `live_window=${liveWindowPlan.status}`,
        `collection=${collection.status}`,
        `quota=${quota.throttle?.level ?? "unknown"}`,
        `pulse_matches=${pulse.matches_seen ?? 0}`,
      ],
      blockers: liveWindowPlan.blockers ?? [],
      active: ["model_input_gap", "prediction_watch", "paper_learning"].includes(phase.id),
    }),
    grandSlamMissionPhaseRow({
      id: "prediction_quality",
      status: grandSlam.prediction_ready ? "pass" : "monitor",
      command: grandSlam.prediction_ready ? "npm --silent run hermes:grand-slam-readiness" : "npm --silent run hermes:match-pulse",
      reason: "Backend model probability rows must exist before Hermes can supervise match-day predictions.",
      evidence: [
        `prediction_ready=${grandSlam.prediction_ready}`,
        `paper_candidates=${grandSlam.matches?.paper_candidates ?? 0}`,
        `health_scores=${JSON.stringify(liveStatsPlan.health_scores ?? {})}`,
      ],
      active: ["prediction_watch", "paper_learning"].includes(phase.id),
    }),
    grandSlamMissionPhaseRow({
      id: "scoreline_forecast",
      status: ["forecast_ready", "paper_ready"].includes(scorelineForecast.status)
        ? "pass"
        : scorelineForecast.status === "blocked"
          ? "blocked"
          : "monitor",
      command: "npm --silent run hermes:grand-slam-scoreline-forecast",
      reason: "Hermes should expose deterministic set-scoreline projections only after backend probability rows exist.",
      evidence: [
        `scoreline_status=${scorelineForecast.status}`,
        `forecast_ready_rows=${scorelineForecast.summary?.forecast_ready_rows ?? 0}`,
        `blocked_rows=${scorelineForecast.summary?.blocked_rows ?? 0}`,
        `top_scoreline=${scorelineForecast.summary?.top_forecast?.projected_scoreline ?? "none"}`,
      ],
      blockers: scorelineForecast.blockers ?? [],
      active: ["prediction_watch", "paper_learning"].includes(phase.id),
    }),
    grandSlamMissionPhaseRow({
      id: "paper_learning",
      status: grandSlam.paper_ready ? "pass" : "locked",
      command: grandSlam.paper_ready ? "npm run hermes:autopilot" : "npm --silent run hermes:learning-review",
      reason: "Paper learning starts only when Grand Slam rows are paper-ready and backend protected routes approve.",
      evidence: [
        `paper_ready=${grandSlam.paper_ready}`,
        `learning_status=${learning.review_status ?? "unknown"}`,
        `settled_orders=${learning.metrics?.settled_orders ?? 0}`,
      ],
      blockers: grandSlam.paper_ready ? [] : ["grand_slam_not_paper_ready"],
      requiresAdminToken: grandSlam.paper_ready,
      canCreatePaperOrders: grandSlam.paper_ready,
      active: phase.id === "paper_learning",
    }),
    grandSlamMissionPhaseRow({
      id: "enterprise_review",
      status: report.budget_chain_snapshot?.enterprise_eligible ? "pass" : "locked",
      command: "npm run api:check:operational-truth -- --pretty",
      reason: "Enterprise/no-budget feeds remain locked until budget chain evidence proves readiness.",
      evidence: [
        `budget_chain_completed=${Boolean(report.budget_chain_snapshot?.budget_chain_completed)}`,
        `enterprise_eligible=${Boolean(report.budget_chain_snapshot?.enterprise_eligible)}`,
        `source_next_route=${sourceRoutes.next_route?.id ?? "none"}`,
      ],
      blockers: report.budget_chain_snapshot?.enterprise_eligible ? [] : ["budget_chain_not_enterprise_eligible"],
    }),
  ];
}

function grandSlamMissionPhaseRow({
  id,
  status,
  command,
  reason,
  evidence,
  blockers = [],
  requiresAdminToken = false,
  canCreatePaperOrders = false,
  active = false,
}) {
  return {
    id,
    status,
    active: Boolean(active),
    command,
    reason,
    evidence,
    blockers,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    requires_admin_token: Boolean(requiresAdminToken),
    can_create_paper_orders: Boolean(canCreatePaperOrders),
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function grandSlamMissionNextAction({ phase, phases, grandSlam, historicalBackfill, liveControllerPlan }) {
  if (phase.id === "offline_backfill") {
    return {
      ...missionActionFromPhase(phases.find((item) => item.id === "historical_priors")),
      source_id: historicalBackfill.next_source?.id ?? null,
    };
  }
  if (phase.id === "paper_learning") {
    return missionActionFromPhase(phases.find((item) => item.id === "paper_learning"));
  }
  if (phase.id === "prediction_watch") {
    return missionActionFromPhase(phases.find((item) => item.id === "live_collection_control"));
  }
  if (phase.id === "model_input_gap") {
    return missionActionFromPhase(phases.find((item) => item.id === "prediction_quality"));
  }
  if (phase.id === "feed_visibility") {
    return missionActionFromPhase(phases.find((item) => item.id === "grand_slam_visibility"));
  }
  if (phase.id === "restore_operational_truth") {
    return missionActionFromPhase(phases.find((item) => item.id === "operational_truth"));
  }
  return {
    id: grandSlam.next_action?.id ?? liveControllerPlan.operator_decision?.action ?? "observe",
    command: grandSlam.next_action?.command
      ?? liveControllerPlan.operator_decision?.next_safe_command?.command
      ?? "npm --silent run hermes:grand-slam-readiness",
    reason: phase.reason,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function missionActionFromPhase(phase) {
  return {
    id: phase?.id ?? "observe",
    command: phase?.command ?? "npm --silent run hermes:grand-slam-mission",
    reason: phase?.reason ?? "Observe Grand Slam mission state.",
    requires_admin_token: Boolean(phase?.requires_admin_token),
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function grandSlamMissionEvidenceContract() {
  return [
    {
      id: "match_day_prediction",
      proof: ["grand_slam_visible>0", "prediction_rows>0", "backend_ready", "fresh_score_and_odds_gates"],
    },
    {
      id: "live_collection",
      proof: ["live_window_not_safety_stop", "quota_not_blocked", "provider_commands_operator_only"],
    },
    {
      id: "offline_accuracy",
      proof: ["historical_sources_ranked", "license_review_queue_visible", "source_manifest_before_import"],
    },
    {
      id: "learning_loop",
      proof: ["paper_ready_before_autopilot", "settled_paper_examples", "roi_clv_calibration_review"],
    },
    {
      id: "safety",
      proof: ["real_execution_hard_block=true", "no_scraping", "no_provider_quota_spend_from_mission", "no_llm_per_tick"],
    },
  ];
}

function buildExperimentLab({ loop, report, eventPlan, sourcePlan, capabilityAuditPlan, gates, backlogPlan }) {
  const experiments = buildExperimentRows({
    loop,
    report,
    eventPlan,
    sourcePlan,
    capabilityAuditPlan,
    gates,
    backlogPlan,
  })
    .sort((a, b) => b.priority_score - a.priority_score || a.id.localeCompare(b.id));
  return {
    generated_at: new Date().toISOString(),
    mode: "experiment_lab",
    research_question: "What is the maximum safe Hermes ROI/CLV leverage under budget-first constraints?",
    status: experiments.some((experiment) => experiment.status === "ready") ? "ready" : "blocked",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    active_ceiling: gates.active_ceiling,
    next_required_gate: gates.next_required_gate,
    backlog_guidance: {
      status: backlogPlan.status,
      next_item_id: backlogPlan.next_item?.id ?? null,
      next_item_title: backlogPlan.next_item?.title ?? null,
      next_item_source: backlogPlan.next_item?.source ?? [],
      total_items: backlogPlan.items.length,
    },
    next_experiment: experiments.find((experiment) => experiment.status === "ready") ?? experiments[0] ?? null,
    experiments,
    blocked_routes: gates.blocked_routes,
    safe_jailbreak_policy: sourcePlan.safe_jailbreak_policy,
    safety: {
      real_execution_hard_block: loop.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      provider_api_call_allowed: false,
      can_create_paper_orders: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function buildExperimentRows({ loop, report, eventPlan, sourcePlan, capabilityAuditPlan, gates, backlogPlan }) {
  const gateById = Object.fromEntries((gates.gates ?? []).map((gate) => [gate.id, gate]));
  const runtimeReady = gateById.channel_ready?.status === "pass";
  const cronReady = gateById.cron_ready?.status === "pass";
  const paperReady = gateById.paper_ready?.status === "pass";
  const learningReady = gateById.learning_ready?.status === "pass";
  const enterpriseEligible = gateById.enterprise_review?.status === "pass";
  const replayOrPersisted = Number(report.data_snapshot?.persisted_matches ?? 0) > 0
    || report.data_snapshot?.provider_mode === "replay";
  const rows = [
    experimentRow({
      id: "runtime_channel_recovery",
      title: "Recover local Hermes runtime and channel confidence",
      status: runtimeReady ? "complete" : "ready",
      priorityScore: runtimeReady ? 20 : 95,
      command: "npm run hermes:runtime-fix-plan",
      hypothesis: "Fixing gateway/doctor/channel prerequisites increases safe autonomy faster than model changes.",
      prerequisites: ["real_execution_hard_block", "safe_jailbreak_policy"],
      successMetrics: ["gateway_service_status", "doctor_status", "activation_allowed"],
      evidence: [
        `runtime_status=${loop.runtime?.status ?? "unknown"}`,
        `gateway=${loop.runtime?.runtime_findings?.gateway_service_status ?? "unknown"}`,
        `doctor=${loop.runtime?.runtime_findings?.doctor_status ?? "unknown"}`,
      ],
    }),
    experimentRow({
      id: "source_discovery_backfill",
      title: "Find allowed low-cost data backfill routes",
      status: sourcePlan.safe_jailbreak_policy?.bypass_allowed === false ? "ready" : "blocked",
      priorityScore: replayOrPersisted ? 65 : 90,
      command: "npm --silent run hermes:historical-backfill-plan",
      hypothesis: "Allowed API/replay/operator-note routes can improve data density without scraping, bypass, or paid quota spend.",
      prerequisites: ["licensed_or_internal_sources_only"],
      successMetrics: ["historical_sources_ranked", "license_review_queue", "persisted_matches"],
      evidence: [
        `discovery_scope=${(sourcePlan.discovery_scope ?? []).join(",")}`,
        `persisted_matches=${report.data_snapshot?.persisted_matches ?? 0}`,
      ],
    }),
    experimentRow({
      id: "live_collection_cadence",
      title: "Tune live collection cadence from match pulse and quota",
      status: runtimeReady && replayOrPersisted ? "ready" : "blocked",
      priorityScore: runtimeReady ? 82 : 55,
      command: "npm --silent run hermes:collection-plan",
      hypothesis: "Event-driven collection around high-attention matches improves freshness while reducing unnecessary calls.",
      prerequisites: ["runtime_ready", "persisted_or_replay_state"],
      successMetrics: ["effective_target_count", "odds_age_ms", "score_age_ms", "quota_budget_utilization"],
      evidence: [
        `collection_status=${loop.live_stats?.collection_status ?? "unknown"}`,
        `throttle_level=${loop.quota_plan?.throttle_level ?? "unknown"}`,
        `provider_commands=${loop.quota_plan?.provider_command_count ?? 0}`,
      ],
    }),
    experimentRow({
      id: "paper_autopilot_rehearsal",
      title: "Run protected paper-autopilot rehearsal when backend gates allow it",
      status: paperReady ? "ready" : "blocked",
      priorityScore: paperReady ? 100 : 45,
      command: "npm run hermes:autopilot",
      hypothesis: "Creating only backend-approved paper orders is the highest-value learning loop once runtime and signal gates are clean.",
      prerequisites: ["paper_ready", "admin_token", "backend_signal_gates"],
      successMetrics: ["paper_orders_created", "paper_orders_skipped", "clv", "pnl", "training_examples_ready"],
      evidence: [
        `event_can_run_paper_autopilot=${eventPlan.can_run_paper_autopilot}`,
        `entry_signals=${report.signal_snapshot?.entry_signals ?? 0}`,
        `active_ceiling=${gates.active_ceiling?.id ?? "unknown"}`,
      ],
      requiresAdminToken: true,
    }),
    experimentRow({
      id: "learning_review_readiness",
      title: "Measure whether paper evidence is ready for learning review",
      status: learningReady ? "ready" : "blocked",
      priorityScore: learningReady ? 88 : 50,
      command: "npm --silent run hermes:learning-review",
      hypothesis: "Model/staking changes should be reviewed only after enough settled paper examples prove ROI, CLV, calibration and drawdown.",
      prerequisites: ["settled_paper_examples", "training_examples"],
      successMetrics: ["roi", "clv", "brier", "log_loss", "max_drawdown"],
      evidence: [
        `review_status=${loop.learning_review?.review_status ?? "unknown"}`,
        `capability_status=${capabilityAuditPlan.status}`,
      ],
    }),
    experimentRow({
      id: "enterprise_accuracy_stack_review",
      title: "Review no-budget provider stack for Grand Slam scoreline accuracy",
      status: enterpriseEligible ? "ready" : "locked",
      priorityScore: enterpriseEligible ? 86 : 30,
      command: "npm --silent run hermes:enterprise-accuracy-plan",
      hypothesis: "Top-tier official score, point-by-point, shot-by-shot and market feeds should be contracted only after budget evidence proves readiness.",
      prerequisites: ["enterprise_eligible", "operator_contract_review", "safe_jailbreak_policy"],
      successMetrics: ["provider_stack_ranked", "scoreline_contract_visible", "access_requirements_visible", "provider_api_call_allowed_false"],
      evidence: [
        `enterprise_eligible=${loop.budget_chain?.enterprise_eligible}`,
        `budget_chain_completed=${loop.budget_chain?.completed}`,
        `source_next_route=${sourcePlan.next_safe_command?.command ?? "unknown"}`,
      ],
    }),
    experimentRow({
      id: "enterprise_eligibility_review",
      title: "Keep enterprise review behind complete budget evidence",
      status: enterpriseEligible ? "ready" : "locked",
      priorityScore: enterpriseEligible ? 70 : 15,
      command: "npm run api:check:operational-truth -- --pretty",
      hypothesis: "Enterprise spend should start only after budget replay, smokes and healthy cursor evidence are complete.",
      prerequisites: ["budget_chain_completed", "healthy_odds_cursor", "provider_smokes"],
      successMetrics: ["budget_chain_completed", "enterprise_eligible", "resync_required"],
      evidence: [
        `budget_chain_completed=${loop.budget_chain?.completed}`,
        `enterprise_eligible=${loop.budget_chain?.enterprise_eligible}`,
        `current_step=${loop.budget_chain?.current_step_label ?? "none"}`,
      ],
    }),
  ];
  const backlogExperiment = experimentFromBacklogGuidance(backlogPlan);
  return backlogExperiment ? [backlogExperiment, ...rows] : rows;
}

function experimentFromBacklogGuidance(backlogPlan) {
  const nextItem = backlogPlan.next_item;
  if (nextItem?.id === "harden_live_controller_feedback_loop") {
    return experimentRow({
      id: "live_controller_feedback_loop",
      title: "Convert repeated live-controller decisions into safer collection work",
      status: "ready",
      priorityScore: Math.min(100, 92 + Number(nextItem.frequency ?? 0) * 4),
      command: "npm --silent run hermes:backlog-plan",
      hypothesis: "Using observed live-controller ledger patterns should improve collection cadence and data-quality work without granting execution authority.",
      prerequisites: ["live_controller_ledger", "backlog_plan", "provider_commands_not_executed"],
      successMetrics: ["top_repeated_action", "throttle_counts", "provider_command_executed_count", "paper_order_created_count"],
      evidence: [
        `backlog_next_item=${nextItem.id}`,
        `frequency=${nextItem.frequency ?? 0}`,
        `source=${(nextItem.source ?? []).join(",")}`,
      ],
    });
  }
  if (nextItem?.id === "harden_source_route_feedback_loop") {
    return experimentRow({
      id: "source_route_feedback_loop",
      title: "Convert repeated source-route decisions into safer collection work",
      status: "ready",
      priorityScore: Math.min(100, 90 + Number(nextItem.frequency ?? 0) * 4),
      command: "npm --silent run hermes:source-route-ledger-report",
      hypothesis: "Using observed source-route patterns should improve collection/backfill work without provider quota spend, scraping or bypass.",
      prerequisites: ["source_route_ledger", "backlog_plan", "route_commands_not_executed"],
      successMetrics: ["top_next_route", "blocked_route_counts", "provider_command_executed_count", "bypass_attempted_count"],
      evidence: [
        `backlog_next_item=${nextItem.id}`,
        `frequency=${nextItem.frequency ?? 0}`,
        `source=${(nextItem.source ?? []).join(",")}`,
      ],
    });
  }
  if (nextItem?.id === "harden_source_use_feedback_loop") {
    return experimentRow({
      id: "source_use_feedback_loop",
      title: "Convert repeated source-use blockers into safer collection/import work",
      status: "ready",
      priorityScore: Math.min(100, 91 + Number(nextItem.frequency ?? 0) * 4),
      command: "npm --silent run hermes:source-use-ledger-report",
      hypothesis: "Using observed source-use decisions should reveal which licenses, deferred providers or forbidden routes block collection work before any provider call or import is added.",
      prerequisites: ["source_use_ledger", "backlog_plan", "manifest_provider_and_bypass_counters_zero"],
      successMetrics: ["top_operator_required_source", "top_deferred_source", "top_forbidden_source", "provider_command_executed_count", "bypass_attempted_count"],
      evidence: [
        `backlog_next_item=${nextItem.id}`,
        `frequency=${nextItem.frequency ?? 0}`,
        `source=${(nextItem.source ?? []).join(",")}`,
      ],
    });
  }
  if (nextItem?.id === "harden_source_intake_feedback_loop") {
    return experimentRow({
      id: "source_intake_feedback_loop",
      title: "Convert repeated source-intake queues into offline contract work",
      status: "ready",
      priorityScore: Math.min(100, 89 + Number(nextItem.frequency ?? 0) * 4),
      command: "npm --silent run hermes:source-intake-ledger-report",
      hypothesis: "Using observed intake queues should identify the next allowed offline/internal contract while keeping operator-review, deferred and forbidden sources out of execution.",
      prerequisites: ["source_intake_ledger", "source_intake_plan", "dataset_fetch_not_attempted"],
      successMetrics: ["top_allowed_contract", "top_operator_review", "top_deferred", "dataset_fetch_attempted_count", "provider_command_executed_count"],
      evidence: [
        `backlog_next_item=${nextItem.id}`,
        `frequency=${nextItem.frequency ?? 0}`,
        `source=${(nextItem.source ?? []).join(",")}`,
      ],
    });
  }
  return null;
}

function experimentRow({
  id,
  title,
  status,
  priorityScore,
  command,
  hypothesis,
  prerequisites,
  successMetrics,
  evidence,
  requiresAdminToken = false,
}) {
  return {
    id,
    title,
    status,
    priority_score: clampScore(priorityScore),
    command,
    hypothesis,
    prerequisites,
    success_metrics: successMetrics,
    evidence,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    requires_admin_token: Boolean(requiresAdminToken),
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
  };
}

function buildExperimentLedger(lab) {
  const path = experimentLedgerPath();
  const record = {
    generated_at: new Date().toISOString(),
    mode: "experiment_ledger_record",
    lab,
    outcome: "observed",
    action_executed: false,
    experiment_command_executed: false,
    active_ceiling_id: lab.active_ceiling?.id ?? null,
    next_experiment_id: lab.next_experiment?.id ?? null,
    next_experiment_command: lab.next_experiment?.command ?? null,
    ready_experiment_ids: (lab.experiments ?? [])
      .filter((experiment) => experiment.status === "ready")
      .map((experiment) => experiment.id),
    safety: lab.safety,
  };
  return {
    generated_at: new Date().toISOString(),
    mode: "experiment_ledger",
    status: lab.status,
    read_only: false,
    writes: true,
    write_scope: "local_experiment_jsonl_only",
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    executed_commands: [],
    ledger: {
      path,
      format: "jsonl",
      retention_note: "Local Hermes experiment trace; do not commit runtime logs.",
    },
    record,
    safety: {
      real_execution_hard_block: lab.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
    },
  };
}

function experimentLedgerPath() {
  return process.env.HERMES_EXPERIMENT_LEDGER_PATH || "hermes/runs/experiment-ledger.jsonl";
}

function writeExperimentLedger(record) {
  const path = experimentLedgerPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

function readExperimentLedgerRecords() {
  const path = experimentLedgerPath();
  if (!existsSync(path)) {
    return { path, records: [], invalid_rows: 0 };
  }
  const content = readFileSync(path, "utf8");
  let invalidRows = 0;
  const records = content
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        invalidRows += 1;
        return [];
      }
    });
  return { path, records, invalid_rows: invalidRows };
}

function buildExperimentLedgerReport({ path, records, invalid_rows: invalidRows }) {
  const nextExperimentCounts = rankedCounts(records.map((record) => record.next_experiment_id).filter(Boolean));
  return {
    generated_at: new Date().toISOString(),
    mode: "experiment_ledger_report",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    ledger: {
      path,
      format: "jsonl",
      invalid_rows: invalidRows,
    },
    total_records: records.length,
    action_executed_count: records.filter((record) => record.action_executed === true).length,
    experiment_command_executed_count: records.filter((record) => record.experiment_command_executed === true).length,
    status_counts: countValues(records.map((record) => record.lab?.status).filter(Boolean)),
    active_ceiling_counts: countValues(records.map((record) => record.active_ceiling_id).filter(Boolean)),
    ready_experiment_counts: countValues(records.flatMap((record) => record.ready_experiment_ids ?? [])),
    next_experiment_counts: nextExperimentCounts,
    next_experiment_command_counts: rankedCounts(records.map((record) => record.next_experiment_command).filter(Boolean)),
    top_experiment: nextExperimentCounts[0]?.command ?? null,
    safety: {
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
    },
  };
}

function buildBacklogPlan({
  experimentReport,
  operatorReport,
  missionReport,
  liveControllerReport,
  grandSlamMissionReport,
  sourceRouteReport = emptySourceRouteLedgerReport(),
  sourceUseReport = emptySourceUseLedgerReport(),
  sourceIntakeReport = emptySourceIntakeLedgerReport(),
  runtimePriorities,
}) {
  const items = buildBacklogItems({
    experimentReport,
    operatorReport,
    missionReport,
    liveControllerReport,
    grandSlamMissionReport,
    sourceRouteReport,
    sourceUseReport,
    sourceIntakeReport,
    runtimePriorities,
  })
    .sort((a, b) => a.priority - b.priority || b.frequency - a.frequency || a.id.localeCompare(b.id));
  return {
    generated_at: new Date().toISOString(),
    mode: "backlog_plan",
    status: items.length ? "ready" : "collecting",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    next_item: items[0] ?? null,
    items,
    evidence: {
      experiment_ledger: {
        path: experimentReport.ledger?.path,
        total_records: experimentReport.total_records,
        top_experiment: experimentReport.top_experiment,
        active_ceiling_counts: experimentReport.active_ceiling_counts,
        ready_experiment_counts: experimentReport.ready_experiment_counts,
        experiment_command_executed_count: experimentReport.experiment_command_executed_count,
      },
      operator_ledger: {
        path: operatorReport.ledger?.path,
        total_records: operatorReport.total_records,
        top_blocker: operatorReport.top_blocker,
        priority_counts: operatorReport.priority_counts,
        action_executed_count: operatorReport.action_executed_count,
      },
      mission_ledger: {
        path: missionReport.ledger?.path,
        total_records: missionReport.total_records,
        top_next_action: missionReport.top_next_action,
        active_ceiling_counts: missionReport.active_ceiling_counts,
        blocked_lane_counts: missionReport.blocked_lane_counts,
        mission_command_executed_count: missionReport.mission_command_executed_count,
      },
      live_controller_ledger: {
        path: liveControllerReport.ledger?.path,
        total_records: liveControllerReport.total_records,
        top_repeated_action: liveControllerReport.top_repeated_action,
        top_next_safe_command: liveControllerReport.top_next_safe_command,
        top_provider_candidate: liveControllerReport.top_provider_candidate,
        action_counts: liveControllerReport.action_counts,
        throttle_counts: liveControllerReport.throttle_counts,
        provider_command_executed_count: liveControllerReport.provider_command_executed_count,
        paper_order_created_count: liveControllerReport.paper_order_created_count,
      },
      grand_slam_mission_ledger: {
        path: grandSlamMissionReport.ledger?.path,
        total_records: grandSlamMissionReport.total_records,
        top_active_phase: grandSlamMissionReport.top_active_phase,
        top_next_action: grandSlamMissionReport.top_next_action,
        active_phase_counts: grandSlamMissionReport.active_phase_counts,
        grand_slam_status_counts: grandSlamMissionReport.grand_slam_status_counts,
        mission_command_executed_count: grandSlamMissionReport.mission_command_executed_count,
        provider_command_executed_count: grandSlamMissionReport.provider_command_executed_count,
        paper_order_created_count: grandSlamMissionReport.paper_order_created_count,
      },
      source_route_ledger: {
        path: sourceRouteReport.ledger?.path,
        total_records: sourceRouteReport.total_records,
        top_next_route: sourceRouteReport.top_next_route,
        top_next_command: sourceRouteReport.top_next_command,
        next_route_counts: sourceRouteReport.next_route_counts,
        blocked_route_counts: sourceRouteReport.blocked_route_counts,
        operator_required_route_counts: sourceRouteReport.operator_required_route_counts,
        route_command_executed_count: sourceRouteReport.route_command_executed_count,
        provider_command_executed_count: sourceRouteReport.provider_command_executed_count,
        bypass_attempted_count: sourceRouteReport.bypass_attempted_count,
      },
      source_use_ledger: {
        path: sourceUseReport.ledger?.path,
        total_records: sourceUseReport.total_records,
        top_next_action: sourceUseReport.top_next_action,
        top_operator_required_source: sourceUseReport.top_operator_required_source,
        top_deferred_source: sourceUseReport.top_deferred_source,
        top_forbidden_source: sourceUseReport.top_forbidden_source,
        decision_counts: sourceUseReport.decision_counts,
        operator_required_source_counts: sourceUseReport.operator_required_source_counts,
        deferred_source_counts: sourceUseReport.deferred_source_counts,
        forbidden_source_counts: sourceUseReport.forbidden_source_counts,
        license_review_source_counts: sourceUseReport.license_review_source_counts,
        manifest_command_executed_count: sourceUseReport.manifest_command_executed_count,
        provider_command_executed_count: sourceUseReport.provider_command_executed_count,
        bypass_attempted_count: sourceUseReport.bypass_attempted_count,
      },
      source_intake_ledger: {
        path: sourceIntakeReport.ledger?.path,
        total_records: sourceIntakeReport.total_records,
        top_next_intake: sourceIntakeReport.top_next_intake,
        top_next_intake_lane: sourceIntakeReport.top_next_intake_lane,
        top_next_intake_command: sourceIntakeReport.top_next_intake_command,
        top_allowed_contract: sourceIntakeReport.top_allowed_contract,
        top_operator_review: sourceIntakeReport.top_operator_review,
        top_deferred: sourceIntakeReport.top_deferred,
        top_forbidden_quarantine: sourceIntakeReport.top_forbidden_quarantine,
        allowed_contract_counts: sourceIntakeReport.allowed_contract_counts,
        operator_review_counts: sourceIntakeReport.operator_review_counts,
        deferred_counts: sourceIntakeReport.deferred_counts,
        forbidden_quarantine_counts: sourceIntakeReport.forbidden_quarantine_counts,
        intake_command_executed_count: sourceIntakeReport.intake_command_executed_count,
        dataset_fetch_attempted_count: sourceIntakeReport.dataset_fetch_attempted_count,
        provider_command_executed_count: sourceIntakeReport.provider_command_executed_count,
        bypass_attempted_count: sourceIntakeReport.bypass_attempted_count,
      },
      runtime_priorities: {
        next_priority: runtimePriorities.next_priority,
        total_priorities: runtimePriorities.priorities.length,
      },
    },
    safety: {
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
    },
  };
}

function emptySourceRouteLedgerReport() {
  return buildSourceRouteLedgerReport({ path: sourceRouteLedgerPath(), records: [], invalid_rows: 0 });
}

function emptySourceUseLedgerReport() {
  return buildSourceUseLedgerReport({ path: sourceUseLedgerPath(), records: [], invalid_rows: 0 });
}

function emptySourceIntakeLedgerReport() {
  return buildSourceIntakeLedgerReport({ path: sourceIntakeLedgerPath(), records: [], invalid_rows: 0 });
}

function buildBacklogPlanWithEnterpriseReadiness(backlogPlan, enterpriseReadiness) {
  if (!enterpriseReadiness) return backlogPlan;
  const evidence = {
    ...backlogPlan.evidence,
    enterprise_readiness: enterpriseReadinessSummary(enterpriseReadiness),
  };
  if (enterpriseReadiness.status !== "blocked_by_backend_evidence") {
    return { ...backlogPlan, evidence, enterprise_readiness: enterpriseReadinessSummary(enterpriseReadiness) };
  }
  const items = dedupeBacklogItems([
    enterpriseBackendEvidenceBacklogItem(enterpriseReadiness),
    ...backlogPlan.items,
  ]).sort((a, b) => a.priority - b.priority || b.frequency - a.frequency || a.id.localeCompare(b.id));
  return {
    ...backlogPlan,
    status: "ready",
    next_item: items[0] ?? null,
    items,
    evidence,
    enterprise_readiness: enterpriseReadinessSummary(enterpriseReadiness),
  };
}

function buildBacklogPlanWithChannelReadiness(backlogPlan, channel) {
  if (!channel) return backlogPlan;
  const evidence = {
    ...backlogPlan.evidence,
    channel_readiness: channelReadinessSummary(channel),
  };
  const shouldRouteChannelSecrets = backlogPlan.next_item?.id === "stabilize_hermes_runtime_channels"
    && channel.checks?.some((check) => check.id === "doctor_passed" && check.status === "pass")
    && channel.actions?.some((action) => [
      "configure_telegram_allowlist",
      "configure_private_access_allowlist",
      "configure_local_admin_token",
    ].includes(action.id));
  if (!shouldRouteChannelSecrets) {
    return { ...backlogPlan, evidence, channel_readiness: channelReadinessSummary(channel) };
  }
  const items = dedupeBacklogItems([
    channelOperatorSecretsBacklogItem(channel),
    ...backlogPlan.items.filter((item) => item.id !== "stabilize_hermes_runtime_channels"),
  ]).sort((a, b) => a.priority - b.priority || b.frequency - a.frequency || a.id.localeCompare(b.id));
  return {
    ...backlogPlan,
    status: "ready",
    next_item: items[0] ?? null,
    items,
    evidence,
    channel_readiness: channelReadinessSummary(channel),
  };
}

function channelReadinessSummary(channel) {
  if (!channel) return null;
  return {
    status: channel.status,
    readiness_ceiling: channel.readiness_ceiling,
    failed_checks: (channel.checks ?? [])
      .filter((check) => check.status !== "pass")
      .map((check) => check.id),
    next_action: channel.next_action,
    acceptance_evidence: channel.acceptance_evidence ?? [],
  };
}

function channelOperatorSecretsBacklogItem(channel) {
  const failedChecks = (channel.checks ?? [])
    .filter((check) => check.status !== "pass")
    .map((check) => check.id);
  return backlogItem({
    id: "configure_hermes_operator_channel_secrets",
    title: "Configure Hermes operator channel secrets before more autonomy",
    priority: 8,
    source: ["channel_readiness"],
    frequency: Math.max(1, failedChecks.length),
    rationale: "Hermes runtime diagnostics now pass; remaining channel blockers are explicit operator allowlists and local admin token, not code/runtime repair.",
    targetFiles: [
      "hermes/README.md",
      "docs/hermes-agent-ops.md",
      ".env.example",
    ],
    validationCommands: [
      "npm --silent run hermes:channel-readiness",
      "npm --silent run hermes:activation-checklist",
      "npm --silent run hermes:implementation-handoff",
    ],
    acceptanceEvidence: [
      "doctor_status=passed",
      "telegram_allowlist_configured=true",
      "private_access_allowlist_configured=true",
      "local_admin_secret_available=true",
      "no secret values are printed or committed",
    ],
    blocks: ["channel_ready", "cron_ready", "paper_autopilot_admin_route"],
  });
}

function enterpriseBackendEvidenceBacklogItem(enterpriseReadiness) {
  const blockers = enterpriseReadiness.activation_blockers ?? [];
  return backlogItem({
    id: "restore_enterprise_backend_evidence",
    title: "Restore backend evidence before enterprise readiness work",
    priority: 5,
    source: ["enterprise_readiness"],
    frequency: Math.max(1, blockers.filter((blocker) => blocker === "backend_evidence_unavailable").length),
    rationale: enterpriseReadiness.next_action?.reason
      ?? "FastAPI evidence is unavailable; restore backend read models before enterprise readiness review.",
    targetFiles: [
      "services/api/src/tennis_edge/main.py",
      "services/api/src/tennis_edge/services/operational_state.py",
      "hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs",
      "scripts/check_private_runtime.py",
    ],
    validationCommands: [
      "npm --silent run hermes:backend-latency-triage",
      "npm --silent run hermes:enterprise-readiness",
      "npm --silent run hermes:ops-compiler",
      "npm run api:test",
    ],
    acceptanceEvidence: [
      "enterprise_readiness.status is not blocked_by_backend_evidence",
      "FastAPI read models answer before enterprise contract review",
      "enterprise shadow providers remain deferred/offline",
      "provider_api_call_allowed=false",
      "can_submit_real_orders=false",
    ],
    blocks: ["enterprise_review", "enterprise_shadow_contract_review", "budget_chain_validation"],
  });
}

function buildAutonomyEffectiveness({
  experimentReport,
  operatorReport,
  missionReport,
  liveControllerReport,
  grandSlamMissionReport,
  sourceRouteReport = emptySourceRouteLedgerReport(),
  sourceUseReport = emptySourceUseLedgerReport(),
  sourceIntakeReport = emptySourceIntakeLedgerReport(),
  runtimePriorities,
  backlog,
}) {
  const evidenceTotals = autonomyEvidenceTotals({
    experimentReport,
    operatorReport,
    missionReport,
    liveControllerReport,
    grandSlamMissionReport,
    sourceRouteReport,
    sourceUseReport,
    sourceIntakeReport,
  });
  const protectedClaims = autonomyProtectedActionClaims({
    experimentReport,
    operatorReport,
    missionReport,
    liveControllerReport,
    grandSlamMissionReport,
    sourceRouteReport,
    sourceUseReport,
    sourceIntakeReport,
  });
  const repeatPressure = autonomyRepeatPressure({
    experimentReport,
    operatorReport,
    missionReport,
    liveControllerReport,
    grandSlamMissionReport,
    sourceRouteReport,
    sourceUseReport,
    sourceIntakeReport,
    runtimePriorities,
  });
  const score = autonomyEffectivenessScore({ evidenceTotals, protectedClaims, repeatPressure });
  const status = autonomyEffectivenessStatus({ evidenceTotals, protectedClaims, repeatPressure, backlog });
  const nextAction = autonomyEffectivenessNextAction({ status, evidenceTotals, protectedClaims, backlog });
  return {
    generated_at: new Date().toISOString(),
    mode: "autonomy_effectiveness",
    objective: "measure_whether_hermes_autonomy_routes_reduce_operational_friction_without_increasing_risk",
    status,
    score,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    evidence_totals: evidenceTotals,
    protected_action_claims: protectedClaims,
    repeat_pressure: repeatPressure,
    effectiveness_matrix: {
      runtime: effectivenessLane({
        id: "runtime",
        repeated_count: repeatPressure.runtime,
        top_signal: operatorReport.top_blocker ?? runtimePriorities.next_priority?.id ?? null,
        command: runtimePriorities.next_priority?.diagnostic_command ?? "npm run hermes:runtime-check",
      }),
      live_collection: effectivenessLane({
        id: "live_collection",
        repeated_count: repeatPressure.live_collection,
        top_signal: liveControllerReport.top_repeated_action,
        command: liveControllerReport.top_next_safe_command ?? "npm --silent run hermes:live-controller",
      }),
      source_routes: effectivenessLane({
        id: "source_routes",
        repeated_count: repeatPressure.source_routes,
        top_signal: sourceRouteReport.top_next_route,
        command: sourceRouteReport.top_next_command ?? "npm --silent run hermes:source-route-matrix",
      }),
      source_use: effectivenessLane({
        id: "source_use",
        repeated_count: repeatPressure.source_use,
        top_signal: sourceUseReport.top_operator_required_source
          ?? sourceUseReport.top_deferred_source
          ?? sourceUseReport.top_forbidden_source
          ?? sourceUseReport.top_next_action,
        command: sourceUseReport.next_recommendation?.command ?? "npm --silent run hermes:source-use-ledger-report",
      }),
      source_intake: effectivenessLane({
        id: "source_intake",
        repeated_count: repeatPressure.source_intake,
        top_signal: sourceIntakeReport.top_allowed_contract
          ?? sourceIntakeReport.top_operator_review
          ?? sourceIntakeReport.top_deferred
          ?? sourceIntakeReport.top_forbidden_quarantine
          ?? sourceIntakeReport.top_next_intake,
        command: sourceIntakeReport.top_next_intake_command ?? "npm --silent run hermes:source-intake-ledger-report",
      }),
      grand_slam_prediction: effectivenessLane({
        id: "grand_slam_prediction",
        repeated_count: repeatPressure.grand_slam,
        top_signal: grandSlamMissionReport.top_active_phase,
        command: grandSlamMissionReport.top_next_action ?? "npm --silent run hermes:grand-slam-mission",
      }),
      operator_channel: effectivenessLane({
        id: "operator_channel",
        repeated_count: repeatPressure.operator,
        top_signal: operatorReport.top_blocker,
        command: operatorReport.top_blocker ?? "npm --silent run hermes:operator-packet",
      }),
      experiment_loop: effectivenessLane({
        id: "experiment_loop",
        repeated_count: repeatPressure.experiment,
        top_signal: experimentReport.top_experiment,
        command: experimentReport.next_experiment_command_counts?.[0]?.command ?? "npm --silent run hermes:experiment-lab",
      }),
    },
    backlog_feedback: {
      next_item: backlog.next_item,
      total_items: backlog.items.length,
      evidence: backlog.evidence,
    },
    next_action: nextAction,
    evaluation_policy: {
      count_ledgers_not_intent: true,
      no_llm_per_tick: true,
      compare_repeated_blockers_before_more_autonomy: true,
      real_execution_review_allowed: false,
      provider_quota_spend_allowed: false,
    },
    safety: {
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      anti_bot_bypass_allowed: false,
      geolocation_bypass_allowed: false,
      credential_or_session_extraction_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function autonomyEffectivenessSummary(effectiveness) {
  if (!effectiveness) return null;
  return {
    status: effectiveness.status,
    score: effectiveness.score,
    next_action: effectiveness.next_action,
    repeat_pressure: effectiveness.repeat_pressure,
    protected_action_claims: effectiveness.protected_action_claims,
  };
}

function autonomyEvidenceTotals({
  experimentReport,
  operatorReport,
  missionReport,
  liveControllerReport,
  grandSlamMissionReport,
  sourceRouteReport = emptySourceRouteLedgerReport(),
  sourceUseReport = emptySourceUseLedgerReport(),
  sourceIntakeReport = emptySourceIntakeLedgerReport(),
}) {
  const total_records = sumNumbers([
    experimentReport.total_records,
    operatorReport.total_records,
    missionReport.total_records,
    liveControllerReport.total_records,
    grandSlamMissionReport.total_records,
    sourceRouteReport.total_records,
    sourceUseReport.total_records,
    sourceIntakeReport.total_records,
  ]);
  return {
    total_records,
    experiment_records: experimentReport.total_records,
    operator_records: operatorReport.total_records,
    mission_records: missionReport.total_records,
    live_controller_records: liveControllerReport.total_records,
    grand_slam_mission_records: grandSlamMissionReport.total_records,
    source_route_records: sourceRouteReport.total_records,
    source_use_records: sourceUseReport.total_records,
    source_intake_records: sourceIntakeReport.total_records,
    has_multi_lane_evidence: [
      experimentReport.total_records,
      operatorReport.total_records,
      missionReport.total_records,
      liveControllerReport.total_records,
      grandSlamMissionReport.total_records,
      sourceRouteReport.total_records,
      sourceUseReport.total_records,
      sourceIntakeReport.total_records,
    ].filter((count) => Number(count ?? 0) > 0).length >= 2,
  };
}

function autonomyProtectedActionClaims({
  experimentReport,
  operatorReport,
  missionReport,
  liveControllerReport,
  grandSlamMissionReport,
  sourceRouteReport = emptySourceRouteLedgerReport(),
  sourceUseReport = emptySourceUseLedgerReport(),
  sourceIntakeReport = emptySourceIntakeLedgerReport(),
}) {
  return {
    total: sumNumbers([
      experimentReport.action_executed_count,
      experimentReport.experiment_command_executed_count,
      operatorReport.action_executed_count,
      missionReport.action_executed_count,
      missionReport.mission_command_executed_count,
      liveControllerReport.action_executed_count,
      liveControllerReport.collection_command_executed_count,
      liveControllerReport.provider_command_executed_count,
      liveControllerReport.paper_order_created_count,
      grandSlamMissionReport.action_executed_count,
      grandSlamMissionReport.mission_command_executed_count,
      grandSlamMissionReport.provider_command_executed_count,
      grandSlamMissionReport.paper_order_created_count,
      sourceRouteReport.action_executed_count,
      sourceRouteReport.route_command_executed_count,
      sourceRouteReport.provider_command_executed_count,
      sourceRouteReport.bypass_attempted_count,
      sourceUseReport.action_executed_count,
      sourceUseReport.manifest_command_executed_count,
      sourceUseReport.provider_command_executed_count,
      sourceUseReport.bypass_attempted_count,
      sourceIntakeReport.action_executed_count,
      sourceIntakeReport.intake_command_executed_count,
      sourceIntakeReport.dataset_fetch_attempted_count,
      sourceIntakeReport.provider_command_executed_count,
      sourceIntakeReport.bypass_attempted_count,
    ]),
    operator_actions: operatorReport.action_executed_count,
    provider_commands: sumNumbers([
      liveControllerReport.provider_command_executed_count,
      grandSlamMissionReport.provider_command_executed_count,
      sourceRouteReport.provider_command_executed_count,
      sourceUseReport.provider_command_executed_count,
      sourceIntakeReport.provider_command_executed_count,
    ]),
    route_commands: sourceRouteReport.route_command_executed_count,
    manifest_commands: sourceUseReport.manifest_command_executed_count,
    intake_commands: sourceIntakeReport.intake_command_executed_count,
    dataset_fetches: sourceIntakeReport.dataset_fetch_attempted_count,
    bypass_attempts: sumNumbers([
      sourceRouteReport.bypass_attempted_count,
      sourceUseReport.bypass_attempted_count,
      sourceIntakeReport.bypass_attempted_count,
    ]),
    paper_orders: sumNumbers([
      liveControllerReport.paper_order_created_count,
      grandSlamMissionReport.paper_order_created_count,
    ]),
    experiment_commands: experimentReport.experiment_command_executed_count,
    mission_commands: sumNumbers([
      missionReport.mission_command_executed_count,
      grandSlamMissionReport.mission_command_executed_count,
    ]),
  };
}

function autonomyRepeatPressure({
  experimentReport,
  operatorReport,
  missionReport,
  liveControllerReport,
  grandSlamMissionReport,
  sourceRouteReport = emptySourceRouteLedgerReport(),
  sourceUseReport = emptySourceUseLedgerReport(),
  sourceIntakeReport = emptySourceIntakeLedgerReport(),
  runtimePriorities,
}) {
  const runtime = Math.max(
    runtimePriorities.next_priority?.frequency ?? 0,
    firstCount(operatorReport.next_action_counts),
    missionReport.blocked_lane_counts?.channel ?? 0,
    missionReport.blocked_lane_counts?.backend ?? 0,
  );
  const liveCollection = Math.max(
    maxObjectValue(liveControllerReport.action_counts),
    firstCount(liveControllerReport.next_safe_command_counts),
    liveControllerReport.throttle_counts?.blocked ?? 0,
  );
  const grandSlam = Math.max(
    maxObjectValue(grandSlamMissionReport.active_phase_counts),
    firstCount(grandSlamMissionReport.next_action_counts),
  );
  const experiment = Math.max(
    firstCount(experimentReport.next_experiment_counts),
    maxObjectValue(experimentReport.ready_experiment_counts),
  );
  const sourceRoutes = Math.max(
    firstCount(sourceRouteReport.next_route_counts),
    maxObjectValue(sourceRouteReport.blocked_route_counts),
    maxObjectValue(sourceRouteReport.operator_required_route_counts),
  );
  const sourceUse = Math.max(
    firstCount(sourceUseReport.operator_required_source_counts),
    firstCount(sourceUseReport.deferred_source_counts),
    firstCount(sourceUseReport.forbidden_source_counts),
    firstCount(sourceUseReport.license_review_source_counts),
    firstCount(sourceUseReport.next_action_counts),
  );
  const sourceIntake = Math.max(
    firstCount(sourceIntakeReport.allowed_contract_counts),
    firstCount(sourceIntakeReport.operator_review_counts),
    firstCount(sourceIntakeReport.deferred_counts),
    firstCount(sourceIntakeReport.forbidden_quarantine_counts),
    firstCount(sourceIntakeReport.next_intake_counts),
  );
  const operator = firstCount(operatorReport.next_action_counts);
  return {
    runtime,
    live_collection: liveCollection,
    source_routes: sourceRoutes,
    source_use: sourceUse,
    source_intake: sourceIntake,
    grand_slam: grandSlam,
    experiment,
    operator,
    max_repeated_count: Math.max(runtime, liveCollection, sourceRoutes, sourceUse, sourceIntake, grandSlam, experiment, operator),
  };
}

function autonomyEffectivenessScore({ evidenceTotals, protectedClaims, repeatPressure }) {
  if (!evidenceTotals.total_records) return 0;
  const evidenceScore = Math.min(35, evidenceTotals.total_records * 5);
  const diversityScore = evidenceTotals.has_multi_lane_evidence ? 20 : 5;
  const repeatPenalty = Math.min(40, repeatPressure.max_repeated_count * 8);
  const protectedPenalty = Math.min(60, protectedClaims.total * 30);
  return clampScore(45 + evidenceScore + diversityScore - repeatPenalty - protectedPenalty);
}

function autonomyEffectivenessStatus({ evidenceTotals, protectedClaims, repeatPressure, backlog }) {
  if (protectedClaims.total > 0) return "unsafe_review";
  if (!evidenceTotals.total_records) return "collecting";
  if (repeatPressure.max_repeated_count >= 2 || backlog.next_item) return "needs_implementation";
  if (evidenceTotals.has_multi_lane_evidence) return "monitoring";
  return "collecting";
}

function autonomyEffectivenessNextAction({ status, evidenceTotals, protectedClaims, backlog }) {
  if (protectedClaims.total > 0) {
    return effectivenessAction({
      id: "review_protected_action_claims",
      command: "npm --silent run hermes:autonomy-gates",
      reason: "A local ledger claims an action executed; inspect gates before increasing autonomy.",
    });
  }
  if (!evidenceTotals.total_records) {
    return effectivenessAction({
      id: "collect_autonomy_evidence",
      command: "npm --silent run hermes:operator-ledger",
      reason: "No local ledger evidence exists yet; collect read-only operator decisions before changing autonomy.",
    });
  }
  if (backlog.next_item) {
    return effectivenessAction({
      id: backlog.next_item.id,
      command: "npm --silent run hermes:implementation-handoff",
      reason: backlog.next_item.rationale,
    });
  }
  return effectivenessAction({
    id: "keep_monitoring",
    command: "npm --silent run hermes:autonomy-brief",
    reason: "No repeated blocker is strong enough for implementation; keep collecting safe autonomy evidence.",
  });
}

function effectivenessLane({ id, repeated_count, top_signal, command }) {
  return {
    id,
    repeated_count,
    top_signal,
    command,
    status: repeated_count >= 2 ? "repeated_blocker" : repeated_count === 1 ? "observed" : "no_evidence",
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
  };
}

function effectivenessAction({ id, command, reason }) {
  return {
    id,
    command,
    reason,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    requires_admin_token: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
  };
}

function firstCount(rows = []) {
  return rows[0]?.count ?? 0;
}

function maxObjectValue(value = {}) {
  return Math.max(0, ...Object.values(value).map((item) => Number(item ?? 0)).filter(Number.isFinite));
}

function sumNumbers(values) {
  return values.reduce((total, value) => total + (Number(value ?? 0) || 0), 0);
}

function buildImplementationHandoff(backlogPlan, effectiveness = null) {
  const nextItem = backlogPlan.next_item;
  const workOrder = nextItem ? implementationWorkOrder(nextItem) : null;
  const effectivenessSummary = autonomyEffectivenessSummary(effectiveness);
  return {
    generated_at: new Date().toISOString(),
    mode: "implementation_handoff",
    status: nextItem ? "ready" : "collecting",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    source_plan: {
      mode: backlogPlan.mode,
      status: backlogPlan.status,
      next_item_id: nextItem?.id ?? null,
      total_items: backlogPlan.items.length,
      enterprise_readiness_status: backlogPlan.enterprise_readiness?.status ?? null,
      channel_readiness_status: backlogPlan.channel_readiness?.status ?? null,
      channel_readiness_ceiling: backlogPlan.channel_readiness?.readiness_ceiling ?? null,
    },
    work_order: workOrder,
    implementation_policy: {
      branch: "budget",
      commit_style: "small_cohesive_conventional_commit",
      requires_effectiveness_review: Boolean(effectiveness),
      mutate_runtime_services: false,
      run_provider_smoke_by_default: false,
      spend_provider_quota: false,
      create_orders: false,
      real_execution_allowed: false,
    },
    autonomy_effectiveness: effectivenessSummary,
    evidence: {
      sources: nextItem?.source ?? [],
      frequency: nextItem?.frequency ?? 0,
      rationale: nextItem?.rationale ?? "No repeated pattern is strong enough yet.",
      effectiveness_status: effectiveness?.status ?? null,
      effectiveness_score: effectiveness?.score ?? null,
      backlog_evidence: backlogPlan.evidence,
      enterprise_readiness: backlogPlan.enterprise_readiness ?? null,
      channel_readiness: backlogPlan.channel_readiness ?? null,
    },
    safety: {
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      anti_bot_bypass_allowed: false,
      geolocation_bypass_allowed: false,
      credential_or_session_extraction_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function implementationWorkOrder(item) {
  const validationCommands = dedupeStrings([
    ...(item.validation_commands ?? []),
    "npm --silent run hermes:source-use-manifest",
    "npm run hermes:test",
    "python3 scripts/check_private_runtime.py",
    "git diff --check",
  ]);
  return {
    id: item.id,
    title: item.title,
    priority: item.priority,
    objective: item.rationale,
    target_files: item.target_files ?? [],
    blocked_gates: item.blocks ?? [],
    suggested_steps: implementationStepsFor(item),
    validation_commands: validationCommands,
    acceptance_criteria: dedupeStrings([
      ...(item.acceptance_evidence ?? []),
      "provider_api_call_allowed=false",
      "can_submit_real_orders=false",
      "can_create_paper_orders=false",
      "llm_per_tick_allowed=false",
      "enterprise_eligible stays gated behind budget_chain_completed",
    ]),
    prohibited_changes: [
      "do not enable real execution",
      "do not run provider calls unless a separate operator command explicitly requests it",
      "do not automate sportsbook browser sessions",
      "do not bypass anti-bot, geolocation, paywall or Terms-of-Service controls",
      "do not read, print or commit secrets",
      "do not create, change or activate cron/LaunchAgent/runtime services from this handoff",
    ],
    output_expectation: "Produce a small code/doc/test change that makes the selected backlog item more true, then run the listed validations.",
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
  };
}

function implementationStepsFor(item) {
  const genericSteps = [
    "inspect_target_files_and_existing_tests",
    "make_the_smallest_code_or_doc_change_that_advances_the_backlog_item",
    "add_or_update_tests_for_the_new_evidence_contract",
    "run_validation_commands_and_preserve_budget_first_safety",
  ];
  const stepsById = {
    stabilize_hermes_runtime_channels: [
      "prove_runtime_findings_are_represented_without_mutating_services",
      "improve_channel_readiness_or_runtime_fix_plan_output",
      ...genericSteps.slice(2),
    ],
    expand_allowed_source_backfill: [
      "map_allowed_internal_replay_and_licensed_routes",
      "keep_forbidden_scraping_and_bypass_routes_explicitly_blocked",
      ...genericSteps.slice(2),
    ],
    harden_paper_autopilot_learning_loop: [
      "trace_backend_approved_paper_candidates_without_real_orders",
      "verify_training_evidence_is_recorded_after_settlement_only",
      ...genericSteps.slice(2),
    ],
    harden_live_controller_feedback_loop: [
      "derive_next_safe_collection_work_from_live_controller_ledger_patterns",
      "prove_freeze_throttle_provider_candidate_counts_remain_non_executing",
      ...genericSteps.slice(2),
    ],
    harden_source_route_feedback_loop: [
      "review_source_route_ledger_report_for_top_route_blocked_routes_and_operator_required_routes",
      "map_the_top_route_to_internal_replay_or_licensed_adapter_contract_without_executing_it",
      "keep_browser_scraping_sportsbook_automation_and_bypass_routes_explicitly_blocked",
      "prove_route_provider_and_bypass_counters_remain_zero",
      ...genericSteps.slice(2),
    ],
    harden_source_use_feedback_loop: [
      "review_source_use_ledger_report_for_operator_required_deferred_and_forbidden_sources",
      "map_the_top_source_to_license_terms_contract_status_or_enterprise_deferred_gate",
      "keep_dataset_fetch_provider_quota_and_forbidden_routes_operator_gated",
      "prove_manifest_provider_and_bypass_counters_remain_zero",
      ...genericSteps.slice(2),
    ],
    harden_source_intake_feedback_loop: [
      "review_source_intake_ledger_report_for_allowed_operator_deferred_and_forbidden_queues",
      "map_the_top_allowed_contract_to_replay_or_internal_fastapi_read_model_without_fetching_data",
      "keep_operator_review_deferred_and_forbidden_quarantine_sources_out_of_execution",
      "prove_intake_dataset_provider_and_bypass_counters_remain_zero",
      ...genericSteps.slice(2),
    ],
    complete_budget_chain_before_enterprise: [
      "prove_budget_chain_completion_requirements_from_operational_truth",
      "keep_enterprise_eligibility_false_until_cursor_and_smoke_evidence_pass",
      ...genericSteps.slice(2),
    ],
    restore_enterprise_backend_evidence: [
      "inspect_fastapi_read_models_and_backend_latency_triage_output",
      "restore_read_only_backend_evidence_without_enabling_provider_feeds",
      "prove_enterprise_readiness_no_longer_depends_on_backend_unavailable_fallbacks",
      ...genericSteps.slice(2),
    ],
    configure_hermes_operator_channel_secrets: [
      "document_required_local_env_without_printing_or_committing_secret_values",
      "collect_operator_confirmation_for_allowlists_and_admin_token_outside_git",
      "rerun_channel_readiness_and_activation_checklist_after_secrets_exist",
      ...genericSteps.slice(2),
    ],
    collect_more_hermes_operating_evidence: [
      "collect_read_only_ledgers_or_improve_their_quality_without_changing_runtime",
      "rerun_backlog_plan_after_evidence_increases",
      ...genericSteps.slice(2),
    ],
  };
  return stepsById[item.id] ?? genericSteps;
}

function buildBacklogItems({
  experimentReport,
  operatorReport,
  missionReport,
  liveControllerReport,
  grandSlamMissionReport,
  sourceRouteReport = emptySourceRouteLedgerReport(),
  sourceUseReport = emptySourceUseLedgerReport(),
  sourceIntakeReport = emptySourceIntakeLedgerReport(),
  runtimePriorities,
}) {
  const items = [];
  const topExperiment = experimentReport.top_experiment;
  const ready = experimentReport.ready_experiment_counts ?? {};
  const topBlocker = operatorReport.top_blocker;
  const topMissionAction = missionReport.top_next_action;
  const missionLaneCounts = missionReport.blocked_lane_counts ?? {};
  const missionNextLaneCounts = missionReport.next_lane_counts ?? {};
  const controllerActionCounts = liveControllerReport.action_counts ?? {};
  const controllerThrottleCounts = liveControllerReport.throttle_counts ?? {};
  const controllerFreezeFrequency = controllerActionCounts.freeze_collection ?? 0;
  const controllerThrottleFrequency = controllerActionCounts.throttle_internal_watch ?? 0;
  const controllerProviderCandidateFrequency = controllerActionCounts.operator_provider_candidate ?? 0;
  const controllerPaperCandidateFrequency = controllerActionCounts.paper_autopilot_candidate ?? 0;
  const sourceRouteCounts = sourceRouteReport.next_route_counts ?? [];
  const sourceRouteTopRoute = sourceRouteReport.top_next_route;
  const sourceRouteFrequency = firstCount(sourceRouteCounts);
  const sourceRouteBlockedFrequency = maxObjectValue(sourceRouteReport.blocked_route_counts);
  const sourceRouteOperatorFrequency = maxObjectValue(sourceRouteReport.operator_required_route_counts);
  const sourceUseOperatorFrequency = firstCount(sourceUseReport.operator_required_source_counts);
  const sourceUseDeferredFrequency = firstCount(sourceUseReport.deferred_source_counts);
  const sourceUseForbiddenFrequency = firstCount(sourceUseReport.forbidden_source_counts);
  const sourceUseLicenseFrequency = firstCount(sourceUseReport.license_review_source_counts);
  const sourceUseFrequency = Math.max(
    sourceUseOperatorFrequency,
    sourceUseDeferredFrequency,
    sourceUseForbiddenFrequency,
    sourceUseLicenseFrequency,
  );
  const sourceIntakeAllowedFrequency = firstCount(sourceIntakeReport.allowed_contract_counts);
  const sourceIntakeOperatorFrequency = firstCount(sourceIntakeReport.operator_review_counts);
  const sourceIntakeDeferredFrequency = firstCount(sourceIntakeReport.deferred_counts);
  const sourceIntakeForbiddenFrequency = firstCount(sourceIntakeReport.forbidden_quarantine_counts);
  const sourceIntakeFrequency = Math.max(
    sourceIntakeAllowedFrequency,
    sourceIntakeOperatorFrequency,
    sourceIntakeDeferredFrequency,
    sourceIntakeForbiddenFrequency,
  );
  const grandSlamPhaseCounts = grandSlamMissionReport.active_phase_counts ?? {};
  const grandSlamRestoreFrequency = grandSlamPhaseCounts.restore_operational_truth ?? 0;
  const grandSlamBackfillFrequency = grandSlamPhaseCounts.offline_backfill ?? 0;
  const grandSlamVisibilityFrequency = grandSlamPhaseCounts.feed_visibility ?? 0;
  const grandSlamModelGapFrequency = grandSlamPhaseCounts.model_input_gap ?? 0;
  const grandSlamPredictionFrequency = grandSlamPhaseCounts.prediction_watch ?? 0;
  const grandSlamPaperFrequency = grandSlamPhaseCounts.paper_learning ?? 0;
  const runtimePriority = runtimePriorities.next_priority;
  const experimentRuntimeFrequency = countFor(experimentReport.next_experiment_counts, "runtime_channel_recovery");
  const operatorRuntimeFrequency = countFor(operatorReport.next_action_counts, "npm run hermes:runtime-check");
  const missionRuntimeFrequency = Math.max(
    countFor(missionReport.next_action_counts, "hermes gateway start"),
    countFor(missionReport.next_action_counts, "npm run api:dev"),
    missionLaneCounts.backend ?? 0,
    missionLaneCounts.channel ?? 0,
    missionNextLaneCounts.backend ?? 0,
    missionNextLaneCounts.channel ?? 0,
    grandSlamRestoreFrequency,
  );
  const runtimePriorityFrequency = runtimePriority?.id === "stabilize_hermes_runtime"
    ? runtimePriority.frequency ?? 1
    : 0;

  if (topExperiment === "runtime_channel_recovery"
    || topBlocker === "npm run hermes:runtime-check"
    || runtimePriority?.id === "stabilize_hermes_runtime"
    || ["hermes gateway start", "npm run api:dev"].includes(topMissionAction)
    || missionRuntimeFrequency > 0) {
    items.push(backlogItem({
      id: "stabilize_hermes_runtime_channels",
      title: "Stabilize Hermes runtime and channel readiness before more autonomy",
      priority: 10,
      source: backlogRuntimeSources({
        experimentRuntimeFrequency,
        operatorRuntimeFrequency,
        missionRuntimeFrequency,
        runtimePriorityFrequency,
      }),
      frequency: Math.max(
        experimentRuntimeFrequency,
        operatorRuntimeFrequency,
        missionRuntimeFrequency,
        runtimePriorityFrequency,
      ),
      rationale: "Runtime/channel blockers are the recurring ceiling; model, collection and paper work should wait for this proof.",
      targetFiles: [
        "hermes/README.md",
        "docs/hermes-agent-ops.md",
        "hermes/skills/tennis-edge-ops/SKILL.md",
      ],
      validationCommands: [
        "npm run hermes:runtime-check",
        "npm run hermes:doctor-triage",
        "npm --silent run hermes:autonomy-gates",
        "npm --silent run hermes:experiment-ledger-report",
        "npm --silent run hermes:mission-ledger-report",
      ],
      acceptanceEvidence: [
        "gateway_service_status=running",
        "doctor_status=passed",
        "active_ceiling is at least channel_ready",
      ],
      blocks: ["cron_ready", "paper_ready", "learning_ready"],
    }));
  }

  if ((ready.source_discovery_backfill ?? 0) > 0 || topExperiment === "source_discovery_backfill") {
    items.push(backlogItem({
      id: "expand_allowed_source_backfill",
      title: "Expand allowed source/backfill routes without scraping or provider spend",
      priority: 20,
      source: ["experiment_ledger"],
      frequency: Math.max(ready.source_discovery_backfill ?? 0, countFor(experimentReport.next_experiment_counts, "source_discovery_backfill")),
      rationale: "Allowed route discovery keeps the budget chain moving while preserving the safe interpretation of jailbreak.",
      targetFiles: [
        "hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs",
        "docs/hermes-operating-model.md",
      ],
      validationCommands: [
        "npm --silent run hermes:source-discovery",
        "npm --silent run hermes:experiment-lab",
        "python3 scripts/check_private_runtime.py",
      ],
      acceptanceEvidence: [
        "safe_jailbreak_policy.bypass_allowed=false",
        "allowed_collection_paths include internal/replay/licensed routes",
      ],
      blocks: ["live_collection_cadence"],
    }));
  }

  if (sourceRouteFrequency > 0 || sourceRouteBlockedFrequency > 0 || sourceRouteOperatorFrequency > 0) {
    items.push(backlogItem({
      id: "harden_source_route_feedback_loop",
      title: "Harden source-route feedback before adding collection code",
      priority: 22,
      source: ["source_route_ledger"],
      frequency: Math.max(sourceRouteFrequency, sourceRouteBlockedFrequency, sourceRouteOperatorFrequency),
      rationale: "Repeated source-route decisions show which allowed collection path should be improved next; convert replay/internal/provider/manual route evidence into implementation work before spending quota or writing importers.",
      targetFiles: [
        "hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs",
        "docs/hermes-agent-ops.md",
        "docs/hermes-operating-model.md",
      ],
      validationCommands: [
        "npm --silent run hermes:source-route-ledger-report",
        "npm --silent run hermes:source-route-matrix",
        "python3 scripts/check_private_runtime.py",
      ],
      acceptanceEvidence: [
        `source_route_ledger.top_next_route=${sourceRouteTopRoute ?? "none"}`,
        "route_command_executed_count=0",
        "provider_command_executed_count=0",
        "bypass_attempted_count=0",
        "provider_api_call_allowed=false",
      ],
      blocks: ["live_collection_cadence", "historical_backfill_importers", "provider_spend_review"],
    }));
  }

  if (sourceUseFrequency > 0) {
    items.push(backlogItem({
      id: "harden_source_use_feedback_loop",
      title: "Harden source-use decisions before importer or provider work",
      priority: 23,
      source: ["source_use_ledger"],
      frequency: sourceUseFrequency,
      rationale: "Repeated source-use decisions show which data sources need license, operator or deferred-provider review; convert that evidence into implementation constraints before fetching datasets, adding importers or spending quota.",
      targetFiles: [
        "hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs",
        "hermes/skills/tennis-edge-ops/SKILL.md",
        "hermes/README.md",
        "scripts/check_private_runtime.py",
      ],
      validationCommands: [
        "npm --silent run hermes:source-use-ledger-report",
        "npm --silent run hermes:source-use-manifest",
        "python3 scripts/check_private_runtime.py",
      ],
      acceptanceEvidence: [
        "source_use_ledger.total_records>=2",
        `source_use_ledger.top_operator_required_source=${sourceUseReport.top_operator_required_source ?? "none"}`,
        `source_use_ledger.top_deferred_source=${sourceUseReport.top_deferred_source ?? "none"}`,
        `source_use_ledger.top_forbidden_source=${sourceUseReport.top_forbidden_source ?? "none"}`,
        "manifest_command_executed_count=0",
        "provider_command_executed_count=0",
        "bypass_attempted_count=0",
        "operator_required_or_deferred_sources_reviewed",
      ],
      blocks: ["source_use_manifest", "source_use_ledger", "license_review", "enterprise_deferred", "safe_jailbreak_policy"],
    }));
  }

  if (sourceIntakeFrequency > 0) {
    items.push(backlogItem({
      id: "harden_source_intake_feedback_loop",
      title: "Harden source-intake decisions before importer contracts",
      priority: 24,
      source: ["source_intake_ledger"],
      frequency: sourceIntakeFrequency,
      rationale: "Repeated source-intake queues show which offline/internal contract should be implemented next, and which sources must stay operator-reviewed, deferred or quarantined.",
      targetFiles: [
        "hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs",
        "hermes/skills/tennis-edge-ops/SKILL.md",
        "hermes/README.md",
        "scripts/check_private_runtime.py",
      ],
      validationCommands: [
        "npm --silent run hermes:source-intake-ledger-report",
        "npm --silent run hermes:source-intake-plan",
        "python3 scripts/check_private_runtime.py",
      ],
      acceptanceEvidence: [
        "source_intake_ledger.total_records>=2",
        `source_intake_ledger.top_allowed_contract=${sourceIntakeReport.top_allowed_contract ?? "none"}`,
        `source_intake_ledger.top_operator_review=${sourceIntakeReport.top_operator_review ?? "none"}`,
        `source_intake_ledger.top_deferred=${sourceIntakeReport.top_deferred ?? "none"}`,
        "intake_command_executed_count=0",
        "dataset_fetch_attempted_count=0",
        "provider_command_executed_count=0",
        "bypass_attempted_count=0",
      ],
      blocks: ["source_intake_plan", "offline_import_contract", "license_review", "enterprise_deferred", "safe_jailbreak_policy"],
    }));
  }

  if (grandSlamVisibilityFrequency > 0
    || grandSlamModelGapFrequency > 0
    || grandSlamPredictionFrequency > 0
    || grandSlamPaperFrequency > 0) {
    items.push(backlogItem({
      id: "harden_grand_slam_prediction_loop",
      title: "Harden the Grand Slam match-day prediction loop",
      priority: 25,
      source: ["grand_slam_mission_ledger"],
      frequency: Math.max(
        grandSlamVisibilityFrequency,
        grandSlamModelGapFrequency,
        grandSlamPredictionFrequency,
        grandSlamPaperFrequency,
      ),
      rationale: "Repeated Grand Slam mission phases show where match-day score prediction loses readiness; convert visibility, model-input and paper-learning evidence into safer product work.",
      targetFiles: [
        "hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs",
        "services/api/src/tennis_edge/services/operational_state.py",
        "docs/hermes-operating-model.md",
      ],
      validationCommands: [
        "npm --silent run hermes:grand-slam-mission-ledger-report",
        "npm --silent run hermes:grand-slam-readiness",
        "npm run api:check:operational-truth -- --pretty",
      ],
      acceptanceEvidence: [
        "grand_slam_mission_ledger.active_phase_counts explains repeated mission phases",
        "provider_command_executed_count=0",
        "paper_order_created_count=0 unless protected backend autopilot is explicitly run",
        "can_submit_real_orders=false",
      ],
      blocks: ["grand_slam_prediction_ready", "paper_ready", "learning_ready"],
    }));
  }

  if ((ready.paper_autopilot_rehearsal ?? 0) > 0 || topExperiment === "paper_autopilot_rehearsal") {
    items.push(backlogItem({
      id: "harden_paper_autopilot_learning_loop",
      title: "Harden paper autopilot evidence before model or real-execution review",
      priority: 30,
      source: ["experiment_ledger"],
      frequency: Math.max(ready.paper_autopilot_rehearsal ?? 0, countFor(experimentReport.next_experiment_counts, "paper_autopilot_rehearsal")),
      rationale: "Paper rehearsal is the highest-value learning loop once backend gates allow it.",
      targetFiles: [
        "services/api/src/tennis_edge/services/agent_ops.py",
        "services/api/tests/test_agent_ops_persistence.py",
        "hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs",
      ],
      validationCommands: [
        "npm run hermes:autopilot",
        "npm --silent run hermes:learning-review",
        "npm run api:test",
      ],
      acceptanceEvidence: [
        "paper_orders_created tracked by backend",
        "training_examples_ready increases from settled paper orders",
        "REAL_EXECUTION_HARD_BLOCK remains true",
      ],
      blocks: ["learning_ready", "real_execution_readiness_report"],
    }));
  }

  if (controllerFreezeFrequency > 0
    || controllerThrottleFrequency > 0
    || controllerProviderCandidateFrequency > 0
    || controllerPaperCandidateFrequency > 0) {
    items.push(backlogItem({
      id: "harden_live_controller_feedback_loop",
      title: "Harden live-controller feedback from repeated collection decisions",
      priority: 35,
      source: ["live_controller_ledger"],
      frequency: Math.max(
        controllerFreezeFrequency,
        controllerThrottleFrequency,
        controllerProviderCandidateFrequency,
        controllerPaperCandidateFrequency,
      ),
      rationale: "Repeated live-controller decisions show where Hermes is losing collection leverage; convert freeze/throttle/provider-candidate evidence into safer cadence and data-quality work.",
      targetFiles: [
        "hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs",
        "docs/hermes-operating-model.md",
        "services/api/src/tennis_edge/services/operational_state.py",
      ],
      validationCommands: [
        "npm --silent run hermes:live-controller-ledger-report",
        "npm --silent run hermes:live-controller",
        "npm run api:check:operational-truth -- --pretty",
      ],
      acceptanceEvidence: [
        "live_controller_ledger.action_counts explains repeated freezes/throttles",
        "provider_command_executed_count=0",
        "paper_order_created_count=0 unless backend paper route is explicitly run",
        `blocked_throttle_count=${controllerThrottleCounts.blocked ?? 0}`,
      ],
      blocks: ["live_collection_cadence", "paper_ready", "learning_ready"],
    }));
  }

  if (topExperiment === "enterprise_eligibility_review") {
    items.push(backlogItem({
      id: "complete_budget_chain_before_enterprise",
      title: "Complete budget-chain evidence before enterprise feed work",
      priority: 40,
      source: ["experiment_ledger"],
      frequency: countFor(experimentReport.next_experiment_counts, "enterprise_eligibility_review"),
      rationale: "Enterprise spend remains locked until replay, smokes and healthy cursor proof are complete.",
      targetFiles: [
        "scripts/check_operational_truth_runtime.py",
        "services/api/src/tennis_edge/services/operational_state.py",
      ],
      validationCommands: [
        "npm run api:check:operational-truth -- --pretty",
        "npm --silent run hermes:budget-chain",
      ],
      acceptanceEvidence: [
        "budget_chain_completed=true",
        "enterprise_eligible=true only after healthy Odds-API.io cursor",
      ],
      blocks: ["enterprise_review"],
    }));
  }

  if (grandSlamBackfillFrequency > 0 && !(ready.source_discovery_backfill ?? 0) && topExperiment !== "source_discovery_backfill") {
    items.push(backlogItem({
      id: "expand_allowed_source_backfill",
      title: "Expand allowed source/backfill routes without scraping or provider spend",
      priority: 45,
      source: ["grand_slam_mission_ledger"],
      frequency: grandSlamBackfillFrequency,
      rationale: "Off-calendar Grand Slam mission evidence repeatedly points to historical priors and backtests as the highest-value accuracy work.",
      targetFiles: [
        "hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs",
        "docs/hermes-operating-model.md",
      ],
      validationCommands: [
        "npm --silent run hermes:historical-backfill-plan",
        "npm --silent run hermes:grand-slam-mission-ledger-report",
        "python3 scripts/check_private_runtime.py",
      ],
      acceptanceEvidence: [
        "historical sources are ranked without fetching/importing",
        "license review gates stay visible before any importer exists",
        "safe_jailbreak_policy.bypass_allowed=false",
      ],
      blocks: ["offline_accuracy", "backtest_depth"],
    }));
  }

  if (!items.length) {
    items.push(backlogItem({
      id: "collect_more_hermes_operating_evidence",
      title: "Collect more Hermes operating evidence before changing code",
      priority: 90,
      source: ["experiment_ledger", "operator_ledger", "live_controller_ledger", "grand_slam_mission_ledger"],
      frequency: 0,
      rationale: "No repeated pattern is strong enough yet; continue ledger collection instead of guessing.",
      targetFiles: ["hermes/runs/*.jsonl"],
      validationCommands: [
        "npm --silent run hermes:experiment-ledger",
        "npm --silent run hermes:operator-ledger",
        "npm --silent run hermes:live-controller-ledger",
        "npm --silent run hermes:grand-slam-mission-ledger",
        "npm --silent run hermes:backlog-plan",
      ],
      acceptanceEvidence: [
        "experiment_ledger.total_records increases",
        "operator_ledger.total_records increases",
        "live_controller_ledger.total_records increases",
        "grand_slam_mission_ledger.total_records increases",
      ],
      blocks: [],
    }));
  }

  return dedupeBacklogItems(items);
}

function backlogRuntimeSources({
  experimentRuntimeFrequency,
  operatorRuntimeFrequency,
  missionRuntimeFrequency,
  runtimePriorityFrequency,
}) {
  const sources = [];
  if (experimentRuntimeFrequency > 0) sources.push("experiment_ledger");
  if (operatorRuntimeFrequency > 0) sources.push("operator_ledger");
  if (missionRuntimeFrequency > 0) sources.push("mission_ledger");
  if (runtimePriorityFrequency > 0) sources.push("runtime_priorities");
  return sources;
}

function backlogItem({
  id,
  title,
  priority,
  source,
  frequency,
  rationale,
  targetFiles,
  validationCommands,
  acceptanceEvidence,
  blocks,
}) {
  return {
    id,
    title,
    priority,
    source,
    frequency,
    rationale,
    target_files: targetFiles,
    validation_commands: validationCommands,
    acceptance_evidence: acceptanceEvidence,
    blocks,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
  };
}

function dedupeBacklogItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function dedupeStrings(items) {
  return [...new Set(items.filter(Boolean))];
}

function countFor(rows = [], command) {
  return rows.find((row) => row.command === command)?.count ?? 0;
}

function buildCapabilityRows({ loop, report, eventPlan, sourcePlan, autonomyPlan, opsPacket }) {
  const matrix = autonomyPlan.autonomy_matrix ?? {};
  const liveStats = loop.live_stats ?? {};
  const budget = loop.budget_chain ?? {};
  const learning = loop.learning_review ?? {};
  return [
    capabilityRow({
      id: "runtime_and_channels",
      label: "Hermes local runtime and channel health",
      status: loop.status === "runtime_partial"
        ? "partial_read_only"
        : loop.runtime?.status === "ready" ? "ready" : "degraded",
      score: loop.runtime?.status === "ready" ? 100 : loop.status === "runtime_partial" ? 60 : 35,
      command: runtimeReviewCommand(loop.runtime?.runtime_findings),
      reason: "Runtime diagnostics determine whether cron, Telegram and gateway packets can be trusted.",
      evidence: [
        `runtime.status=${loop.runtime?.status ?? "unknown"}`,
        `safe_loop.status=${loop.status}`,
        `read_only_route=${loop.read_only_runtime_route?.command ?? "none"}`,
      ],
    }),
    capabilityRow({
      id: "safe_source_discovery",
      label: "Allowed-path source discovery",
      status: sourcePlan.safe_jailbreak_policy?.bypass_allowed === false ? "ready" : "blocked",
      score: sourcePlan.safe_jailbreak_policy?.bypass_allowed === false ? 100 : 0,
      command: "npm --silent run hermes:source-discovery",
      reason: "Jailbreak requests are constrained to licensed APIs, internal endpoints, replay and operator notes.",
      evidence: [
        `bypass_allowed=${sourcePlan.safe_jailbreak_policy?.bypass_allowed}`,
        `discovery_scope=${(sourcePlan.discovery_scope ?? []).join(",")}`,
      ],
    }),
    capabilityRow({
      id: "live_data_collection",
      label: "Live data collection control",
      status: liveCollectionCapabilityStatus({ loop, report, eventPlan }),
      score: liveCollectionCapabilityScore({ loop, report, eventPlan }),
      command: "npm --silent run hermes:collection-plan",
      reason: "Collection cadence is planned from match pulse, quota and cursor state, but provider calls stay operator-gated.",
      evidence: [
        `collection_status=${liveStats.collection_status ?? "unknown"}`,
        `sampling_policy=${liveStats.sampling_policy?.name ?? "unknown"}`,
        `provider_mode=${report.data_snapshot?.provider_mode ?? "unknown"}`,
      ],
    }),
    capabilityRow({
      id: "live_statistics",
      label: "Deterministic live statistics",
      status: liveStats.health_scores?.overall >= 60 ? "ready" : "monitor",
      score: clampScore(liveStats.health_scores?.overall ?? 0),
      command: "npm --silent run hermes:live-stats",
      reason: "Hermes summarizes backend-derived scores and freshness; Python/Postgres keep point and odds math.",
      evidence: [
        `overall=${liveStats.health_scores?.overall ?? "unknown"}`,
        `llm_per_tick_allowed=${loop.safety?.llm_per_tick_allowed}`,
      ],
    }),
    capabilityRow({
      id: "paper_autopilot",
      label: "Protected paper autopilot",
      status: eventPlan.can_run_paper_autopilot ? "operator_ready" : "blocked",
      score: eventPlan.can_run_paper_autopilot ? 80 : 20,
      command: "npm run hermes:autopilot",
      reason: eventPlan.can_run_paper_autopilot
        ? "Only the protected backend endpoint may create paper orders after admin-token gates."
        : "Paper orders stay blocked until event router and backend gates allow them.",
      requiresAdminToken: true,
      writes: false,
      evidence: [
        `event_can_run_paper_autopilot=${eventPlan.can_run_paper_autopilot}`,
        `entry_signals=${report.signal_snapshot?.entry_signals ?? 0}`,
      ],
    }),
    capabilityRow({
      id: "learning_review",
      label: "Learning and model review",
      status: learning.review_status ?? "unknown",
      score: learning.review_status === "ready" ? 90 : learning.review_status === "collecting" ? 55 : 20,
      command: "npm --silent run hermes:learning-review",
      reason: "Strong-model review is periodic and interpretive; model promotion remains offline and deterministic.",
      evidence: [
        `review_status=${learning.review_status ?? "unknown"}`,
        `model=${learning.model_route?.model ?? "unknown"}`,
      ],
    }),
    capabilityRow({
      id: "external_agent_orchestration",
      label: "External agent orchestration packet",
      status: opsPacket.execution_graph?.length >= 4 ? "ready" : "partial",
      score: opsPacket.execution_graph?.length >= 4 ? 95 : 45,
      command: "npm --silent run hermes:ops-compiler",
      reason: "External channels can consume one packet instead of inferring safety from multiple commands.",
      evidence: [
        `graph_nodes=${opsPacket.execution_graph?.length ?? 0}`,
        `selected_model=${opsPacket.model_router?.selected_model ?? "unknown"}`,
      ],
    }),
    capabilityRow({
      id: "budget_chain",
      label: "Budget-first provider chain",
      status: budget.completed ? "complete" : "pending",
      score: budget.completed ? 85 : 45,
      command: "npm --silent run hermes:budget-chain",
      reason: "Budget APIs must prove replay, smoke and cursor health before enterprise feeds become eligible.",
      evidence: [
        `budget_chain_completed=${budget.completed}`,
        `current_step=${budget.current_step_label ?? "none"}`,
      ],
    }),
    capabilityRow({
      id: "enterprise_gate",
      label: "Enterprise eligibility gate",
      status: budget.enterprise_eligible ? "eligible" : "locked",
      score: budget.enterprise_eligible ? 70 : 100,
      command: "npm run api:check:operational-truth -- --pretty",
      reason: "Enterprise being locked is healthy until the full budget chain has durable evidence.",
      evidence: [
        `enterprise_eligible=${budget.enterprise_eligible}`,
        `matrix_status=${matrix.enterprise?.status ?? "unknown"}`,
      ],
    }),
  ];
}

function capabilityRow({
  id,
  label,
  status,
  score,
  command,
  reason,
  evidence,
  requiresAdminToken = false,
  writes = false,
}) {
  return {
    id,
    label,
    status,
    score: clampScore(score),
    command,
    reason,
    evidence,
    executes_now: false,
    writes: Boolean(writes),
    live_api_calls: false,
    provider_api_call_allowed: false,
    requires_admin_token: Boolean(requiresAdminToken),
    can_create_paper_orders: false,
    can_submit_real_orders: false,
  };
}

function liveCollectionCapabilityStatus({ loop, report, eventPlan }) {
  if (eventPlan.events.some((event) => event.type === "cursor_resync_required")) {
    return "blocked";
  }
  if (loop.quota_plan?.throttle_level === "blocked") {
    return "frozen";
  }
  if (loop.live_stats?.collection_status === "healthy" && report.data_snapshot?.persisted_matches > 0) {
    return "ready";
  }
  if (report.data_snapshot?.persisted_matches > 0) {
    return "monitor";
  }
  return "blocked";
}

function liveCollectionCapabilityScore({ loop, report, eventPlan }) {
  if (eventPlan.events.some((event) => event.type === "cursor_resync_required")) {
    return 15;
  }
  if (loop.quota_plan?.throttle_level === "blocked") {
    return 30;
  }
  const base = loop.live_stats?.collection_status === "healthy" ? 75 : 45;
  const persistenceBonus = report.data_snapshot?.persisted_matches > 0 ? 15 : 0;
  return base + persistenceBonus;
}

function capabilityAuditStatus({ loop, capabilities }) {
  if (loop.status === "safety_stop") return "safety_stop";
  if (capabilities.some((capability) => capability.status === "blocked")) return "blocked";
  if (capabilities.some((capability) => ["degraded", "partial_read_only", "pending", "collecting", "monitor"].includes(capability.status))) {
    return "partial";
  }
  return "ready";
}

function capabilityAutonomyCeiling({ loop, capabilities }) {
  const byId = Object.fromEntries(capabilities.map((capability) => [capability.id, capability]));
  if (loop.status === "safety_stop") {
    return ceiling("observe_only", "safety", "Real-execution or forbidden-route safety must be inspected first.");
  }
  if (loop.status === "runtime_partial" && loop.read_only_runtime_route) {
    return ceiling("read_only_operator_packets", "local_runtime", "Hermes may produce summaries and ledgers while runtime doctor/channel gates stay blocked.");
  }
  if (byId.runtime_and_channels?.status !== "ready") {
    return ceiling("runtime_diagnostics", "local_runtime", "Hermes runtime must be healthy before more autonomy.");
  }
  if (byId.safe_source_discovery?.status !== "ready") {
    return ceiling("source_discovery_review", "collection", "Allowed-path source boundary is not proven.");
  }
  if (byId.paper_autopilot?.status === "operator_ready") {
    return ceiling("paper_autopilot", "paper_trading", "Protected paper autopilot is the current maximum autonomy; real execution remains blocked.");
  }
  if (byId.learning_review?.status === "ready") {
    return ceiling("learning_review", "model_review", "Weekly learning review may run, but promotion remains deterministic.");
  }
  return ceiling("observe_and_collect", "monitor", "Continue collecting budget-chain and learning evidence.");
}

function ceiling(id, lane, reason) {
  return {
    id,
    lane,
    reason,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    executes_now: false,
  };
}

function capabilityNextCommand({ loop, capabilities }) {
  const byId = Object.fromEntries(capabilities.map((capability) => [capability.id, capability]));
  const command = loop.next_best_command ?? { command: "npm --silent run hermes:intelligence", reason: "Observe current state." };
  if (byId.paper_autopilot?.status === "operator_ready") {
    return {
      id: "paper_autopilot",
      command: "npm run hermes:autopilot",
      reason: "Backend gates report a paper-only candidate; admin token is still required and this audit does not execute it.",
      executes_now: false,
      writes: false,
      live_api_calls: false,
      provider_api_call_allowed: false,
      requires_admin_token: true,
      can_create_paper_orders: false,
      can_submit_real_orders: false,
    };
  }
  return {
    id: command.id ?? "observe",
    command: command.command,
    reason: command.reason,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    requires_admin_token: Boolean(command.requires_admin_token),
    can_create_paper_orders: false,
    can_submit_real_orders: false,
  };
}

function buildWakeTriggers({ loop, sourcePlan, grandSlam = null }) {
  const triggers = [];
  if (loop.status === "safety_stop") {
    triggers.push(wakeTrigger({
      id: "safety_stop",
      priority: 0,
      severity: "critical",
      command: "npm run hermes:preflight",
      condition: "real execution safety violation or forbidden route detected",
      reason: "Stop automation review until safety is inspected.",
    }));
  }
  if (loop.runtime?.status !== "ready") {
    triggers.push(wakeTrigger({
      id: "runtime_degraded",
      priority: 10,
      severity: "high",
      command: runtimeReviewCommand(loop.runtime?.runtime_findings),
      condition: `runtime.status=${loop.runtime?.status ?? "unknown"}`,
      reason: runtimeReviewReason(loop.runtime?.runtime_findings),
    }));
  }
  if (loop.read_only_runtime_route) {
    triggers.push(wakeTrigger({
      id: "partial_runtime_read_only_route",
      priority: 11,
      severity: "medium",
      command: loop.read_only_runtime_route.command,
      condition: `runtime_autonomy_impact=${loop.runtime_autonomy_impact?.status ?? "partial_runtime_available"}`,
      reason: "Use the partial Hermes runtime for compact read-only summaries while diagnostics remain blocked.",
    }));
  }
  for (const event of loop.event_summary?.events ?? []) {
    if (event.type === "provider_health_degraded") {
      triggers.push(wakeTrigger({
        id: "provider_health_degraded",
        priority: 20,
        severity: event.severity,
        command: "npm run hermes:preflight",
        condition: "provider health degraded",
        reason: "Review provider health and quota state without spending live calls.",
      }));
    }
    if (event.type === "cursor_resync_required") {
      triggers.push(wakeTrigger({
        id: "cursor_resync_required",
        priority: 15,
        severity: event.severity,
        command: "npm --silent run hermes:events",
        condition: "provider cursor requires resync",
        reason: "Keep live odds decisions blocked until cursor state clears.",
      }));
    }
    if (event.type === "data_quality_degraded") {
      triggers.push(wakeTrigger({
        id: "data_quality_degraded",
        priority: 25,
        severity: event.severity,
        command: "npm --silent run hermes:intelligence",
        condition: "data quality degraded",
        reason: "Refresh redacted operator packet before changing collection cadence.",
      }));
    }
  }
  if (sourcePlan.status !== "ready") {
    triggers.push(wakeTrigger({
      id: "source_discovery",
      priority: 30,
      severity: sourcePlan.status === "blocked" ? "high" : "medium",
      command: "npm --silent run hermes:source-discovery",
      condition: `source_discovery.status=${sourcePlan.status}`,
      reason: "Review allowed acquisition routes before provider or public-context work.",
    }));
  }
  for (const trigger of grandSlamWakeTriggers(grandSlam)) {
    triggers.push(trigger);
  }
  if (loop.budget_chain && !loop.budget_chain.completed) {
    triggers.push(wakeTrigger({
      id: "budget_chain_next_step",
      priority: 40,
      severity: "medium",
      command: "npm --silent run hermes:budget-chain",
      condition: `current_step=${loop.budget_chain.current_step_label ?? "unknown"}`,
      reason: "Track next budget provider onboarding step without running smoke execution.",
    }));
  }
  triggers.push(wakeTrigger({
    id: "live_statistics",
    priority: 80,
    severity: loop.live_stats?.sampling_policy?.severity ?? "low",
    command: "npm --silent run hermes:live-stats",
    condition: `sampling_policy=${loop.live_stats?.sampling_policy?.name ?? "unknown"}`,
    reason: "Summarize live collection and freshness thresholds without LLM per tick.",
  }));
  triggers.push(wakeTrigger({
    id: "quota_guard",
    priority: 85,
    severity: loop.quota_plan?.throttle_level === "blocked" ? "high" : "medium",
    command: "npm --silent run hermes:quota-plan",
    condition: `throttle=${loop.quota_plan?.throttle_level ?? "unknown"}`,
    reason: "Apply budget utilization guardrails before any collection cadence change.",
  }));
  if (loop.learning_review?.review_status !== "ready") {
    triggers.push(wakeTrigger({
      id: "learning_review",
      priority: 95,
      severity: "low",
      command: "npm --silent run hermes:learning-review",
      condition: `learning_review.status=${loop.learning_review?.review_status ?? "unknown"}`,
      reason: "Review ROI/CLV readiness periodically; no model promotion from Hermes.",
    }));
  }
  return dedupeWakeTriggers(triggers).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function grandSlamWakeTriggers(grandSlam) {
  if (!grandSlam || grandSlam.status === "off_calendar") return [];
  const activeLabels = (grandSlam.active_grand_slams ?? []).map((slam) => slam.label).join(", ") || "visible Grand Slam";
  if (grandSlam.status === "paper_ready") {
    return [wakeTrigger({
      id: "grand_slam_paper_ready",
      priority: 12,
      severity: "high",
      command: "npm --silent run hermes:grand-slam-readiness",
      condition: `grand_slam.paper_ready=true prediction_rows=${grandSlam.matches?.prediction_rows ?? 0}`,
      reason: `${activeLabels} has paper-ready prediction rows; backend still controls any paper order route.`,
    })];
  }
  if (grandSlam.prediction_ready) {
    return [wakeTrigger({
      id: "grand_slam_prediction_ready",
      priority: 45,
      severity: "medium",
      command: "npm --silent run hermes:grand-slam-readiness",
      condition: `grand_slam.prediction_ready=true prediction_rows=${grandSlam.matches?.prediction_rows ?? 0}`,
      reason: `${activeLabels} has model probabilities; keep observing until live-window gates permit paper readiness.`,
    })];
  }
  if (grandSlam.active_grand_slams?.length || Number(grandSlam.matches?.grand_slam_visible ?? 0) > 0) {
    return [wakeTrigger({
      id: "grand_slam_window_open",
      priority: 55,
      severity: "medium",
      command: "npm --silent run hermes:grand-slam-readiness",
      condition: `grand_slam.status=${grandSlam.status}`,
      reason: `${activeLabels} requires readiness monitoring before prediction or collection escalation.`,
    })];
  }
  return [];
}

function wakeTrigger({ id, priority, severity, command, condition, reason }) {
  return {
    id,
    priority,
    severity,
    condition,
    command,
    reason,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function dedupeWakeTriggers(triggers) {
  const seen = new Set();
  return triggers.filter((trigger) => {
    const key = `${trigger.id}:${trigger.command}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function acquisitionRoute({
  primaryPath,
  status,
  command,
  reason,
  blockers = [],
}) {
  return {
    primary_path: primaryPath,
    status,
    command,
    reason,
    blockers,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
  };
}

function buildProviderRoutes(report, cursorsBlocked) {
  const healthRows = report.evidence?.provider_health ?? [];
  const onboarding = report.budget_chain_snapshot ?? {};
  const currentStep = (onboarding.steps ?? []).find((step) => step.current)
    ?? parseBudgetChainStep(onboarding.current_step);
  const providers = new Map();
  for (const health of healthRows) {
    providers.set(health.provider, {
      provider: health.provider,
      status: health.status,
      route: providerRouteType(health.provider),
      configured: health.status !== "missing_key",
      cursor_blocked: false,
      operator_only: true,
      provider_api_call_allowed: false,
      command: "npm --silent run hermes:budget-chain",
    });
  }
  for (const cursor of report.evidence?.provider_cursors ?? []) {
    const row = providers.get(cursor.provider) ?? {
      provider: cursor.provider,
      status: "cursor_seen",
      route: providerRouteType(cursor.provider),
      configured: true,
      operator_only: true,
      provider_api_call_allowed: false,
      command: "npm --silent run hermes:events",
    };
    row.cursor_blocked = Boolean(cursor.resync_required) || (cursorsBlocked && cursor.provider === "odds_api_io");
    providers.set(cursor.provider, row);
  }
  if (currentStep?.provider && !providers.has(currentStep.provider)) {
    providers.set(currentStep.provider, {
      provider: currentStep.provider,
      status: currentStep.status ?? "current_step",
      route: providerRouteType(currentStep.provider),
      configured: Boolean(currentStep.configured),
      cursor_blocked: false,
      operator_only: true,
      provider_api_call_allowed: false,
      command: currentStep.smoke_command ?? "npm --silent run hermes:budget-chain",
    });
  }
  return [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

function parseBudgetChainStep(value) {
  const match = String(value ?? "").match(/^\d+\.\s*([^:]+):(.+)$/);
  if (!match) return null;
  return {
    provider: match[1],
    capability: match[2],
    status: "current_step",
    configured: false,
  };
}

function providerRouteType(provider) {
  const normalized = String(provider ?? "").toLowerCase();
  if (normalized === "api_tennis") return "score_livescore";
  if (normalized === "odds_api_io") return "odds_websocket";
  if (normalized === "theoddsapi") return "archive_odds";
  if (["sportradar", "betradar", "txodds"].includes(normalized)) return "enterprise_deferred";
  return "operator_review";
}

function chooseSourceDiscoveryCommand({ cursorsBlocked, budgetCompleted, providerRoutes }) {
  if (!budgetCompleted || providerRoutes.some((route) => route.status === "ready_next")) {
    return sourceCommand("npm --silent run hermes:budget-chain", "Review the next budget provider onboarding step without spending quota.");
  }
  if (cursorsBlocked) {
    return sourceCommand("npm --silent run hermes:events", "Resolve cursor or stale-feed blockers before any provider route changes.");
  }
  return sourceCommand("npm --silent run hermes:collection-plan", "Review collection cadence candidates without executing provider calls.");
}

function sourceCommand(command, reason) {
  return {
    command,
    reason,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
  };
}

function chooseAutonomyLane(loop, runtimePriorities) {
  if (loop.status === "safety_stop") {
    return autonomyLane("safety_stop", 0, "safety", "Stop all automation and inspect real-execution safety.");
  }
  if (loop.status === "runtime_partial" && loop.read_only_runtime_route) {
    return autonomyLane(
      "partial_runtime_read_only",
      10,
      "local_runtime",
      "Use Hermes for read-only operator summaries while doctor/channel/paper gates remain blocked."
    );
  }
  if (loop.runtime?.status !== "ready") {
    return autonomyLane("stabilize_runtime", 10, "local_runtime", "Fix Hermes local runtime diagnostics before protected automation.");
  }
  const topRuntimePriority = currentRuntimePriority(loop, runtimePriorities);
  if (topRuntimePriority) {
    return autonomyLane(
      topRuntimePriority.id,
      topRuntimePriority.priority,
      topRuntimePriority.lane,
      topRuntimePriority.reason
    );
  }
  if (loop.quota_plan?.throttle_level === "blocked") {
    return autonomyLane("freeze_provider_collection", 20, "cost_guard", "Keep provider traffic frozen while quota/cost gates are blocked.");
  }
  if (!loop.budget_chain?.completed) {
    return autonomyLane("complete_budget_chain", 30, "provider_onboarding", "Complete the budget provider chain before enterprise or live paper readiness.");
  }
  if (loop.event_summary?.can_run_paper_autopilot) {
    return autonomyLane("paper_autopilot_review", 40, "paper_trading", "Backend gates allow paper autopilot review; real execution remains blocked.");
  }
  return autonomyLane("observe_and_collect", 50, "observe", "Keep collecting deterministic status and learning evidence.");
}

function currentRuntimePriority(loop, runtimePriorities) {
  const runtimeReady = loop.runtime?.status === "ready";
  return (runtimePriorities.priorities ?? []).find((priority) => (
    !runtimeReady || priority.lane !== "local_runtime"
  )) ?? null;
}

function autonomyLane(id, priority, lane, reason) {
  return {
    id,
    priority,
    lane,
    reason,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
  };
}

function buildAutonomyMatrix(loop) {
  const providerFrozen = loop.provider_api_call_allowed === false || loop.quota_plan?.throttle_level === "blocked";
  const liveStats = loop.live_stats ?? {};
  return {
    runtime: {
      status: loop.status === "runtime_partial" ? "partial_read_only" : loop.runtime?.status ?? "unknown",
      capability: loop.runtime_capability ?? loop.runtime?.capability_summary ?? null,
      autonomy_impact: loop.runtime_autonomy_impact ?? loop.runtime?.autonomy_impact ?? null,
      read_only_runtime_route: loop.read_only_runtime_route ?? null,
      reason: loop.read_only_runtime_route
        ? "Hermes can produce read-only operator packets while protected autonomy gates stay blocked."
        : "Hermes runtime capability is summarized from local diagnostics.",
    },
    collect: {
      status: providerFrozen ? "frozen" : "candidate",
      source: providerFrozen ? "persisted_replay_and_internal_status" : "licensed_provider_api",
      provider_api_call_allowed: false,
      reason: providerFrozen
        ? "Provider calls stay frozen until budget, freshness and cursor gates clear."
        : "Provider calls still require an explicit operator command.",
    },
    process: {
      status: loop.source_mode === "live" && !providerFrozen ? "live_candidate" : "replay_only",
      source: "FastAPI_canonical_state",
      writes: false,
      reason: "Hermes reads canonical backend state; Python/Postgres own tick processing.",
    },
    live_statistics: {
      status: liveStats.collection_status ?? "unknown",
      sampling_policy: liveStats.sampling_policy?.name ?? "unknown",
      health_scores: liveStats.health_scores ?? {},
      llm_per_tick_allowed: false,
      reason: "Live math stays deterministic; Hermes summarizes state thresholds.",
    },
    paper_autopilot: {
      status: loop.event_summary?.can_run_paper_autopilot ? "candidate" : "blocked",
      can_create_paper_orders: false,
      reason: loop.event_summary?.can_run_paper_autopilot
        ? "Only backend autopilot may create paper orders after admin-token gates."
        : "Blocked until event router and backend gates allow paper autopilot.",
    },
    learning: {
      status: loop.learning_review?.review_status ?? "unknown",
      model_route: loop.learning_review?.model_route ?? null,
      reason: "Strong model review is periodic; promotion remains deterministic and offline.",
    },
    enterprise: {
      status: loop.budget_chain?.enterprise_eligible ? "eligible" : "locked",
      reason: "Enterprise feeds stay locked until the budget chain is complete and proven.",
    },
  };
}

function buildAutonomyActionQueue(loop, runtimePriorities) {
  const actions = [];
  if (loop.next_best_command) {
    actions.push(autonomyAction({
      id: loop.next_best_command.id,
      command: loop.next_best_command.command,
      reason: loop.next_best_command.reason,
      priority: 10,
      source: "safe_loop",
      requiresAdminToken: loop.next_best_command.requires_admin_token,
      writes: loop.next_best_command.writes,
    }));
  }
  if (loop.read_only_runtime_route
    && !actions.some((item) => item.command === loop.read_only_runtime_route.command)) {
    actions.push(autonomyAction({
      id: loop.read_only_runtime_route.id,
      command: loop.read_only_runtime_route.command,
      reason: loop.read_only_runtime_route.reason,
      priority: 12,
      source: "runtime_capability",
      requiresAdminToken: loop.read_only_runtime_route.requires_admin_token,
      writes: loop.read_only_runtime_route.writes,
    }));
  }
  const runtimeReady = loop.runtime?.status === "ready";
  for (const priority of runtimePriorities.priorities
    .filter((item) => !runtimeReady || item.lane !== "local_runtime")
    .slice(0, 3)) {
    actions.push(autonomyAction({
      id: priority.id,
      command: priority.diagnostic_command,
      reason: priority.reason,
      priority: priority.priority,
      source: "operator_ledger",
      requiresAdminToken: priority.requires_admin_token,
      writes: priority.writes,
    }));
  }
  for (const command of (loop.safe_commands ?? []).slice(0, 5)) {
    if (actions.some((item) => item.command === command.command)) continue;
    actions.push(autonomyAction({
      id: command.id,
      command: command.command,
      reason: command.reason,
      priority: 80,
      source: "safe_commands",
      requiresAdminToken: command.requires_admin_token,
      writes: command.writes,
    }));
  }
  return actions.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function autonomyAction({ id, command, reason, priority, source, requiresAdminToken = false, writes = false }) {
  return {
    id,
    command,
    reason,
    priority,
    source,
    executes_now: false,
    writes: Boolean(writes),
    live_api_calls: false,
    provider_api_call_allowed: false,
    requires_admin_token: Boolean(requiresAdminToken),
    can_create_paper_orders: false,
    can_submit_real_orders: false,
  };
}

function safeLoopStatus({ runtime, eventPlan }) {
  if (eventPlan.events.some((item) => item.type === "real_execution_safety_violation")) {
    return "safety_stop";
  }
  if (runtimePartialAvailable(runtime)) {
    return "runtime_partial";
  }
  if (runtime.status !== "ready") {
    return "runtime_degraded";
  }
  if (["critical", "high"].includes(eventPlan.severity)) {
    return "blocked";
  }
  if (eventPlan.can_run_paper_autopilot) {
    return "paper_candidate";
  }
  return "monitor";
}

function safeLoopCommands({ runtime, eventPlan, budgetPlan, unblock, playbookPlan, liveStatsPlan, quotaPlan }) {
  const commands = [];
  commands.push(loopCommand({
    id: "observe_intelligence",
    command: "npm --silent run hermes:intelligence",
    reason: "Read internal APIs and summarize the operator packet.",
  }));
  commands.push(loopCommand({
    id: "route_events",
    command: "npm --silent run hermes:events",
    reason: "Convert state into deterministic event triggers.",
  }));
  commands.push(loopCommand({
    id: "live_stats",
    command: "npm --silent run hermes:live-stats",
    reason: `Current sampling policy is ${liveStatsPlan.sampling_policy?.name ?? "unknown"}.`,
  }));
  commands.push(loopCommand({
    id: "quota_plan",
    command: "npm --silent run hermes:quota-plan",
    reason: `Current quota throttle is ${quotaPlan.throttle?.level ?? "unknown"}.`,
  }));
  if (runtime.status !== "ready" || unblock.lanes.some((lane) => lane.id === "local_runtime")) {
    commands.push(loopCommand({
      id: "runtime_check",
      command: runtimeReviewCommand(runtime.runtime_findings),
      reason: runtimeReviewReason(runtime.runtime_findings),
    }));
  }
  for (const step of playbookPlan.steps.filter((item) => item.status === "ready")) {
    commands.push(loopCommand({
      id: step.id,
      command: step.command,
      reason: step.reason,
      writes: step.writes,
      liveApiCalls: step.live_api_calls,
      requiresAdminToken: step.requires_admin_token,
      canCreatePaperOrders: false,
    }));
  }
  if (budgetPlan.current_step && !budgetPlan.current_step.smoke_completed) {
    commands.push(loopCommand({
      id: "provider_smoke_dry_run",
      command: "npm run hermes:provider-smoke",
      reason: "Show the current budget provider smoke plan; execution still requires explicit operator flag.",
      writes: false,
      liveApiCalls: false,
    }));
  }
  if (eventPlan.can_run_paper_autopilot) {
    commands.push(loopCommand({
      id: "paper_autopilot_candidate",
      command: "npm run hermes:autopilot",
      reason: "Paper-only candidate exists, but safe-loop itself never creates orders.",
      writes: true,
      liveApiCalls: false,
      requiresAdminToken: true,
      canCreatePaperOrders: true,
    }));
  }
  return dedupeLoopCommands(commands);
}

function runtimePartialAvailable(runtime) {
  return runtime?.autonomy_impact?.status === "partial_runtime_available";
}

function buildReadOnlyRuntimeRoute(runtime) {
  if (!runtimePartialAvailable(runtime)) return null;
  return {
    id: "partial_runtime_operator_summary",
    command: "npm --silent run hermes:operator-packet",
    reason: runtime.autonomy_impact?.reason
      ?? "Hermes can generate read-only operator packets while protected autonomy gates remain blocked.",
    status: runtime.autonomy_impact?.status ?? "partial_runtime_available",
    allowed_now: runtime.autonomy_impact?.allowed_now ?? [],
    blocked_until_operator_fix: runtime.autonomy_impact?.blocked_until_operator_fix ?? [],
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    requires_admin_token: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    llm_per_tick_allowed: false,
  };
}

function chooseSafeLoopCommand({ runtime, unblock, eventPlan, safeCommands }) {
  if (eventPlan.events.some((item) => item.type === "real_execution_safety_violation")) {
    return safeCommands.find((item) => item.id === "route_events") ?? safeCommands[0] ?? null;
  }
  if (runtime.status !== "ready" || unblock.lanes.some((lane) => lane.id === "local_runtime")) {
    return safeCommands.find((item) => item.id === "runtime_check") ?? safeCommands[0] ?? null;
  }
  if (["critical", "high"].includes(eventPlan.severity)) {
    return safeCommands.find((item) => item.id === "route_events") ?? safeCommands[0] ?? null;
  }
  if (eventPlan.can_run_paper_autopilot) {
    return safeCommands.find((item) => item.id === "paper_autopilot_candidate") ?? safeCommands[0] ?? null;
  }
  return safeCommands.find((item) => item.id === "live_stats") ?? safeCommands[0] ?? null;
}

function buildOperatorPacket(loop) {
  const nextAction = loop.next_best_command ?? null;
  const priority = operatorPriority(loop);
  const readOnlyRoute = loop.read_only_runtime_route ?? null;
  return {
    generated_at: new Date().toISOString(),
    mode: "operator_packet",
    channel: "telegram_openclaw",
    status: loop.status,
    priority,
    headline: operatorHeadline(loop, priority),
    short_message: operatorShortMessage(loop, nextAction, priority),
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    next_action: nextAction,
    read_only_route: readOnlyRoute,
    cost_guard: {
      throttle_level: loop.quota_plan?.throttle_level,
      budget_utilization: loop.quota_plan?.budget_utilization,
      provider_command_count: loop.quota_plan?.provider_command_count ?? 0,
      provider_api_call_allowed: false,
    },
    runtime: {
      status: loop.runtime?.status,
      next_actions: loop.runtime?.next_actions ?? [],
      capability_summary: loop.runtime_capability ?? loop.runtime?.capability_summary ?? null,
      autonomy_impact: loop.runtime_autonomy_impact ?? loop.runtime?.autonomy_impact ?? null,
    },
    data_health: {
      event_severity: loop.event_summary?.severity,
      collection_status: loop.live_stats?.collection_status,
      processing_status: loop.live_stats?.processing_status,
      overall_score: loop.live_stats?.health_scores?.overall,
    },
    budget_chain: {
      completed: Boolean(loop.budget_chain?.completed),
      enterprise_eligible: false,
      current_step_label: loop.budget_chain?.current_step_label ?? null,
    },
    safety: {
      real_execution_hard_block: loop.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
    },
    forbidden_actions: loop.forbidden_actions ?? [],
  };
}

function buildOperatorLedger(packet) {
  const path = operatorLedgerPath();
  const record = {
    generated_at: new Date().toISOString(),
    mode: "operator_ledger_record",
    packet,
    outcome: "observed",
    action_executed: false,
    executed_commands: [],
    next_action_command: packet.next_action?.command ?? null,
    safety: packet.safety,
  };
  return {
    generated_at: new Date().toISOString(),
    mode: "operator_ledger",
    status: packet.status,
    priority: packet.priority,
    read_only: false,
    writes: true,
    write_scope: "local_operator_jsonl_only",
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    executed_commands: [],
    ledger: {
      path,
      format: "jsonl",
      retention_note: "Local Hermes operator trace; do not commit runtime logs.",
    },
    record,
    safety: {
      real_execution_hard_block: packet.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
    },
  };
}

function operatorLedgerPath() {
  return process.env.HERMES_OPERATOR_LEDGER_PATH || "hermes/runs/operator-ledger.jsonl";
}

function writeOperatorLedger(record) {
  const path = operatorLedgerPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

function readOperatorLedgerRecords() {
  const path = operatorLedgerPath();
  if (!existsSync(path)) {
    return { path, records: [], invalid_rows: 0 };
  }
  const content = readFileSync(path, "utf8");
  let invalidRows = 0;
  const records = content
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        invalidRows += 1;
        return [];
      }
    });
  return { path, records, invalid_rows: invalidRows };
}

function buildOperatorLedgerReport({ path, records, invalid_rows: invalidRows }) {
  const nextActionCounts = rankedCounts(records.map((record) => record.next_action_command).filter(Boolean));
  return {
    generated_at: new Date().toISOString(),
    mode: "operator_ledger_report",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    ledger: {
      path,
      format: "jsonl",
      invalid_rows: invalidRows,
    },
    total_records: records.length,
    action_executed_count: records.filter((record) => record.action_executed === true).length,
    priority_counts: countValues(records.map((record) => record.packet?.priority).filter(Boolean)),
    status_counts: countValues(records.map((record) => record.packet?.status).filter(Boolean)),
    outcome_counts: countValues(records.map((record) => record.outcome).filter(Boolean)),
    throttle_counts: countValues(records.map((record) => record.packet?.cost_guard?.throttle_level).filter(Boolean)),
    next_action_counts: nextActionCounts,
    top_blocker: nextActionCounts[0]?.command ?? null,
    safety: {
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
    },
  };
}

function buildLiveControllerLedger(controller) {
  const path = liveControllerLedgerPath();
  const decision = controller.operator_decision ?? {};
  const record = {
    generated_at: new Date().toISOString(),
    mode: "live_controller_ledger_record",
    controller,
    outcome: "observed",
    action_executed: false,
    collection_command_executed: false,
    provider_command_executed: false,
    paper_order_created: false,
    status: controller.status,
    action: decision.action ?? null,
    next_safe_command: decision.next_safe_command?.command ?? null,
    provider_candidate_command: decision.provider_candidate?.command ?? null,
    protected_backend_command: decision.protected_backend_action?.command ?? null,
    throttle_level: controller.quota?.throttle?.level ?? null,
    source_route_id: decision.source_route_id ?? null,
    top_match_id: decision.top_match_id ?? null,
    safety: controller.safety,
  };
  return {
    generated_at: new Date().toISOString(),
    mode: "live_controller_ledger",
    status: controller.status,
    action: decision.action ?? null,
    read_only: false,
    writes: true,
    write_scope: "local_live_controller_jsonl_only",
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    executed_commands: [],
    ledger: {
      path,
      format: "jsonl",
      retention_note: "Local Hermes live-controller trace; do not commit runtime logs.",
    },
    record,
    safety: {
      real_execution_hard_block: controller.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function liveControllerLedgerPath() {
  return process.env.HERMES_LIVE_CONTROLLER_LEDGER_PATH || "hermes/runs/live-controller-ledger.jsonl";
}

function writeLiveControllerLedger(record) {
  const path = liveControllerLedgerPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

function readLiveControllerLedgerRecords() {
  const path = liveControllerLedgerPath();
  if (!existsSync(path)) {
    return { path, records: [], invalid_rows: 0 };
  }
  const content = readFileSync(path, "utf8");
  let invalidRows = 0;
  const records = content
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        invalidRows += 1;
        return [];
      }
    });
  return { path, records, invalid_rows: invalidRows };
}

function buildLiveControllerLedgerReport({ path, records, invalid_rows: invalidRows }) {
  const nextCommandCounts = rankedCounts(records.map((record) => record.next_safe_command).filter(Boolean));
  const providerCandidateCounts = rankedCounts(records.map((record) => record.provider_candidate_command).filter(Boolean));
  return {
    generated_at: new Date().toISOString(),
    mode: "live_controller_ledger_report",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    ledger: {
      path,
      format: "jsonl",
      invalid_rows: invalidRows,
    },
    total_records: records.length,
    action_executed_count: records.filter((record) => record.action_executed === true).length,
    collection_command_executed_count: records.filter((record) => record.collection_command_executed === true).length,
    provider_command_executed_count: records.filter((record) => record.provider_command_executed === true).length,
    paper_order_created_count: records.filter((record) => record.paper_order_created === true).length,
    status_counts: countValues(records.map((record) => record.status).filter(Boolean)),
    action_counts: countValues(records.map((record) => record.action).filter(Boolean)),
    throttle_counts: countValues(records.map((record) => record.throttle_level).filter(Boolean)),
    source_route_counts: countValues(records.map((record) => record.source_route_id).filter(Boolean)),
    next_safe_command_counts: nextCommandCounts,
    provider_candidate_counts: providerCandidateCounts,
    top_repeated_action: rankedCounts(records.map((record) => record.action).filter(Boolean))[0]?.command ?? null,
    top_next_safe_command: nextCommandCounts[0]?.command ?? null,
    top_provider_candidate: providerCandidateCounts[0]?.command ?? null,
    latest_record: records[records.length - 1] ?? null,
    safety: {
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function buildGrandSlamMissionLedger(mission) {
  const path = grandSlamMissionLedgerPath();
  const record = {
    generated_at: new Date().toISOString(),
    mode: "grand_slam_mission_ledger_record",
    outcome: "observed",
    action_executed: false,
    mission_command_executed: false,
    provider_command_executed: false,
    paper_order_created: false,
    status: mission.status,
    active_phase: mission.active_phase ?? null,
    next_action_command: mission.next_action?.command ?? null,
    next_action_id: mission.next_action?.id ?? null,
    grand_slam_status: mission.grand_slam_readiness?.status ?? null,
    paper_ready: Boolean(mission.grand_slam_readiness?.paper_ready),
    prediction_ready: Boolean(mission.grand_slam_readiness?.prediction_ready),
    visible_matches: mission.grand_slam_readiness?.matches?.grand_slam_visible ?? 0,
    prediction_rows: mission.grand_slam_readiness?.matches?.prediction_rows ?? 0,
    paper_candidates: mission.grand_slam_readiness?.matches?.paper_candidates ?? 0,
    active_grand_slams: (mission.grand_slam_readiness?.active_grand_slams ?? []).map((slam) => slam.id ?? slam.name).filter(Boolean),
    historical_next_source: mission.historical_backfill?.next_source?.id ?? null,
    historical_license_review_required: mission.historical_backfill?.review_summary?.license_review_required ?? 0,
    live_controller_status: mission.live_control?.status ?? null,
    quota_level: mission.live_control?.quota_throttle?.level ?? null,
    learning_review_status: mission.learning_review?.status ?? null,
    safe_jailbreak_bypass_allowed: mission.safe_jailbreak_policy?.bypass_allowed === true,
    packet: compactGrandSlamMissionPacket(mission),
    safety: mission.safety,
  };
  return {
    generated_at: new Date().toISOString(),
    mode: "grand_slam_mission_ledger",
    status: mission.status,
    active_phase: mission.active_phase ?? null,
    read_only: false,
    writes: true,
    write_scope: "local_grand_slam_mission_jsonl_only",
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    executed_commands: [],
    ledger: {
      path,
      format: "jsonl",
      retention_note: "Local Hermes Grand Slam mission trace; do not commit runtime logs.",
    },
    record,
    safety: {
      real_execution_hard_block: mission.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function compactGrandSlamMissionPacket(mission) {
  return {
    mode: mission.mode,
    status: mission.status,
    active_phase: mission.active_phase,
    mission_summary: mission.mission_summary,
    next_action: {
      id: mission.next_action?.id ?? null,
      command: mission.next_action?.command ?? null,
      executes_now: false,
      provider_api_call_allowed: false,
      can_create_paper_orders: Boolean(mission.next_action?.can_create_paper_orders),
      can_submit_real_orders: false,
    },
    phases: (mission.phases ?? []).map((phase) => ({
      id: phase.id,
      status: phase.status,
      active: Boolean(phase.active),
      command: phase.command,
      blocker_count: (phase.blockers ?? []).length,
      can_create_paper_orders: Boolean(phase.can_create_paper_orders),
      executes_now: false,
    })),
    grand_slam_readiness: {
      status: mission.grand_slam_readiness?.status,
      prediction_ready: Boolean(mission.grand_slam_readiness?.prediction_ready),
      paper_ready: Boolean(mission.grand_slam_readiness?.paper_ready),
      visible_matches: mission.grand_slam_readiness?.matches?.grand_slam_visible ?? 0,
      prediction_rows: mission.grand_slam_readiness?.matches?.prediction_rows ?? 0,
      paper_candidates: mission.grand_slam_readiness?.matches?.paper_candidates ?? 0,
    },
    historical_backfill: {
      status: mission.historical_backfill?.status,
      next_source_id: mission.historical_backfill?.next_source?.id ?? null,
      license_review_required: mission.historical_backfill?.review_summary?.license_review_required ?? 0,
    },
    live_control: {
      status: mission.live_control?.status,
      collection_status: mission.live_control?.collection_status,
      quota_level: mission.live_control?.quota_throttle?.level ?? null,
      provider_command_count: mission.live_control?.provider_command_count ?? 0,
      provider_commands_allowed: false,
    },
    safety: {
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function grandSlamMissionLedgerPath() {
  return process.env.HERMES_GRAND_SLAM_MISSION_LEDGER_PATH || "hermes/runs/grand-slam-mission-ledger.jsonl";
}

function writeGrandSlamMissionLedger(record) {
  const path = grandSlamMissionLedgerPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

function readGrandSlamMissionLedgerRecords() {
  const path = grandSlamMissionLedgerPath();
  if (!existsSync(path)) {
    return { path, records: [], invalid_rows: 0 };
  }
  const content = readFileSync(path, "utf8");
  let invalidRows = 0;
  const records = content
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        invalidRows += 1;
        return [];
      }
    });
  return { path, records, invalid_rows: invalidRows };
}

function buildGrandSlamMissionLedgerReport({ path, records, invalid_rows: invalidRows }) {
  const nextActionCounts = rankedCounts(records.map((record) => record.next_action_command).filter(Boolean));
  const activePhaseCounts = countValues(records.map((record) => record.active_phase).filter(Boolean));
  return {
    generated_at: new Date().toISOString(),
    mode: "grand_slam_mission_ledger_report",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    ledger: {
      path,
      format: "jsonl",
      invalid_rows: invalidRows,
    },
    total_records: records.length,
    action_executed_count: records.filter((record) => record.action_executed === true).length,
    mission_command_executed_count: records.filter((record) => record.mission_command_executed === true).length,
    provider_command_executed_count: records.filter((record) => record.provider_command_executed === true).length,
    paper_order_created_count: records.filter((record) => record.paper_order_created === true).length,
    status_counts: countValues(records.map((record) => record.status).filter(Boolean)),
    active_phase_counts: activePhaseCounts,
    grand_slam_status_counts: countValues(records.map((record) => record.grand_slam_status).filter(Boolean)),
    historical_source_counts: countValues(records.map((record) => record.historical_next_source).filter(Boolean)),
    live_controller_status_counts: countValues(records.map((record) => record.live_controller_status).filter(Boolean)),
    quota_level_counts: countValues(records.map((record) => record.quota_level).filter(Boolean)),
    learning_review_status_counts: countValues(records.map((record) => record.learning_review_status).filter(Boolean)),
    next_action_counts: nextActionCounts,
    top_active_phase: rankedCounts(records.map((record) => record.active_phase).filter(Boolean))[0]?.command ?? null,
    top_next_action: nextActionCounts[0]?.command ?? null,
    repeated_blockers: grandSlamMissionRepeatedBlockers(records),
    next_recommendation: grandSlamMissionLedgerRecommendation(records, activePhaseCounts, nextActionCounts),
    latest_record: records[records.length - 1] ?? null,
    safety: {
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function grandSlamMissionRepeatedBlockers(records) {
  return rankedCounts(records
    .filter((record) => ["blocked", "monitor"].includes(record.status))
    .map((record) => record.active_phase)
    .filter(Boolean))
    .map((row) => ({
      phase: row.command,
      count: row.count,
      example_next_action: records.find((record) => record.active_phase === row.command)?.next_action_command ?? null,
    }));
}

function grandSlamMissionLedgerRecommendation(records, activePhaseCounts, nextActionCounts) {
  const topPhase = rankedCounts(records.map((record) => record.active_phase).filter(Boolean))[0]?.command ?? null;
  const command = nextActionCounts[0]?.command ?? "npm --silent run hermes:grand-slam-mission";
  if (!records.length) {
    return grandSlamMissionRecommendation({
      id: "collect_grand_slam_mission_evidence",
      reason: "No Grand Slam mission rows exist yet; collect local evidence before changing code.",
      command: "npm --silent run hermes:grand-slam-mission-ledger",
      phase: null,
    });
  }
  if ((activePhaseCounts.restore_operational_truth ?? 0) > 0) {
    return grandSlamMissionRecommendation({
      id: "restore_operational_truth",
      reason: "Grand Slam prediction readiness is repeatedly blocked before model work; restore backend/Postgres operational truth first.",
      command: "npm --silent run hermes:backend-readiness",
      phase: "restore_operational_truth",
    });
  }
  if ((activePhaseCounts.offline_backfill ?? 0) > 0) {
    return grandSlamMissionRecommendation({
      id: "expand_offline_priors",
      reason: "The Grand Slam mission is off-calendar; historical priors and backtest depth are the best allowed accuracy work.",
      command: "npm --silent run hermes:historical-backfill-plan",
      phase: "offline_backfill",
    });
  }
  if (["feed_visibility", "model_input_gap", "prediction_watch"].includes(topPhase)) {
    return grandSlamMissionRecommendation({
      id: "harden_prediction_visibility",
      reason: "Grand Slam rows or probability rows are repeatedly incomplete; harden match visibility and prediction readiness before autonomy changes.",
      command: "npm --silent run hermes:grand-slam-readiness",
      phase: topPhase,
    });
  }
  if ((activePhaseCounts.paper_learning ?? 0) > 0) {
    return grandSlamMissionRecommendation({
      id: "review_paper_learning",
      reason: "Grand Slam paper-ready windows are appearing; review protected paper learning evidence without creating orders from the ledger.",
      command: "npm --silent run hermes:learning-review",
      phase: "paper_learning",
    });
  }
  return grandSlamMissionRecommendation({
    id: "observe_grand_slam_mission",
    reason: "No repeated Grand Slam blocker is dominant yet; keep observing the mission packet.",
    command,
    phase: topPhase,
  });
}

function grandSlamMissionRecommendation({ id, reason, command, phase }) {
  return {
    id,
    reason,
    command,
    phase,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    operator_note: "No report action executes automatically.",
  };
}

function buildMissionLedger(mission) {
  const path = missionLedgerPath();
  const record = {
    generated_at: new Date().toISOString(),
    mode: "mission_ledger_record",
    mission,
    status: mission.status,
    active_ceiling: mission.active_ceiling ?? null,
    outcome: "observed",
    action_executed: false,
    mission_command_executed: false,
    executed_commands: [],
    next_action_lane: mission.next_action?.lane ?? null,
    next_action_command: mission.next_action?.command ?? null,
    blocked_lane_ids: (mission.lanes ?? [])
      .filter((lane) => lane.status === "blocked")
      .map((lane) => lane.id),
    safety: mission.safety,
  };
  return {
    generated_at: new Date().toISOString(),
    mode: "mission_ledger",
    status: mission.status,
    active_ceiling: mission.active_ceiling ?? null,
    read_only: false,
    writes: true,
    write_scope: "local_mission_jsonl_only",
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    executed_commands: [],
    ledger: {
      path,
      format: "jsonl",
      retention_note: "Local Hermes mission-control trace; do not commit runtime logs.",
    },
    record,
    safety: {
      real_execution_hard_block: mission.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function missionLedgerPath() {
  return process.env.HERMES_MISSION_LEDGER_PATH || "hermes/runs/mission-ledger.jsonl";
}

function writeMissionLedger(record) {
  const path = missionLedgerPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

function readMissionLedgerRecords() {
  const path = missionLedgerPath();
  if (!existsSync(path)) {
    return { path, records: [], invalid_rows: 0 };
  }
  const content = readFileSync(path, "utf8");
  let invalidRows = 0;
  const records = content
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        invalidRows += 1;
        return [];
      }
    });
  return { path, records, invalid_rows: invalidRows };
}

function buildMissionLedgerReport({ path, records, invalid_rows: invalidRows }) {
  const nextActionCounts = rankedCounts(records.map((record) => record.next_action_command).filter(Boolean));
  return {
    generated_at: new Date().toISOString(),
    mode: "mission_ledger_report",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    ledger: {
      path,
      format: "jsonl",
      invalid_rows: invalidRows,
    },
    total_records: records.length,
    action_executed_count: records.filter((record) => record.action_executed === true).length,
    mission_command_executed_count: records.filter((record) => record.mission_command_executed === true).length,
    status_counts: countValues(records.map((record) => record.status ?? record.mission?.status).filter(Boolean)),
    active_ceiling_counts: countValues(records.map((record) => record.active_ceiling).filter(Boolean)),
    next_lane_counts: countValues(records.map((record) => record.next_action_lane).filter(Boolean)),
    blocked_lane_counts: countValues(records.flatMap((record) => record.blocked_lane_ids ?? [])),
    next_action_counts: nextActionCounts,
    top_next_action: nextActionCounts[0]?.command ?? null,
    latest_record: records[records.length - 1] ?? null,
    safety: {
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function countValues(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function rankedCounts(values) {
  const counts = countValues(values);
  return Object.entries(counts)
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count || a.command.localeCompare(b.command));
}

function buildRuntimeFixPriorities(report) {
  const priorities = report.next_action_counts
    .map((row) => runtimePriorityFor(row))
    .filter(Boolean)
    .sort((a, b) => a.priority - b.priority || b.frequency - a.frequency || a.id.localeCompare(b.id));
  return {
    generated_at: new Date().toISOString(),
    mode: "runtime_fix_priorities",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    ledger_report: {
      ledger: report.ledger,
      total_records: report.total_records,
      action_executed_count: report.action_executed_count,
      top_blocker: report.top_blocker,
      priority_counts: report.priority_counts,
      status_counts: report.status_counts,
      throttle_counts: report.throttle_counts,
    },
    next_priority: priorities[0] ?? null,
    priorities,
    operator_note: "No priority executes automatically; run the referenced diagnostic commands from a local operator shell only.",
    safety: {
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
    },
  };
}

function runtimePriorityFor(row) {
  const command = row.command;
  if (command === "npm run hermes:doctor-triage") {
    return runtimePriority({
      id: "triage_hermes_doctor_timeout",
      priority: 5,
      lane: "local_runtime",
      sourceCommand: command,
      frequency: row.count,
      reason: "Hermes doctor timeout triage is the most specific runtime blocker.",
      diagnosticCommand: "npm run hermes:doctor-triage",
    });
  }
  if (command === "npm run hermes:runtime-check") {
    return runtimePriority({
      id: "stabilize_hermes_runtime",
      priority: 10,
      lane: "local_runtime",
      sourceCommand: command,
      frequency: row.count,
      reason: "Hermes runtime diagnostics are the most repeated next action.",
      diagnosticCommand: "npm run hermes:runtime-check",
    });
  }
  if (command === "npm --silent run hermes:events") {
    return runtimePriority({
      id: "inspect_event_router_blockers",
      priority: 20,
      lane: "event_routing",
      sourceCommand: command,
      frequency: row.count,
      reason: "Event routing blockers are recurring in operator decisions.",
      diagnosticCommand: "npm --silent run hermes:events",
    });
  }
  if (command === "npm --silent run hermes:quota-plan") {
    return runtimePriority({
      id: "review_quota_throttle",
      priority: 30,
      lane: "cost_guard",
      sourceCommand: command,
      frequency: row.count,
      reason: "Quota throttle review is recurring in operator decisions.",
      diagnosticCommand: "npm --silent run hermes:quota-plan",
    });
  }
  return runtimePriority({
    id: `review_${slug(command)}`,
    priority: 90,
    lane: "operator_review",
    sourceCommand: command,
    frequency: row.count,
    reason: "Repeated next action has no specialized remediation lane yet.",
    diagnosticCommand: command,
  });
}

function runtimePriority({
  id,
  priority,
  lane,
  sourceCommand,
  frequency,
  reason,
  diagnosticCommand,
}) {
  return {
    id,
    priority,
    lane,
    source_command: sourceCommand,
    frequency,
    reason,
    diagnostic_command: diagnosticCommand,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    requires_admin_token: false,
  };
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "unknown";
}

function operatorPriority(loop) {
  if (loop.status === "safety_stop") return "critical";
  if (["runtime_degraded", "runtime_partial"].includes(loop.status)) return "high";
  if (["critical", "high"].includes(loop.event_summary?.severity)) return "high";
  if (loop.status === "paper_candidate") return "medium";
  if (loop.quota_plan?.throttle_level && loop.quota_plan.throttle_level !== "normal") return "medium";
  return "low";
}

function operatorHeadline(loop, priority) {
  return `${priority.toUpperCase()} | ${loop.status} | ${loop.active_phase}`;
}

function operatorShortMessage(loop, nextAction, priority) {
  const budget = formatPercent(loop.quota_plan?.budget_utilization);
  const command = nextAction?.command ?? "none";
  const reason = nextAction?.reason ?? "No safe command selected.";
  const runtimeImpact = loop.runtime_autonomy_impact?.status
    ? `/${loop.runtime_autonomy_impact.status}`
    : "";
  const route = loop.read_only_runtime_route?.command
    ? ` Read-only route: ${loop.read_only_runtime_route.command}.`
    : "";
  const reasonSentence = reason.endsWith(".") ? reason : `${reason}.`;
  return [
    `Hermes ${priority}: ${loop.status} in ${loop.active_phase}.`,
    `Runtime=${loop.runtime?.status}${runtimeImpact}; data=${loop.live_stats?.collection_status}/${loop.live_stats?.processing_status}; quota=${loop.quota_plan?.throttle_level ?? "unknown"} (${budget}).`,
    `Next: ${command}.`,
    `Why: ${reasonSentence}${route}`,
    "No provider calls, paper orders, or real execution from this packet.",
  ].join(" ");
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "unknown";
  return `${Math.round(value * 100)}%`;
}

function loopCommand({
  id,
  command,
  reason,
  writes = false,
  liveApiCalls = false,
  requiresAdminToken = false,
  canCreatePaperOrders = false,
}) {
  return {
    id,
    command,
    reason,
    writes,
    live_api_calls: liveApiCalls,
    requires_admin_token: requiresAdminToken,
    can_create_paper_orders: canCreatePaperOrders,
    can_submit_real_orders: false,
    provider_api_call_allowed: false,
  };
}

function dedupeLoopCommands(commands) {
  const seen = new Set();
  return commands.filter((item) => {
    const key = item.command;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildSchedulerRehearsal(loop, grandSlam = null) {
  const schedule = schedulerSchedule(loop, grandSlam);
  const nextTick = chooseSchedulerNextTick(loop, schedule);
  const auditPath = schedulerAuditPath();
  return {
    generated_at: new Date().toISOString(),
    mode: "scheduler_rehearsal",
    status: loop.status,
    source_mode: loop.source_mode,
    active_phase: loop.active_phase,
    read_only: false,
    writes: true,
    write_scope: "local_audit_jsonl_only",
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    executed_commands: [],
    next_tick: nextTick,
    schedule,
    safe_loop: {
      status: loop.status,
      active_phase: loop.active_phase,
      next_best_command: loop.next_best_command,
      read_only_runtime_route: loop.read_only_runtime_route ?? null,
      sampling_policy: loop.live_stats?.sampling_policy,
      safety: loop.safety,
    },
    grand_slam_readiness: grandSlam ? grandSlamScheduleSummary(grandSlam) : null,
    audit_log: {
      path: auditPath,
      format: "jsonl",
      retention_note: "Local operator artifact; do not commit runtime logs.",
    },
    forbidden_actions: loop.forbidden_actions,
    safety: {
      real_execution_hard_block: loop.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function schedulerSchedule(loop, grandSlam = null) {
  const policy = loop.live_stats?.sampling_policy ?? {};
  const baseMinutes = Number(policy.poll_interval_minutes ?? 5);
  const grandSlamCadence = grandSlamScheduleCadence(grandSlam);
  const safeLoopInterval = ["runtime_degraded", "runtime_partial"].includes(loop.status)
    ? 5
    : baseMinutes > 0
      ? baseMinutes
      : 5;
  const rows = [
    schedulerItem({
      id: "safe_loop",
      command: "npm --silent run hermes:safe-loop",
      everyMinutes: safeLoopInterval,
      reason: "Refresh the full autonomous packet without executing suggested actions.",
    }),
    schedulerItem({
      id: "autonomy_brief",
      command: "npm --silent run hermes:autonomy-brief",
      everyMinutes: safeLoopInterval,
      reason: "Refresh the highest-level autonomy matrix and action queue without executing actions.",
    }),
    schedulerItem({
      id: "source_discovery",
      command: "npm --silent run hermes:source-discovery",
      everyMinutes: 15,
      reason: "Review allowed acquisition paths and blocked source routes without spending provider quota.",
    }),
    schedulerItem({
      id: "source_use_manifest",
      command: "npm --silent run hermes:source-use-manifest",
      everyMinutes: 15,
      reason: "Audit source-use, license, attribution and quota gates before collection/import work.",
    }),
    schedulerItem({
      id: "source_use_ledger",
      command: "npm --silent run hermes:source-use-ledger",
      everyMinutes: 60,
      reason: "Persist source-use decisions locally so repeated license/quota/deferred blockers become visible.",
    }),
    schedulerItem({
      id: "source_intake_plan",
      command: "npm --silent run hermes:source-intake-plan",
      everyMinutes: 60,
      reason: "Convert source-use evidence into allowed, operator-review, deferred and forbidden intake queues without fetching data.",
    }),
    schedulerItem({
      id: "source_intake_ledger",
      command: "npm --silent run hermes:source-intake-ledger",
      everyMinutes: 120,
      reason: "Persist source-intake queue decisions locally so repeated import-contract choices become visible.",
    }),
    schedulerItem({
      id: "trigger_policy",
      command: "npm --silent run hermes:trigger-policy",
      everyMinutes: 5,
      reason: "Refresh safe wakeup triggers for cron, Telegram, dashboard, Cloudflare Agent, and OpenClaw gateway.",
    }),
    schedulerItem({
      id: "grand_slam_readiness",
      command: "npm --silent run hermes:grand-slam-readiness",
      everyMinutes: grandSlamCadence.every_minutes,
      reason: grandSlamCadence.reason,
    }),
    schedulerItem({
      id: "grand_slam_mission",
      command: "npm --silent run hermes:grand-slam-mission",
      everyMinutes: grandSlamCadence.every_minutes,
      reason: "Compile the full Grand Slam prediction mission across readiness, backfill, collection, quota, live-control and learning without executing actions.",
    }),
    schedulerItem({
      id: "grand_slam_scoreline_forecast",
      command: "npm --silent run hermes:grand-slam-scoreline-forecast",
      everyMinutes: grandSlamCadence.every_minutes,
      reason: "Project Grand Slam winners and set scorelines from existing backend probabilities without provider calls or orders.",
    }),
    schedulerItem({
      id: "enterprise_readiness",
      command: "npm --silent run hermes:enterprise-readiness",
      everyMinutes: 60,
      reason: "Gate enterprise provider review through backend shadow-contract and budget-chain evidence.",
    }),
    schedulerItem({
      id: "enterprise_accuracy_plan",
      command: "npm --silent run hermes:enterprise-accuracy-plan",
      everyMinutes: 12 * 60,
      reason: "Review the no-budget provider stack and Grand Slam scoreline forecast contract without provider calls or contract activation.",
    }),
    schedulerItem({
      id: "ops_compiler",
      command: "npm --silent run hermes:ops-compiler",
      everyMinutes: 5,
      reason: "Compile trigger, source, autonomy, model routing and operator packets into one non-executing orchestration payload.",
    }),
    schedulerItem({
      id: "capability_audit",
      command: "npm --silent run hermes:capability-audit",
      everyMinutes: 15,
      reason: "Score Hermes autonomy limits and next safe command against current backend evidence without executing actions.",
    }),
    schedulerItem({
      id: "autonomy_gates",
      command: "npm --silent run hermes:autonomy-gates",
      everyMinutes: 5,
      reason: "Prove the current safe autonomy ceiling before channel, cron, paper or enterprise escalation.",
    }),
    schedulerItem({
      id: "experiment_lab",
      command: "npm --silent run hermes:experiment-lab",
      everyMinutes: 15,
      reason: "Rank safe Hermes experiments for collection, processing, paper learning and enterprise readiness without executing them.",
    }),
    schedulerItem({
      id: "backlog_plan",
      command: "npm --silent run hermes:backlog-plan",
      everyMinutes: 60,
      reason: "Convert local operator and experiment ledger evidence into non-executing implementation priorities.",
    }),
    schedulerItem({
      id: "autonomy_effectiveness",
      command: "npm --silent run hermes:autonomy-effectiveness",
      everyMinutes: 60,
      reason: "Measure whether local Hermes ledgers justify implementation or more evidence without executing actions.",
    }),
    schedulerItem({
      id: "runtime_check",
      command: "npm run hermes:runtime-check",
      everyMinutes: loop.runtime?.status === "ready" ? 30 : 5,
      reason: "Capture Hermes local runtime diagnostics while gateway is degraded or before protected automation.",
    }),
    schedulerItem({
      id: "event_router",
      command: "npm --silent run hermes:events",
      everyMinutes: 5,
      reason: "Keep deterministic event routing available for channels without creating orders.",
    }),
    schedulerItem({
      id: "live_stats",
      command: "npm --silent run hermes:live-stats",
      everyMinutes: policy.name === "paper_signal_watch" ? 1 : 5,
      reason: `Monitor collection and freshness under ${policy.name ?? "unknown"} policy.`,
    }),
    schedulerItem({
      id: "quota_plan",
      command: "npm --silent run hermes:quota-plan",
      everyMinutes: 5,
      reason: "Apply budget utilization throttles before any operator-triggered provider cadence change.",
    }),
  ];
  if (loop.budget_chain && !loop.budget_chain.completed) {
    rows.push(schedulerItem({
      id: "budget_chain",
      command: "npm --silent run hermes:budget-chain",
      everyMinutes: 15,
      reason: "Track budget provider onboarding without running provider smoke execution.",
    }));
  }
  if (loop.active_phase === "collect_learning" || loop.learning_review?.review_status !== "ready") {
    rows.push(schedulerItem({
      id: "learning_review",
      command: "npm --silent run hermes:learning-review",
      everyMinutes: 24 * 60,
      reason: "Review ROI/CLV readiness periodically; deterministic gates still decide promotion.",
    }));
  }
  if (loop.next_best_command?.command
    && loop.runtime?.status !== "ready"
    && loop.next_best_command.command !== "npm run hermes:runtime-check") {
    rows.push(schedulerItem({
      id: "runtime_diagnostic",
      command: loop.next_best_command.command,
      everyMinutes: 5,
      reason: loop.next_best_command.reason ?? "Run the specific bounded runtime diagnostic without mutating Hermes.",
    }));
  }
  if (loop.read_only_runtime_route) {
    rows.push(schedulerItem({
      id: "runtime_read_only_route",
      command: loop.read_only_runtime_route.command,
      everyMinutes: 5,
      reason: loop.read_only_runtime_route.reason,
    }));
  }
  return dedupeSchedule(rows);
}

function grandSlamScheduleCadence(grandSlam) {
  if (!grandSlam) {
    return {
      every_minutes: 12 * 60,
      reason: "Run low-frequency Grand Slam readiness checks until the readiness packet is available.",
    };
  }
  if (grandSlam.paper_ready) {
    return {
      every_minutes: 5,
      reason: "Grand Slam prediction rows are paper-ready; watch backend gates frequently without creating paper orders.",
    };
  }
  if (grandSlam.prediction_ready) {
    return {
      every_minutes: 10,
      reason: "Grand Slam prediction rows exist; refresh readiness while waiting for paper gates.",
    };
  }
  if (grandSlam.status === "waiting_for_draw_or_feed" || Number(grandSlam.active_grand_slams?.length ?? 0) > 0) {
    return {
      every_minutes: 15,
      reason: "Grand Slam window is open; monitor draw/feed visibility without spending provider quota.",
    };
  }
  if (grandSlam.status === "blocked") {
    return {
      every_minutes: 30,
      reason: "Grand Slam readiness is blocked; recheck backend and safety gates without executing repair actions.",
    };
  }
  return {
    every_minutes: 12 * 60,
    reason: "No Grand Slam window or rows are active; keep readiness checks low-frequency.",
  };
}

function grandSlamScheduleSummary(grandSlam) {
  return {
    status: grandSlam.status,
    prediction_ready: Boolean(grandSlam.prediction_ready),
    paper_ready: Boolean(grandSlam.paper_ready),
    active_grand_slams: grandSlam.active_grand_slams ?? [],
    grand_slam_visible: grandSlam.matches?.grand_slam_visible ?? 0,
    next_action: grandSlam.next_action ? {
      id: grandSlam.next_action.id,
      command: grandSlam.next_action.command,
      can_create_paper_orders: Boolean(grandSlam.next_action.can_create_paper_orders),
      provider_api_call_allowed: Boolean(grandSlam.next_action.provider_api_call_allowed),
    } : null,
    cadence: grandSlamScheduleCadence(grandSlam),
  };
}

function schedulerItem({ id, command, everyMinutes, reason }) {
  return {
    id,
    command,
    every_minutes: everyMinutes,
    reason,
    execute_now: false,
    writes: false,
    live_api_calls: false,
    requires_admin_token: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
    provider_api_call_allowed: false,
  };
}

function dedupeSchedule(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.command)) return false;
    seen.add(item.command);
    return true;
  });
}

function chooseSchedulerNextTick(loop, schedule) {
  const preferredCommand = loop.next_best_command?.command;
  const fromLoop = schedule.find((item) => item.command === preferredCommand);
  if (fromLoop) return fromLoop;
  if (["runtime_degraded", "runtime_partial"].includes(loop.status)) {
    return schedule.find((item) => item.id === "runtime_check") ?? schedule[0] ?? null;
  }
  return schedule[0] ?? null;
}

function schedulerAuditPath() {
  return process.env.HERMES_SCHEDULER_RUN_LOG || "hermes/runs/scheduler-rehearsal.jsonl";
}

function writeSchedulerAudit(rehearsal) {
  const path = schedulerAuditPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(rehearsal)}\n`, "utf8");
}

function buildCronProposal(rehearsal) {
  const jobs = rehearsal.schedule
    .filter((item) => cronProposalAllows(item))
    .map((item) => cronJobProposal(item, rehearsal));
  return {
    generated_at: new Date().toISOString(),
    mode: "cron_proposal",
    source_mode: rehearsal.source_mode,
    active_phase: rehearsal.active_phase,
    status: rehearsal.status,
    created_jobs: false,
    executed_commands: [],
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    proposal_path: cronProposalPath(),
    jobs,
    operator_steps: [
      "Review this proposal before creating any Hermes cron jobs.",
      "Confirm Telegram pairing, allowlist, local secrets, and loopback-only gateway first.",
      "Create jobs manually only from a local operator shell; do not add --execute-provider-call to any scheduled command.",
    ],
    forbidden_actions: rehearsal.forbidden_actions,
    safety: rehearsal.safety,
  };
}

function cronProposalAllows(item) {
  return !item.can_create_paper_orders
    && !item.can_submit_real_orders
    && !item.provider_api_call_allowed
    && !item.live_api_calls
    && !item.requires_admin_token
    && !item.command.includes("--execute-provider-call")
    && !item.command.includes("hermes:autopilot")
    && !item.command.includes("hermes:provider-smoke");
}

function cronJobProposal(item, rehearsal) {
  const name = `tennis-edge-${item.id.replaceAll("_", "-")}`;
  const message = cronMessageFor(item, rehearsal);
  return {
    id: item.id,
    name,
    every: `${item.every_minutes}m`,
    model: "gpt-5.4-mini",
    command_preview: [
      "hermes cron add",
      `--name ${shellQuote(name)}`,
      `--every ${shellQuote(`${item.every_minutes}m`)}`,
      "--model gpt-5.4-mini",
      `--message ${shellQuote(message)}`,
      "--timeout-seconds 90",
    ].join(" \\\n  "),
    message,
    source_command: item.command,
    creates_job: false,
    execute_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_create_paper_orders: false,
    can_submit_real_orders: false,
  };
}

function cronMessageFor(item, rehearsal) {
  const base = `Use the tennis-edge-ops skill. Run ${item.command} from /Users/ppfahd/Workspace/projects/tennis-live-edge.`;
  const report = item.id === "safe_loop"
    ? "Report status, runtime, active_phase, next_tick, safe_commands, budget_chain, learning_review, and safety."
    : item.id === "runtime_check"
      ? "Report runtime status, failed command names, timeout state, and next_actions."
      : item.id === "event_router"
        ? "Report severity, events, recommended_commands, can_run_paper_autopilot, and safety."
        : item.id === "live_stats"
          ? "Report health_scores, freshness, sampling_policy, budget_chain, and safety only."
          : item.id === "grand_slam_readiness"
            ? "Report status, active_grand_slams, matches, prediction_ready, paper_ready, next_action, and safety only."
          : item.id === "grand_slam_mission"
              ? "Report active_phase, grand_slam_readiness, live_control, historical_backfill, learning_review, next_action, and safety only."
              : item.id === "grand_slam_scoreline_forecast"
                ? "Report status, forecast_ready_rows, top_forecast projected_winner/projected_scoreline, blockers, next_action, and safety only."
              : item.id === "enterprise_accuracy_plan"
                ? "Report status, budget_gate, top_provider, provider_count, scoreline gates, next_action, and safety only."
                : item.id === "enterprise_readiness"
                  ? "Report status, budget_gate, replay_gate shadow_provider_count, activation_blockers, next_action, and safety only."
              : item.id === "autonomy_effectiveness"
                ? "Report status, score, next_action, repeat_pressure, protected_action_claims, and safety only."
          : item.id === "budget_chain"
            ? "Report current_step, blockers, smoke_command, and provider_api_call_allowed."
            : "Report review_status, gates, blockers, next_actions, and real_execution_recommendation.";
  return [
    base,
    report,
    `Current rehearsal phase is ${rehearsal.active_phase}.`,
    "Do not execute recommended commands, create orders, run provider smoke, spend provider quota, or submit real orders from this cron.",
  ].join(" ");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function cronProposalPath() {
  return process.env.HERMES_CRON_PROPOSAL_PATH || "hermes/runs/cron-proposal.json";
}

function writeCronProposal(proposal) {
  const path = cronProposalPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
}

function buildActivationChecklist({ loop, rehearsal, proposal }) {
  const checks = activationChecks({ loop, rehearsal, proposal });
  const activationAllowed = checks.every((item) => item.status === "pass");
  return {
    generated_at: new Date().toISOString(),
    mode: "activation_checklist",
    status: activationAllowed ? "ready_for_manual_activation" : "blocked",
    activation_allowed: activationAllowed,
    created_jobs: false,
    executed_commands: [],
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    cron_proposal: {
      proposal_path: proposal.proposal_path,
      job_count: proposal.jobs.length,
      jobs: proposal.jobs.map((job) => ({
        id: job.id,
        name: job.name,
        every: job.every,
        source_command: job.source_command,
      })),
    },
    checks,
    manual_activation_commands: activationAllowed
      ? proposal.jobs.map((job) => job.command_preview)
      : [],
    operator_steps: activationAllowed
      ? [
        "Review each command preview one final time.",
        "Create Hermes cron jobs manually from a local operator shell only.",
        "Run npm --silent run hermes:safe-loop after creation and confirm jobs remain read-only.",
      ]
      : [
        "Resolve failed checks before creating any Hermes cron jobs.",
        "Rerun npm run hermes:activation-checklist after gateway, Telegram allowlist, private access, and local secrets are ready.",
      ],
    forbidden_actions: proposal.forbidden_actions,
    safety: {
      real_execution_hard_block: proposal.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function activationChecks({ loop, rehearsal, proposal }) {
  const unsafeJobs = proposal.jobs.filter((job) => (
    job.can_create_paper_orders
      || job.can_submit_real_orders
      || job.provider_api_call_allowed
      || job.live_api_calls
      || job.command_preview.includes("--execute-provider-call")
      || job.command_preview.includes("hermes:autopilot")
      || job.command_preview.includes("hermes:provider-smoke")
  ));
  return [
    activationCheck({
      id: "hermes_runtime_ready",
      status: loop.runtime?.status === "ready" ? "pass" : "fail",
      summary: loop.runtime?.status === "ready"
        ? "Hermes CLI status and doctor are clean."
        : `Hermes runtime is ${loop.runtime?.status ?? "unknown"}.`,
    }),
    activationCheck({
      id: "telegram_allowlist_configured",
      status: envListCount(["HERMES_TELEGRAM_ALLOWED_USER_IDS", "OPENCLAW_TELEGRAM_ALLOWED_USER_IDS"]) > 0 ? "pass" : "fail",
      summary: "Telegram allowlist has at least one local user id configured.",
      evidence: { configured_count: envListCount(["HERMES_TELEGRAM_ALLOWED_USER_IDS", "OPENCLAW_TELEGRAM_ALLOWED_USER_IDS"]) },
    }),
    activationCheck({
      id: "private_access_allowlist_configured",
      status: envListCount(["PRIVATE_ALLOWED_EMAILS", "TENNIS_EDGE_PRIVATE_ALLOWED_EMAILS"]) > 0 ? "pass" : "fail",
      summary: "Private Access email allowlist has at least one address configured.",
      evidence: { configured_count: envListCount(["PRIVATE_ALLOWED_EMAILS", "TENNIS_EDGE_PRIVATE_ALLOWED_EMAILS"]) },
    }),
    activationCheck({
      id: "local_admin_secret_available",
      status: envConfigured(["ADMIN_API_TOKEN", "TENNIS_EDGE_ADMIN_API_TOKEN"]) ? "pass" : "fail",
      summary: "Local admin token exists for future protected operator actions; value is not printed.",
    }),
    activationCheck({
      id: "cron_manifest_safe",
      status: proposal.jobs.length > 0 && unsafeJobs.length === 0 ? "pass" : "fail",
      summary: "Cron proposal contains only read-only, non-quota, non-order jobs.",
      evidence: {
        jobs: proposal.jobs.length,
        unsafe_jobs: unsafeJobs.map((job) => job.name),
      },
    }),
    activationCheck({
      id: "rehearsal_did_not_execute",
      status: rehearsal.executed_commands.length === 0 && proposal.executed_commands.length === 0 ? "pass" : "fail",
      summary: "Rehearsal and proposal did not execute scheduled commands.",
    }),
    activationCheck({
      id: "real_execution_hard_block",
      status: proposal.safety?.real_execution_hard_block === true
        && proposal.safety?.can_submit_real_orders === false
        ? "pass"
        : "fail",
      summary: "Real execution remains hard-blocked.",
    }),
  ];
}

function activationCheck({ id, status, summary, evidence = {} }) {
  return { id, status, summary, evidence };
}

function envConfigured(names) {
  return names.some((name) => String(process.env[name] ?? "").trim().length > 0);
}

function envListCount(names) {
  return names
    .flatMap((name) => String(process.env[name] ?? "").split(","))
    .map((item) => item.trim())
    .filter(Boolean).length;
}

function buildRuntimeFixPlan({ loop, rehearsal, proposal, activation }) {
  const actions = runtimeFixActions(activation, loop.runtime);
  return {
    generated_at: new Date().toISOString(),
    mode: "runtime_fix_plan",
    status: activation.activation_allowed ? "ready" : "blocked",
    activation_allowed: activation.activation_allowed,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    created_jobs: false,
    executed_commands: [],
    next_action: actions[0] ?? null,
    actions,
    activation_checks: activation.checks,
    cron_proposal: {
      proposal_path: proposal.proposal_path,
      job_count: proposal.jobs.length,
    },
    runtime: {
      status: loop.runtime?.status,
      active_phase: loop.active_phase,
      next_tick: rehearsal.next_tick,
      findings: loop.runtime?.runtime_findings ?? {},
      diagnostic_actions: loop.runtime?.diagnostic_actions ?? [],
    },
    forbidden_actions: activation.forbidden_actions,
    safety: activation.safety,
  };
}

function runtimeFixActions(activation, runtime = {}) {
  const actions = (activation.checks ?? [])
    .filter((check) => check.status === "fail")
    .map((check) => runtimeFixActionFor(check, runtime))
    .filter(Boolean);

  actions.push(...runtimeDiagnosticFixActions(runtime));
  actions.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  if (!actions.length && activation.activation_allowed) {
    actions.push(fixAction({
      id: "review_manual_activation_commands",
      priority: 100,
      lane: "manual_activation",
      command: "Review manual_activation_commands from npm run hermes:activation-checklist.",
      reason: "All activation checks passed; final cron creation remains a manual operator action.",
      requiresHuman: true,
      notes: [
        "Do not create jobs from runtime-fix-plan.",
        "Keep provider smoke and autopilot outside scheduled cron jobs.",
      ],
    }));
  }

  return actions;
}

function runtimeDiagnosticFixActions(runtime = {}) {
  return (runtime.diagnostic_actions ?? []).map((action, index) => fixAction({
    id: `runtime_${action.id}`,
    priority: 11 + index,
    lane: "local_runtime",
    command: action.command,
    reason: action.reason,
    requiresHuman: Boolean(action.requires_operator_confirmation || action.mutates_runtime_if_run),
    mutatesRuntimeIfRun: Boolean(action.mutates_runtime_if_run),
    notes: [
      "Derived from npm run hermes:runtime-check.",
      action.mutates_runtime_if_run
        ? "This command can alter Hermes runtime if the operator runs it manually; runtime-fix-plan does not execute it."
        : "This diagnostic remains safe to run from the repo wrapper.",
    ],
  }));
}

function runtimeFixActionFor(check, runtime = {}) {
  const reason = check.summary;
  const checkId = check.id ?? check.name;
  const runtimeDiagnosticActions = runtime.diagnostic_actions ?? [];
  const hasSpecificRuntimeDiagnostic = checkId === "hermes_runtime_ready" && runtimeDiagnosticActions.length > 0;
  const actions = {
    hermes_runtime_ready: {
      id: "fix_hermes_runtime_ready",
      priority: hasSpecificRuntimeDiagnostic ? 19 : 10,
      lane: "local_runtime",
      command: "npm run hermes:runtime-check",
      reason,
      requiresHuman: false,
      notes: [
        hasSpecificRuntimeDiagnostic
          ? "Runtime-specific diagnostic action is prioritized ahead of this generic recheck."
          : "Inspect Hermes status and doctor output.",
        "Do not restart, install, repair, or edit LaunchAgents from this command.",
      ],
      supersededByDiagnosticAction: hasSpecificRuntimeDiagnostic,
    },
    telegram_allowlist_configured: {
      id: "fix_telegram_allowlist_configured",
      priority: 30,
      lane: "operator_reachability",
      command: "Configure HERMES_TELEGRAM_ALLOWED_USER_IDS locally, then rerun npm run hermes:activation-checklist.",
      reason,
      requiresHuman: true,
      notes: [
        "Telegram routing must stay allowlisted.",
        "Do not print chat ids or tokens into committed files.",
      ],
    },
    private_access_allowlist_configured: {
      id: "fix_private_access_allowlist_configured",
      priority: 40,
      lane: "private_access",
      command: "Configure PRIVATE_ALLOWED_EMAILS locally, then rerun npm run hermes:activation-checklist.",
      reason,
      requiresHuman: true,
      notes: [
        "Private domain access must stay behind an explicit allowlist.",
        "Do not modify Cloudflare Access policies from this command.",
      ],
    },
    local_admin_secret_available: {
      id: "fix_local_admin_secret_available",
      priority: 50,
      lane: "local_secret",
      command: "Configure ADMIN_API_TOKEN locally, then rerun npm run hermes:activation-checklist.",
      reason,
      requiresHuman: true,
      notes: [
        "Keep ADMIN_API_TOKEN local-only and out of Git.",
        "Protected commands must receive the token through stdin or local environment loading.",
      ],
    },
    cron_manifest_safe: {
      id: "fix_cron_manifest_safe",
      priority: 20,
      lane: "cron_manifest",
      command: "npm --silent run hermes:cron-proposal",
      reason,
      requiresHuman: false,
      notes: [
        "Review the generated manifest before manual cron creation.",
        "Never schedule provider-smoke execution or paper autopilot from cron.",
      ],
    },
    rehearsal_did_not_execute: {
      id: "fix_rehearsal_did_not_execute",
      priority: 5,
      lane: "scheduler_safety",
      command: "Stop automation and inspect Hermes runs before continuing.",
      reason,
      requiresHuman: true,
      notes: [
        "A rehearsal must never execute commands.",
        "Treat this as a safety incident until the audit is understood.",
      ],
    },
    real_execution_hard_block: {
      id: "fix_real_execution_hard_block",
      priority: 1,
      lane: "execution_safety",
      command: "Stop automation and restore REAL_EXECUTION_HARD_BLOCK=true before continuing.",
      reason,
      requiresHuman: true,
      notes: [
        "No real order path may be enabled by Hermes activation.",
        "Do not continue cron activation until the backend reports can_submit_real_orders=false.",
      ],
    },
  };
  const action = actions[checkId];
  return action ? fixAction(action) : fixAction({
    id: `fix_${String(checkId ?? "unknown").replaceAll(/[^a-zA-Z0-9_:-]/g, "_")}`,
    priority: 90,
    lane: "manual_review",
    command: "Inspect npm run hermes:activation-checklist and resolve this failed gate manually.",
    reason,
    requiresHuman: true,
    notes: ["Unknown activation gate; keep automation blocked until reviewed."],
  });
}

function fixAction({
  id,
  priority,
  lane,
  command,
  reason,
  requiresHuman,
  mutatesRuntimeIfRun = false,
  supersededByDiagnosticAction = false,
  notes = [],
}) {
  return {
    id,
    priority,
    lane,
    command,
    reason,
    requires_human: requiresHuman,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    executes_now: false,
    mutates_runtime_if_run: Boolean(mutatesRuntimeIfRun),
    superseded_by_diagnostic_action: Boolean(supersededByDiagnosticAction),
    notes,
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
      action: providerHealthAction(blocker),
      allowedCommand: providerHealthAllowedCommand(blocker),
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

function providerHealthAllowedCommand(reason) {
  return /provider:fastapi:|backend|unreachable/i.test(String(reason ?? ""))
    ? "npm run hermes:backend-latency-triage"
    : "npm run hermes:preflight";
}

function providerHealthAction(reason) {
  return providerHealthAllowedCommand(reason) === "npm run hermes:backend-latency-triage"
    ? "Measure local backend endpoint latency before restarting services or spending provider calls."
    : "Inspect provider health, quota, credentials, and last tick before spending more live calls.";
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
      command: eventsByType.get("provider_health_degraded")?.allowed_command ?? "npm run hermes:preflight",
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

function buildLiveWindow(report, eventPlan, playbookPlan, liveStatsPlan) {
  const gates = liveWindowGates(report, eventPlan, liveStatsPlan);
  const blockers = liveWindowBlockers(gates, eventPlan);
  const status = liveWindowStatus({ gates, eventPlan });
  const windowOpen = status === "paper_ready" || status === "monitor";
  const autopilotCandidate = status === "paper_ready";
  return {
    generated_at: new Date().toISOString(),
    mode: "live_window",
    status,
    window_open: windowOpen,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    autopilot_candidate: autopilotCandidate,
    active_phase: playbookPlan.active_phase,
    provider_mode: report.data_snapshot?.provider_mode,
    sampling_policy: liveStatsPlan.sampling_policy,
    health_scores: liveStatsPlan.health_scores,
    signal_stats: liveStatsPlan.signal_stats,
    freshness: liveStatsPlan.freshness,
    gates,
    blockers,
    next_action: liveWindowNextAction({ status, eventPlan, playbookPlan, liveStatsPlan }),
    forbidden_actions: report.forbidden_collection_paths ?? [],
    allowed_collection_paths: report.allowed_collection_paths ?? [],
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function liveWindowGates(report, eventPlan, liveStatsPlan) {
  const freshness = liveStatsPlan.freshness ?? {};
  const signals = liveStatsPlan.signal_stats ?? {};
  const budget = liveStatsPlan.budget_chain ?? {};
  const safety = report.safety ?? {};
  const providerMode = report.data_snapshot?.provider_mode;
  return [
    liveWindowGate({
      id: "real_execution_hard_block",
      status: safety.real_execution_hard_block === true && safety.can_submit_real_orders !== true ? "pass" : "fail",
      summary: "Real execution must remain impossible during live-window decisions.",
    }),
    liveWindowGate({
      id: "event_severity_clear",
      status: ["critical", "high"].includes(eventPlan.severity) ? "fail" : "pass",
      summary: `Event severity is ${eventPlan.severity}.`,
    }),
    liveWindowGate({
      id: "budget_chain_completed",
      status: budget.completed ? "pass" : "fail",
      summary: "Budget provider chain must be complete before live paper readiness.",
    }),
    liveWindowGate({
      id: "provider_mode_live",
      status: providerMode === "live_with_keys" ? "pass" : "warn",
      summary: `Provider mode is ${providerMode ?? "unknown"}.`,
    }),
    liveWindowGate({
      id: "fresh_scores",
      status: Number(freshness.stale_score_matches ?? 0) === 0 ? "pass" : "fail",
      summary: `${freshness.stale_score_matches ?? 0} sampled matches have stale score state.`,
    }),
    liveWindowGate({
      id: "fresh_odds",
      status: Number(freshness.stale_odds_matches ?? 0) === 0 ? "pass" : "fail",
      summary: `${freshness.stale_odds_matches ?? 0} sampled matches have stale odds state.`,
    }),
    liveWindowGate({
      id: "entrada_available",
      status: Number(signals.entry ?? 0) > 0 ? "pass" : "warn",
      summary: `${signals.entry ?? 0} Entrada signals are currently visible.`,
    }),
    liveWindowGate({
      id: "paper_autopilot_allowed",
      status: signals.paper_autopilot_allowed ? "pass" : "fail",
      summary: "Backend event gates must allow paper autopilot before any paper order route is suggested.",
    }),
  ];
}

function liveWindowGate({ id, status, summary }) {
  return { id, status, summary };
}

function liveWindowBlockers(gates, eventPlan) {
  const blockers = gates
    .filter((gate) => gate.status === "fail")
    .map((gate) => gate.id);
  if (["critical", "high"].includes(eventPlan.severity)) {
    blockers.push(`event_severity:${eventPlan.severity}`);
  }
  return [...new Set(blockers)];
}

function liveWindowStatus({ gates, eventPlan }) {
  if (gates.some((gate) => gate.id === "real_execution_hard_block" && gate.status === "fail")) {
    return "safety_stop";
  }
  if (["critical", "high"].includes(eventPlan.severity)) {
    return "blocked";
  }
  if (gates.some((gate) => gate.status === "fail")) {
    return "blocked";
  }
  if (
    gates.every((gate) => gate.status === "pass")
    && eventPlan.can_run_paper_autopilot
  ) {
    return "paper_ready";
  }
  return "monitor";
}

function liveWindowNextAction({ status, eventPlan, playbookPlan, liveStatsPlan }) {
  if (status === "safety_stop" || status === "blocked") {
    return liveWindowAction({
      id: "route_events",
      command: "npm --silent run hermes:events",
      reason: `Resolve blockers before opening live window; current severity is ${eventPlan.severity}.`,
    });
  }
  if (status === "paper_ready") {
    return liveWindowAction({
      id: "paper_autopilot",
      command: "npm run hermes:autopilot",
      reason: "Backend gates show Entrada signals and paper autopilot eligibility; execution still happens only through protected backend paper route.",
      requiresAdminToken: true,
      canCreatePaperOrders: true,
    });
  }
  const readyStep = playbookPlan.steps.find((step) => step.status === "ready" && !step.writes)
    ?? liveStatsPlan.next_safe_commands.find((step) => !step.writes);
  return liveWindowAction({
    id: readyStep?.id ?? "observe_state",
    command: readyStep?.command ?? "npm --silent run hermes:intelligence",
    reason: "Live window is open for monitoring only; keep observing internal state.",
  });
}

function liveWindowAction({
  id,
  command,
  reason,
  requiresAdminToken = false,
  canCreatePaperOrders = false,
}) {
  return {
    id,
    command,
    reason,
    requires_admin_token: requiresAdminToken,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: canCreatePaperOrders,
    executes_now: false,
  };
}

function buildMatchPulse({ report, eventPlan, liveWindowPlan, matches }) {
  const watchlist = matches
    .map((analysis) => matchPulseRow({ analysis, liveWindowPlan, eventPlan }))
    .sort((a, b) => (
      b.priority_score - a.priority_score
      || a.match_id.localeCompare(b.match_id)
    ));
  return {
    generated_at: new Date().toISOString(),
    mode: "match_pulse",
    status: matchPulseStatus(liveWindowPlan, watchlist),
    live_window_status: liveWindowPlan.status,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    matches_seen: matches.length,
    watchlist: watchlist.slice(0, 12),
    top_match: watchlist[0] ?? null,
    sampling_policy: liveWindowPlan.sampling_policy,
    gates: liveWindowPlan.gates,
    blockers: liveWindowPlan.blockers,
    forbidden_actions: report.forbidden_collection_paths ?? [],
    safety: liveWindowPlan.safety,
  };
}

function matchPulseStatus(liveWindowPlan, watchlist) {
  if (liveWindowPlan.status === "safety_stop") return "safety_stop";
  if (liveWindowPlan.status === "blocked") return "blocked";
  if (watchlist.some((row) => row.attention === "paper_candidate")) return "paper_candidate";
  if (watchlist.length) return "monitor";
  return "empty";
}

function matchPulseRow({ analysis, liveWindowPlan, eventPlan }) {
  const match = analysis.match ?? {};
  const freshness = analysis.freshness ?? {};
  const signals = analysis.signals ?? [];
  const bestSignal = chooseMatchPulseSignal(signals);
  const scoreAge = Number(freshness.score_age_ms);
  const oddsAge = Number(freshness.odds_age_ms);
  const isScoreFresh = Number.isFinite(scoreAge) && scoreAge <= 30_000;
  const isOddsFresh = Number.isFinite(oddsAge) && oddsAge <= 15_000;
  const isLive = match.state?.status === "live";
  const isPressure = Boolean(match.state?.is_break_point || match.state?.is_tiebreak);
  const priorityScore = matchPulsePriority({
    signal: bestSignal,
    isLive,
    isScoreFresh,
    isOddsFresh,
    isPressure,
    liveWindowPlan,
  });
  const attention = matchPulseAttention({
    signal: bestSignal,
    isLive,
    isScoreFresh,
    isOddsFresh,
    liveWindowPlan,
  });
  return {
    match_id: match.id,
    label: `${match.player1?.name ?? "Player 1"} vs ${match.player2?.name ?? "Player 2"}`,
    tournament: match.tournament,
    round: match.round,
    tour: match.tour,
    surface: match.surface,
    status: match.state?.status,
    score: {
      sets: [match.state?.p1_sets ?? null, match.state?.p2_sets ?? null],
      games: [match.state?.p1_games ?? null, match.state?.p2_games ?? null],
      point: match.state?.point_score ?? null,
      server_player_id: match.state?.server_player_id ?? null,
      break_point: Boolean(match.state?.is_break_point),
      tiebreak: Boolean(match.state?.is_tiebreak),
    },
    signal: bestSignal ? {
      id: bestSignal.id,
      status: bestSignal.status,
      player_id: bestSignal.player_id,
      player_name: bestSignal.player_name,
      edge: bestSignal.edge,
      threshold: bestSignal.threshold,
      best_odds: bestSignal.best_odds,
      confidence: bestSignal.confidence,
      reason: bestSignal.reason,
    } : null,
    prediction: {
      p1_win_prob: analysis.prediction?.p1_win_prob,
      p2_win_prob: analysis.prediction?.p2_win_prob,
      confidence: analysis.prediction?.confidence,
      model_version: analysis.prediction?.model_version,
    },
    freshness: {
      source: freshness.source,
      persisted: Boolean(freshness.persisted),
      score_age_ms: Number.isFinite(scoreAge) ? scoreAge : null,
      odds_age_ms: Number.isFinite(oddsAge) ? oddsAge : null,
      score_fresh: isScoreFresh,
      odds_fresh: isOddsFresh,
      provider_lineage: freshness.provider_lineage ?? [],
    },
    attention,
    priority_score: priorityScore,
    next_action: matchPulseAction({ attention, eventPlan, liveWindowPlan }),
  };
}

function chooseMatchPulseSignal(signals) {
  return [...signals].sort((a, b) => (
    signalStatusRank(b.status) - signalStatusRank(a.status)
    || Number(b.edge ?? 0) - Number(a.edge ?? 0)
    || String(a.id ?? "").localeCompare(String(b.id ?? ""))
  ))[0] ?? null;
}

function signalStatusRank(status) {
  return {
    Entrada: 4,
    Monitorar: 3,
    "Sem valor": 2,
    Bloqueado: 1,
  }[status] ?? 0;
}

function matchPulsePriority({
  signal,
  isLive,
  isScoreFresh,
  isOddsFresh,
  isPressure,
  liveWindowPlan,
}) {
  const edgeScore = Math.min(30, Math.max(0, Number(signal?.edge ?? 0) * 200));
  const score = (
    (signal?.status === "Entrada" ? 55 : signal?.status === "Monitorar" ? 20 : 0)
    + (isLive ? 15 : 0)
    + (isScoreFresh ? 10 : -10)
    + (isOddsFresh ? 10 : -15)
    + (isPressure ? 8 : 0)
    + edgeScore
    + (liveWindowPlan.status === "paper_ready" ? 10 : 0)
    - (["blocked", "safety_stop"].includes(liveWindowPlan.status) ? 25 : 0)
  );
  return Math.max(0, Math.round(score));
}

function matchPulseAttention({
  signal,
  isLive,
  isScoreFresh,
  isOddsFresh,
  liveWindowPlan,
}) {
  if (liveWindowPlan.status === "safety_stop" || liveWindowPlan.status === "blocked") {
    return "blocked_watch";
  }
  if (!isScoreFresh || !isOddsFresh) {
    return "stale_monitor";
  }
  if (signal?.status === "Entrada" && liveWindowPlan.status === "paper_ready") {
    return "paper_candidate";
  }
  if (isLive) {
    return "live_monitor";
  }
  return "cold_monitor";
}

const GRAND_SLAM_MATCHERS = [
  {
    id: "australian_open",
    names: ["australian open"],
    label: "Australian Open",
    windows: [{ year: 2026, start: "2026-01-18", end: "2026-02-01" }],
  },
  {
    id: "roland_garros",
    names: ["roland garros", "french open"],
    label: "Roland Garros",
    windows: [{ year: 2026, start: "2026-05-24", end: "2026-06-07" }],
  },
  {
    id: "wimbledon",
    names: ["wimbledon", "the championships"],
    label: "Wimbledon",
    windows: [{ year: 2026, start: "2026-06-29", end: "2026-07-12" }],
  },
  {
    id: "us_open",
    names: ["us open", "u.s. open", "united states open"],
    label: "US Open",
    windows: [{ year: 2026, start: "2026-08-24", end: "2026-09-13" }],
  },
];

function buildGrandSlamReadiness({
  backend,
  report,
  eventPlan,
  liveWindowPlan,
  pulse,
  sourceRoutes,
  matches,
}) {
  const today = grandSlamToday();
  const activeSlams = activeGrandSlams(today);
  const slamMatches = matches
    .map((analysis) => grandSlamMatchRow(analysis))
    .filter((row) => row.is_grand_slam);
  const pulseByMatchId = new Map((pulse.watchlist ?? []).map((row) => [row.match_id, row]));
  const predictionRows = slamMatches
    .map((row) => ({
      ...row,
      pulse: pulseByMatchId.get(row.match_id) ?? null,
    }))
    .filter((row) => grandSlamPredictionAvailable(row));
  const gates = grandSlamReadinessGates({
    backend,
    report,
    liveWindowPlan,
    activeSlams,
    slamMatches,
    predictionRows,
  });
  const blockers = gates.filter((gate) => gate.status === "fail").map((gate) => gate.id);
  const status = grandSlamReadinessStatus({ gates, activeSlams, slamMatches, predictionRows, liveWindowPlan });
  return {
    generated_at: new Date().toISOString(),
    mode: "grand_slam_readiness",
    status,
    prediction_ready: ["prediction_ready", "paper_ready"].includes(status),
    paper_ready: status === "paper_ready",
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    date: today.toISOString().slice(0, 10),
    active_grand_slams: activeSlams.map((slam) => ({
      id: slam.id,
      label: slam.label,
      window: slam.window,
    })),
    coverage_scope: report.cost_snapshot?.coverage_scope ?? backendUnavailableCostProfile().coverage_scope,
    backend_status: backend.status,
    provider_mode: report.data_snapshot?.provider_mode,
    live_window_status: liveWindowPlan.status,
    source_route: sourceRoutes.next_route ? {
      id: sourceRoutes.next_route.id,
      lane: sourceRoutes.next_route.lane,
      status: sourceRoutes.next_route.status,
      cost_tier: sourceRoutes.next_route.cost_tier,
      command: sourceRoutes.next_route.command,
    } : null,
    matches: {
      total_visible: matches.length,
      grand_slam_visible: slamMatches.length,
      prediction_rows: predictionRows.length,
      paper_candidates: predictionRows.filter((row) => row.pulse?.attention === "paper_candidate").length,
      preview: predictionRows.slice(0, 8).map(grandSlamPredictionPreview),
    },
    gates,
    blockers,
    next_action: grandSlamReadinessNextAction({
      status,
      backend,
      report,
      liveWindowPlan,
      sourceRoutes,
      activeSlams,
      slamMatches,
    }),
    operating_policy: {
      hermes_role: "supervisor_and_router",
      probability_engine: "fastapi_deterministic_backend",
      allowed_paths: report.allowed_collection_paths ?? [],
      forbidden_paths: report.forbidden_collection_paths ?? [],
      provider_spend_requires_operator: true,
      sportsbook_browser_automation_allowed: false,
      bypass_allowed: false,
    },
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block === true,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
  };
}

function grandSlamToday() {
  const override = optionValue("--date") ?? process.env.HERMES_GRAND_SLAM_DATE;
  const date = override ? new Date(`${override}T12:00:00Z`) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function activeGrandSlams(date) {
  const day = date.toISOString().slice(0, 10);
  return GRAND_SLAM_MATCHERS.flatMap((slam) => (
    slam.windows
      .filter((window) => day >= window.start && day <= window.end)
      .map((window) => ({ ...slam, window }))
  ));
}

function grandSlamMatchRow(analysis) {
  const match = analysis.match ?? {};
  const tournament = String(match.tournament ?? "");
  const matcher = grandSlamMatcherForTournament(tournament);
  return {
    match_id: match.id ?? null,
    label: `${match.player1?.name ?? "Player 1"} vs ${match.player2?.name ?? "Player 2"}`,
    tournament,
    tour: match.tour ?? null,
    surface: match.surface ?? null,
    round: match.round ?? null,
    status: match.state?.status ?? null,
    player1: match.player1 ?? {},
    player2: match.player2 ?? {},
    best_of_sets: match.best_of_sets ?? match.format?.best_of_sets ?? null,
    grand_slam_id: matcher?.id ?? null,
    grand_slam_label: matcher?.label ?? null,
    is_grand_slam: Boolean(matcher),
    prediction: analysis.prediction ?? null,
    signals: analysis.signals ?? [],
    freshness: analysis.freshness ?? {},
  };
}

function grandSlamMatcherForTournament(tournament) {
  const normalized = tournament.toLowerCase();
  return GRAND_SLAM_MATCHERS.find((slam) => (
    slam.names.some((name) => normalized.includes(name))
  )) ?? null;
}

function grandSlamPredictionAvailable(row) {
  const prediction = row.prediction ?? {};
  return Number.isFinite(Number(prediction.p1_win_prob))
    && Number.isFinite(Number(prediction.p2_win_prob));
}

function grandSlamPredictionPreview(row) {
  return {
    match_id: row.match_id,
    label: row.label,
    tournament: row.tournament,
    tour: row.tour,
    round: row.round,
    status: row.status,
    p1_win_prob: row.prediction?.p1_win_prob,
    p2_win_prob: row.prediction?.p2_win_prob,
    confidence: row.prediction?.confidence,
    model_version: row.prediction?.model_version,
    signal_status: row.pulse?.signal?.status ?? null,
    attention: row.pulse?.attention ?? null,
    score_age_ms: Number.isFinite(Number(row.freshness?.score_age_ms))
      ? Number(row.freshness.score_age_ms)
      : null,
    odds_age_ms: Number.isFinite(Number(row.freshness?.odds_age_ms))
      ? Number(row.freshness.odds_age_ms)
      : null,
  };
}

function grandSlamReadinessGates({
  backend,
  report,
  liveWindowPlan,
  activeSlams,
  slamMatches,
  predictionRows,
}) {
  const coverage = report.cost_snapshot?.coverage_scope ?? [];
  return [
    grandSlamGate({
      id: "real_execution_hard_block",
      status: report.safety?.real_execution_hard_block === true
        && report.safety?.can_submit_real_orders !== true ? "pass" : "fail",
      summary: "Real execution must remain hard-blocked.",
    }),
    grandSlamGate({
      id: "backend_ready",
      status: backend.status === "ready" ? "pass" : "fail",
      summary: `Backend readiness is ${backend.status}.`,
    }),
    grandSlamGate({
      id: "grand_slam_coverage",
      status: coverage.includes("grand_slam_men") && coverage.includes("grand_slam_women") ? "pass" : "fail",
      summary: `Coverage scope is ${(coverage.length ? coverage : ["unknown"]).join(",")}.`,
    }),
    grandSlamGate({
      id: "grand_slam_window_or_matches",
      status: activeSlams.length || slamMatches.length ? "pass" : "warn",
      summary: activeSlams.length
        ? `${activeSlams.map((slam) => slam.label).join(", ")} is inside configured Grand Slam window.`
        : `${slamMatches.length} Grand Slam match rows are visible outside configured windows.`,
    }),
    grandSlamGate({
      id: "grand_slam_matches_visible",
      status: slamMatches.length ? "pass" : "warn",
      summary: `${slamMatches.length} Grand Slam match rows are visible to Hermes.`,
    }),
    grandSlamGate({
      id: "prediction_rows_available",
      status: predictionRows.length ? "pass" : "warn",
      summary: `${predictionRows.length} Grand Slam rows include backend model probabilities.`,
    }),
    grandSlamGate({
      id: "live_window_not_safety_stop",
      status: liveWindowPlan.status === "safety_stop" ? "fail" : liveWindowPlan.status === "blocked" ? "warn" : "pass",
      summary: `Live-window status is ${liveWindowPlan.status}.`,
    }),
  ];
}

function grandSlamGate({ id, status, summary }) {
  return { id, status, summary };
}

function grandSlamReadinessStatus({ gates, activeSlams, slamMatches, predictionRows, liveWindowPlan }) {
  if (gates.some((gate) => gate.status === "fail")) return "blocked";
  if (!activeSlams.length && !slamMatches.length) return "off_calendar";
  if (!slamMatches.length) return "waiting_for_draw_or_feed";
  if (!predictionRows.length) return "monitor";
  if (liveWindowPlan.status === "paper_ready") return "paper_ready";
  return "prediction_ready";
}

function grandSlamReadinessNextAction({
  status,
  backend,
  report,
  liveWindowPlan,
  sourceRoutes,
  activeSlams,
  slamMatches,
}) {
  if (status === "blocked") {
    const backendAction = backend.next_action;
    return grandSlamAction({
      id: backendAction?.id ?? "restore_backend_or_events",
      command: backendAction?.command ?? "npm --silent run hermes:events",
      reason: backendAction?.reason ?? "Resolve backend/safety blockers before Grand Slam prediction readiness.",
      mutatesRuntimeIfRun: Boolean(backendAction?.mutates_runtime_if_run),
      requiresOperatorConfirmation: Boolean(backendAction?.requires_operator_confirmation),
    });
  }
  if (status === "off_calendar") {
    return grandSlamAction({
      id: "wait_for_grand_slam_window",
      command: "npm --silent run hermes:grand-slam-readiness",
      reason: "No configured Grand Slam window or visible Grand Slam match rows; keep scheduled readiness checks low-frequency.",
    });
  }
  if (status === "waiting_for_draw_or_feed") {
    return grandSlamAction({
      id: "onboard_or_refresh_score_feed",
      command: report.budget_chain_snapshot?.budget_chain_completed
        ? "npm --silent run hermes:collection-plan"
        : "npm --silent run hermes:budget-chain",
      reason: activeSlams.length
        ? "Grand Slam window is open but no match rows are visible; follow budget onboarding or score-feed refresh path."
        : "Grand Slam matches are not visible yet; keep provider calls operator-gated.",
    });
  }
  if (status === "monitor") {
    return grandSlamAction({
      id: "inspect_match_pulse",
      command: "npm --silent run hermes:match-pulse",
      reason: "Grand Slam rows are visible but model probabilities are missing or incomplete.",
    });
  }
  if (status === "paper_ready") {
    return grandSlamAction({
      id: liveWindowPlan.next_action?.id ?? "paper_autopilot",
      command: liveWindowPlan.next_action?.command ?? "npm run hermes:autopilot",
      reason: liveWindowPlan.next_action?.reason ?? "Grand Slam prediction rows are paper-ready; backend still controls paper order creation.",
      requiresAdminToken: true,
      canCreatePaperOrders: true,
    });
  }
  return grandSlamAction({
    id: sourceRoutes.next_route?.id ?? "observe_predictions",
    command: "npm --silent run hermes:grand-slam-readiness",
    reason: `${slamMatches.length} Grand Slam matches have prediction rows; keep observing internal state until live-window/paper gates improve.`,
  });
}

function grandSlamAction({
  id,
  command,
  reason,
  requiresAdminToken = false,
  canCreatePaperOrders = false,
  mutatesRuntimeIfRun = false,
  requiresOperatorConfirmation = false,
}) {
  return {
    id,
    command,
    reason,
    requires_admin_token: requiresAdminToken,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: canCreatePaperOrders,
    llm_per_tick_allowed: false,
    executes_now: false,
    mutates_runtime_if_run: Boolean(mutatesRuntimeIfRun),
    requires_operator_confirmation: Boolean(requiresOperatorConfirmation),
  };
}

function matchPulseAction({ attention, eventPlan, liveWindowPlan }) {
  if (attention === "paper_candidate") {
    return {
      id: "paper_autopilot",
      command: "npm run hermes:autopilot",
      reason: "Fresh Entrada match in an open paper-ready live window; backend still controls paper order creation.",
      requires_admin_token: true,
      writes: false,
      live_api_calls: false,
      provider_api_call_allowed: false,
      can_submit_real_orders: false,
      can_create_paper_orders: true,
      executes_now: false,
    };
  }
  if (attention === "blocked_watch") {
    return {
      id: "route_events",
      command: "npm --silent run hermes:events",
      reason: `Live window is ${liveWindowPlan.status}; current event severity is ${eventPlan.severity}.`,
      requires_admin_token: false,
      writes: false,
      live_api_calls: false,
      provider_api_call_allowed: false,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      executes_now: false,
    };
  }
  return {
    id: "observe_match",
    command: "npm --silent run hermes:match-pulse",
    reason: "Keep match on low-cost internal watchlist until freshness and signal gates improve.",
    requires_admin_token: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    executes_now: false,
  };
}

function buildCollectionPlan({ report, eventPlan, liveWindowPlan, pulse }) {
  const targets = pulse.watchlist.map((row) => collectionTarget(row, liveWindowPlan));
  return {
    generated_at: new Date().toISOString(),
    mode: "collection_plan",
    status: collectionPlanStatus(liveWindowPlan, targets),
    live_window_status: liveWindowPlan.status,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    provider_mode: liveWindowPlan.provider_mode,
    cost_snapshot: report.cost_snapshot,
    sampling_policy: liveWindowPlan.sampling_policy,
    targets,
    safe_commands: collectionSafeCommands({ eventPlan, liveWindowPlan, targets }),
    provider_commands: collectionProviderCommands({ liveWindowPlan, targets }),
    blockers: liveWindowPlan.blockers,
    forbidden_actions: report.forbidden_collection_paths ?? [],
    safety: liveWindowPlan.safety,
  };
}

function collectionPlanStatus(liveWindowPlan, targets) {
  if (liveWindowPlan.status === "safety_stop") return "safety_stop";
  if (liveWindowPlan.status === "blocked") return "blocked";
  if (targets.some((target) => target.lane === "hot_watch")) return "live_watch";
  if (targets.some((target) => target.lane === "warm_watch")) return "monitor";
  return "cold";
}

function collectionTarget(row, liveWindowPlan) {
  const lane = collectionLane(row, liveWindowPlan);
  const cadence = collectionCadence(lane);
  return {
    match_id: row.match_id,
    label: row.label,
    attention: row.attention,
    lane,
    priority_score: row.priority_score,
    score_poll_seconds: cadence.score,
    odds_poll_seconds: cadence.odds,
    provider_lineage: row.freshness?.provider_lineage ?? [],
    source_preference: collectionSourcePreference(lane),
    provider_api_call_allowed: false,
    executes_now: false,
    reason: collectionTargetReason(row, lane, liveWindowPlan),
  };
}

function collectionLane(row, liveWindowPlan) {
  if (["blocked", "safety_stop"].includes(liveWindowPlan.status)) {
    return "frozen";
  }
  if (row.attention === "paper_candidate") return "hot_watch";
  if (row.attention === "live_monitor") return "warm_watch";
  if (row.attention === "stale_monitor") return "repair_watch";
  return "cold_watch";
}

function collectionCadence(lane) {
  return {
    hot_watch: { score: 15, odds: 5 },
    warm_watch: { score: 30, odds: 15 },
    repair_watch: { score: 60, odds: 60 },
    cold_watch: { score: 300, odds: 300 },
    frozen: { score: 0, odds: 0 },
  }[lane] ?? { score: 300, odds: 300 };
}

function collectionSourcePreference(lane) {
  if (lane === "frozen") return "internal_status_only";
  if (lane === "repair_watch") return "persisted_replay_then_resync_review";
  if (lane === "hot_watch") return "licensed_live_score_and_odds_stream";
  if (lane === "warm_watch") return "licensed_live_score_then_odds_snapshot";
  return "persisted_canonical_state";
}

function collectionTargetReason(row, lane, liveWindowPlan) {
  if (lane === "frozen") {
    return `Collection frozen because live window is ${liveWindowPlan.status}.`;
  }
  if (lane === "hot_watch") {
    return "Fresh Entrada match; shortest cadence is desired but execution remains outside this plan.";
  }
  if (lane === "repair_watch") {
    return "Match is stale; review replay/cursor state before increasing provider traffic.";
  }
  return `Match attention is ${row.attention}.`;
}

function collectionSafeCommands({ eventPlan, liveWindowPlan, targets }) {
  if (["blocked", "safety_stop"].includes(liveWindowPlan.status)) {
    return [collectionCommand({
      id: "route_events",
      command: "npm --silent run hermes:events",
      reason: `Resolve live-window blockers before changing provider cadence; severity=${eventPlan.severity}.`,
    })];
  }
  const commands = [
    collectionCommand({
      id: "match_pulse",
      command: "npm --silent run hermes:match-pulse",
      reason: "Refresh per-match priorities from internal APIs only.",
    }),
    collectionCommand({
      id: "live_window",
      command: "npm --silent run hermes:live-window",
      reason: "Reconfirm global gate before any operator-triggered provider collection.",
    }),
  ];
  if (targets.some((target) => target.lane === "repair_watch")) {
    commands.push(collectionCommand({
      id: "route_events",
      command: "npm --silent run hermes:events",
      reason: "Inspect stale/cursor conditions before spending live provider quota.",
    }));
  }
  return commands;
}

function collectionProviderCommands({ liveWindowPlan, targets }) {
  if (["blocked", "safety_stop"].includes(liveWindowPlan.status)) {
    return [];
  }
  if (!targets.some((target) => ["hot_watch", "warm_watch"].includes(target.lane))) {
    return [];
  }
  return [
    {
      id: "live_budget_ingest_candidate",
      command: "npm run api:ingest:live-budget",
      reason: "Operator may run the licensed budget ingestion cycle if provider keys/quota are intentionally available.",
      executes_now: false,
      writes: false,
      live_api_calls: false,
      provider_api_call_allowed: false,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      requires_admin_token: false,
    },
  ];
}

function collectionCommand({ id, command, reason }) {
  return {
    id,
    command,
    reason,
    executes_now: false,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    requires_admin_token: false,
  };
}

function buildQuotaPlan({ report, collection }) {
  const throttle = quotaThrottle(report, collection);
  const effectiveTargets = collection.targets.map((target) => applyQuotaThrottle(target, throttle));
  return {
    generated_at: new Date().toISOString(),
    mode: "quota_plan",
    status: quotaPlanStatus(collection, throttle),
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    live_window_status: collection.live_window_status,
    collection_status: collection.status,
    cost_snapshot: report.cost_snapshot,
    throttle,
    effective_targets: effectiveTargets,
    safe_commands: quotaSafeCommands(collection, throttle),
    provider_commands: quotaProviderCommands(collection, throttle),
    blockers: collection.blockers,
    forbidden_actions: collection.forbidden_actions,
    safety: collection.safety,
  };
}

function quotaThrottle(report, collection) {
  const cost = report.cost_snapshot ?? {};
  const utilization = ratio(cost.estimated_monthly_spend_usd, cost.monthly_budget_usd);
  const hasSafetyStop = collection.status === "safety_stop"
    || collection.safety?.real_execution_hard_block !== true
    || collection.safety?.can_submit_real_orders === true;
  if (hasSafetyStop) {
    return quotaThrottleState({
      level: "safety_stop",
      budgetUtilization: utilization,
      scoreMultiplier: 0,
      oddsMultiplier: 0,
      providerCommandsAllowed: false,
      reason: "Safety stop: real execution is not proven hard-blocked.",
    });
  }
  if (collection.status === "blocked") {
    return quotaThrottleState({
      level: "blocked",
      budgetUtilization: utilization,
      scoreMultiplier: 0,
      oddsMultiplier: 0,
      providerCommandsAllowed: false,
      reason: "Collection plan is blocked; keep provider traffic frozen.",
    });
  }
  if (utilization >= 1) {
    return quotaThrottleState({
      level: "budget_exhausted",
      budgetUtilization: utilization,
      scoreMultiplier: 0,
      oddsMultiplier: 0,
      providerCommandsAllowed: false,
      reason: "Projected monthly spend is at or above budget.",
    });
  }
  if (utilization >= 0.9) {
    return quotaThrottleState({
      level: "budget_guard",
      budgetUtilization: utilization,
      scoreMultiplier: 4,
      oddsMultiplier: 12,
      providerCommandsAllowed: false,
      reason: "Projected monthly spend is near the budget; slow down hot polling and suppress provider candidates.",
    });
  }
  if (utilization >= 0.75) {
    return quotaThrottleState({
      level: "cost_watch",
      budgetUtilization: utilization,
      scoreMultiplier: 2,
      oddsMultiplier: 3,
      providerCommandsAllowed: false,
      reason: "Projected monthly spend is elevated; keep cadence selective.",
    });
  }
  return quotaThrottleState({
    level: "normal",
    budgetUtilization: utilization,
    scoreMultiplier: 1,
    oddsMultiplier: 1,
    providerCommandsAllowed: false,
    reason: "Budget utilization is inside normal operating range.",
  });
}

function quotaThrottleState({
  level,
  budgetUtilization,
  scoreMultiplier,
  oddsMultiplier,
  providerCommandsAllowed,
  reason,
}) {
  return {
    level,
    budget_utilization: budgetUtilization,
    score_multiplier: scoreMultiplier,
    odds_multiplier: oddsMultiplier,
    provider_commands_allowed: providerCommandsAllowed,
    reason,
  };
}

function applyQuotaThrottle(target, throttle) {
  const frozen = ["safety_stop", "blocked", "budget_exhausted"].includes(throttle.level);
  return {
    ...target,
    lane: frozen ? "frozen" : target.lane,
    score_poll_seconds: frozen ? 0 : Math.max(target.score_poll_seconds, target.score_poll_seconds * throttle.score_multiplier),
    odds_poll_seconds: frozen ? 0 : Math.max(target.odds_poll_seconds, target.odds_poll_seconds * throttle.odds_multiplier),
    provider_api_call_allowed: false,
    executes_now: false,
    quota_throttle_level: throttle.level,
  };
}

function quotaPlanStatus(collection, throttle) {
  if (throttle.level === "safety_stop") return "safety_stop";
  if (["blocked", "budget_exhausted"].includes(throttle.level)) return "blocked";
  if (["budget_guard", "cost_watch"].includes(throttle.level)) return "throttled";
  return collection.status === "live_watch" ? "normal" : collection.status;
}

function quotaSafeCommands(collection, throttle) {
  if (["safety_stop", "blocked", "budget_exhausted"].includes(throttle.level)) {
    return [collectionCommand({
      id: "route_events",
      command: "npm --silent run hermes:events",
      reason: "Resolve blockers or budget exhaustion before live provider traffic.",
    })];
  }
  return [collectionCommand({
    id: "collection_plan",
    command: "npm --silent run hermes:collection-plan",
    reason: "Refresh desired cadence from internal state before any operator-triggered provider cycle.",
  })];
}

function quotaProviderCommands(collection, throttle) {
  if (!throttle.provider_commands_allowed) return [];
  return collection.provider_commands.map((command) => ({
    ...command,
    executes_now: false,
    provider_api_call_allowed: false,
  }));
}

function buildLiveController({
  report,
  eventPlan,
  liveWindowPlan,
  pulse,
  collection,
  quota,
  sourceRoutes,
}) {
  const decision = chooseLiveControllerDecision({
    eventPlan,
    liveWindowPlan,
    pulse,
    collection,
    quota,
    sourceRoutes,
  });
  return {
    generated_at: new Date().toISOString(),
    mode: "live_controller",
    status: liveControllerStatus({ liveWindowPlan, quota }),
    summary: `Hermes live controller: action=${decision.action}, live_window=${liveWindowPlan.status}, quota=${quota.throttle?.level}`,
    read_only: true,
    writes: false,
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: false,
    llm_per_tick_allowed: false,
    provider_mode: liveWindowPlan.provider_mode,
    operator_decision: decision,
    live_window: {
      status: liveWindowPlan.status,
      window_open: liveWindowPlan.window_open,
      autopilot_candidate: liveWindowPlan.autopilot_candidate,
      blockers: liveWindowPlan.blockers,
    },
    match_pulse: {
      status: pulse.status,
      matches_seen: pulse.matches_seen,
      top_match: pulse.top_match,
      target_summary: summarizeControllerTargets(quota.effective_targets),
    },
    collection: {
      status: collection.status,
      provider_command_count: collection.provider_commands.length,
      safe_command_count: collection.safe_commands.length,
      provider_candidates: collection.provider_commands.map(sanitizeControllerCommand),
    },
    quota: {
      status: quota.status,
      throttle: quota.throttle,
      effective_target_count: quota.effective_targets.length,
      provider_command_count: quota.provider_commands.length,
    },
    source_route: {
      status: sourceRoutes.status,
      next_route: sourceRoutes.next_route,
      blocked_routes: (sourceRoutes.routes ?? []).filter((route) => route.status === "blocked").map((route) => route.id),
    },
    control_policy: {
      event_driven_not_tick_driven: true,
      allowed_route_optimization_only: true,
      provider_spend_requires_operator: true,
      provider_commands_execute_now: false,
      strong_model_per_tick_allowed: false,
      sportsbook_bypass_allowed: false,
    },
    forbidden_actions: report.forbidden_collection_paths ?? [],
    safety: {
      real_execution_hard_block: report.safety?.real_execution_hard_block,
      can_submit_real_orders: false,
      can_create_paper_orders: false,
      provider_api_call_allowed: false,
      sportsbook_bypass_allowed: false,
      browser_sportsbook_automation_allowed: false,
      llm_per_tick_allowed: false,
    },
    events: eventPlan.events.map((item) => ({
      type: item.type,
      severity: item.severity,
      can_create_orders: item.can_create_orders,
      allowed_command: item.allowed_command,
    })),
  };
}

function liveControllerStatus({ liveWindowPlan, quota }) {
  if (liveWindowPlan.status === "safety_stop" || quota.status === "safety_stop") return "safety_stop";
  if (liveWindowPlan.status === "blocked" || quota.status === "blocked") return "blocked";
  if (quota.status === "throttled") return "throttled";
  if (liveWindowPlan.status === "paper_ready") return "paper_ready";
  if (quota.status === "normal") return "live_watch";
  return "monitor";
}

function chooseLiveControllerDecision({
  eventPlan,
  liveWindowPlan,
  pulse,
  collection,
  quota,
  sourceRoutes,
}) {
  if (["safety_stop", "blocked"].includes(liveWindowPlan.status) || ["safety_stop", "blocked"].includes(quota.status)) {
    const command = quota.safe_commands[0] ?? collection.safe_commands[0] ?? liveWindowPlan.next_action;
    return liveControllerDecision({
      action: "freeze_collection",
      reason: `Live data collection is frozen until blockers clear; severity=${eventPlan.severity}.`,
      nextCommand: command,
      cadence: "frozen",
      sourceRoute: sourceRoutes.next_route,
    });
  }
  if (quota.status === "throttled") {
    return liveControllerDecision({
      action: "throttle_internal_watch",
      reason: quota.throttle?.reason ?? "Quota guardrail is active; keep collection selective.",
      nextCommand: quota.safe_commands[0],
      cadence: "throttled",
      sourceRoute: sourceRoutes.next_route,
    });
  }
  if (liveWindowPlan.autopilot_candidate && eventPlan.can_run_paper_autopilot) {
    return liveControllerDecision({
      action: "paper_autopilot_candidate",
      reason: "Fresh Entrada exists in a paper-ready window; backend-only paper autopilot is the protected next route.",
      nextCommand: liveWindowPlan.next_action,
      protectedCommand: liveWindowPlan.next_action,
      cadence: "hot_watch",
      sourceRoute: sourceRoutes.next_route,
      topMatch: pulse.top_match,
    });
  }
  if (collection.status === "live_watch") {
    return liveControllerDecision({
      action: "operator_provider_candidate",
      reason: "Hot or warm matches are present; provider ingestion remains an operator-only candidate.",
      nextCommand: collection.safe_commands[0],
      providerCommand: collection.provider_commands[0] ?? null,
      cadence: "event_driven_watchlist",
      sourceRoute: sourceRoutes.next_route,
      topMatch: pulse.top_match,
    });
  }
  return liveControllerDecision({
    action: "observe_internal_state",
    reason: "No protected paper route or live provider cadence escalation is currently justified.",
    nextCommand: collection.safe_commands[0] ?? liveWindowPlan.next_action,
    cadence: "monitor",
    sourceRoute: sourceRoutes.next_route,
    topMatch: pulse.top_match,
  });
}

function liveControllerDecision({
  action,
  reason,
  nextCommand,
  protectedCommand = null,
  providerCommand = null,
  cadence,
  sourceRoute,
  topMatch = null,
}) {
  return {
    action,
    reason,
    cadence,
    next_safe_command: sanitizeControllerCommand(nextCommand),
    protected_backend_action: protectedCommand ? sanitizeControllerCommand(protectedCommand) : null,
    provider_candidate: providerCommand ? sanitizeControllerCommand(providerCommand) : null,
    source_route_id: sourceRoute?.id ?? null,
    source_route_lane: sourceRoute?.lane ?? null,
    top_match_id: topMatch?.match_id ?? null,
    executes_now: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
  };
}

function sanitizeControllerCommand(command) {
  if (!command) return null;
  return {
    id: command.id,
    command: command.command,
    reason: command.reason,
    requires_admin_token: Boolean(command.requires_admin_token),
    writes: Boolean(command.writes),
    live_api_calls: false,
    provider_api_call_allowed: false,
    can_submit_real_orders: false,
    can_create_paper_orders: Boolean(command.can_create_paper_orders),
    executes_now: false,
  };
}

function summarizeControllerTargets(targets) {
  const counts = {};
  for (const target of targets ?? []) {
    const lane = target.lane ?? "unknown";
    counts[lane] = (counts[lane] ?? 0) + 1;
  }
  return {
    total: (targets ?? []).length,
    lanes: counts,
    fastest_score_poll_seconds: minPositive((targets ?? []).map((target) => target.score_poll_seconds)),
    fastest_odds_poll_seconds: minPositive((targets ?? []).map((target) => target.odds_poll_seconds)),
  };
}

function minPositive(values) {
  const positive = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return positive.length ? Math.min(...positive) : 0;
}

function buildLearningReview(report, eventPlan, playbookPlan) {
  const learning = report.learning_snapshot ?? {};
  const budget = report.budget_chain_snapshot ?? {};
  const safety = report.safety ?? {};
  const readyForReview = learning.readiness_status === "ready_for_review";
  const canRunBacktest = Boolean(learning.can_run_live_backtest);
  const replayBackfillSeedsReady = learning.replay_backfill_seed_status === "ready"
    && Number(learning.replay_backfill_seed_count ?? 0) > 0;
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
      replay_backfill_seed_status: learning.replay_backfill_seed_status ?? "collecting",
      replay_backfill_seed_count: learning.replay_backfill_seed_count ?? 0,
      closing_line_proxy_seed_ready: Boolean(learning.closing_line_proxy_seed_ready),
      paper_learning_seed_ready: Boolean(learning.paper_learning_seed_ready),
      signal_gate_regression_ready: Boolean(learning.signal_gate_regression_ready),
    },
    gates: {
      budget_chain_completed: budgetComplete,
      enterprise_eligible: Boolean(budget.enterprise_eligible),
      can_run_live_backtest: canRunBacktest,
      ready_for_review: readyForReview,
      replay_backfill_rehearsal_seed_ready: replayBackfillSeedsReady,
      can_promote_model_from_replay_seeds: false,
      high_severity_blockers: highBlockers.length,
      real_execution_hard_block: safety.real_execution_hard_block === true,
    },
    blockers: [
      ...(!budgetComplete ? ["budget_chain_incomplete"] : []),
      ...(!canRunBacktest ? ["live_backtest_dataset_not_ready"] : []),
      ...(!readyForReview ? ["paper_readiness_not_ready_for_review"] : []),
      ...(replayBackfillSeedsReady && !canRunBacktest ? ["replay_backfill_seeds_rehearsal_only"] : []),
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
  "doctor-triage": doctorTriage,
  "channel-readiness": channelReadiness,
  "channel-recovery-plan": channelRecoveryPlan,
  "backend-readiness": backendReadiness,
  "backend-latency-triage": backendLatencyTriage,
  "mission-control": missionControl,
  "mission-ledger": missionLedger,
  "mission-ledger-report": missionLedgerReport,
  intelligence,
  events,
  "unblock-plan": unblockPlan,
  playbook,
  "live-stats": liveStats,
  "live-window": liveWindow,
  "match-pulse": matchPulse,
  "grand-slam-readiness": grandSlamReadiness,
  "grand-slam-scoreline-forecast": grandSlamScorelineForecast,
  "grand-slam-mission": grandSlamMission,
  "grand-slam-mission-ledger": grandSlamMissionLedger,
  "grand-slam-mission-ledger-report": grandSlamMissionLedgerReport,
  "collection-plan": collectionPlan,
  "quota-plan": quotaPlan,
  "live-controller": liveController,
  "live-controller-ledger": liveControllerLedger,
  "live-controller-ledger-report": liveControllerLedgerReport,
  "learning-review": learningReview,
  "budget-chain": budgetChain,
  "provider-smoke": providerSmoke,
  "safe-loop": safeLoop,
  "autonomy-brief": autonomyBrief,
  "source-discovery": sourceDiscovery,
  "source-route-matrix": sourceRouteMatrix,
  "source-route-ledger": sourceRouteLedger,
  "source-route-ledger-report": sourceRouteLedgerReport,
  "replay-backfill-contract": replayBackfillContract,
  "source-use-manifest": sourceUseManifest,
  "source-use-ledger": sourceUseLedger,
  "source-use-ledger-report": sourceUseLedgerReport,
  "source-intake-plan": sourceIntakePlan,
  "source-intake-ledger": sourceIntakeLedger,
  "source-intake-ledger-report": sourceIntakeLedgerReport,
  "historical-backfill-plan": historicalBackfillPlan,
  "enterprise-accuracy-plan": enterpriseAccuracyPlan,
  "enterprise-readiness": enterpriseReadiness,
  "trigger-policy": triggerPolicy,
  "ops-compiler": opsCompiler,
  "capability-audit": capabilityAudit,
  "autonomy-gates": autonomyGates,
  "experiment-lab": experimentLab,
  "experiment-ledger": experimentLedger,
  "experiment-ledger-report": experimentLedgerReport,
  "backlog-plan": backlogPlan,
  "autonomy-effectiveness": autonomyEffectiveness,
  "implementation-handoff": implementationHandoff,
  "operator-packet": operatorPacket,
  "operator-ledger": operatorLedger,
  "operator-ledger-report": operatorLedgerReport,
  "runtime-fix-priorities": runtimeFixPriorities,
  "scheduler-rehearsal": schedulerRehearsal,
  "cron-proposal": cronProposal,
  "activation-checklist": activationChecklist,
  "runtime-fix-plan": runtimeFixPlan,
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
