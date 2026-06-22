#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const command = process.argv[2] ?? "briefing";
const apiBaseArg = process.argv.find((arg) => arg.startsWith("--api-base="));
const API_BASE = apiBaseArg ? apiBaseArg.slice("--api-base=".length) : "http://127.0.0.1:8000";
const TOKEN_STDIN_FLAG = "--token-stdin";

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
  const parsed = Number(value ?? 1_500);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1_500;
  }
  return Math.min(Math.max(Math.trunc(parsed), 100), 5_000);
}

async function safeRequest(path, fallback, label = path) {
  try {
    return { data: await request(path), error: null };
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
  const responses = await Promise.all([
    safeRequest("/api/v1/agent/preflight", backendUnavailablePreflight, "preflight"),
    safeRequest("/api/v1/dashboard/live-state", backendUnavailableDashboardState, "dashboard_state"),
    safeRequest("/api/v1/live/matches", [], "live_matches"),
    safeRequest("/api/v1/provider-health", backendUnavailableProviderHealth, "provider_health"),
    safeRequest("/api/v1/cost-profile", backendUnavailableCostProfile, "cost_profile"),
    safeRequest("/api/v1/execution/status", backendUnavailableExecutionStatus, "execution_status"),
  ]);
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

async function runtimeCheckData() {
  const hermesBin = process.env.HERMES_BIN || "hermes";
  const commands = [
    await runLocalCommand("hermes status", hermesBin, ["status"]),
    await runLocalCommand("hermes doctor", hermesBin, ["doctor"]),
  ];
  const hasMissingCommand = commands.some((item) => item.error_code === "command_not_found");
  const hasFailure = commands.some((item) => item.exit_code !== 0 || item.timed_out || item.error_code);
  const runtimeFindings = buildRuntimeFindings(commands);
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
    diagnostic_actions: runtimeDiagnosticActions({ hasMissingCommand, hasFailure, runtimeFindings }),
    next_actions: runtimeCheckActions({ hasMissingCommand, hasFailure, runtimeFindings }),
  };
}

async function doctorTriageData() {
  const hermesBin = process.env.HERMES_BIN || "hermes";
  const doctorTimeoutMs = boundedDoctorTriageTimeoutMs();
  const commands = [
    await runLocalCommand("hermes version", hermesBin, ["--version"], 1_000),
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
      command: "npm run hermes:runtime-check",
      reason: "Hermes doctor must pass bounded diagnostics before channel readiness is accepted.",
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

function backendReadinessActions({ checks, requestErrors }) {
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  const actions = [];
  if (requestErrors.length || byId.internal_api_reachable?.status !== "pass") {
    actions.push(backendReadinessAction({
      id: "start_or_inspect_fastapi_manual_review",
      priority: 10,
      lane: "local_backend",
      command: "npm run api:dev",
      reason: "Hermes cannot use live-window or backend-gated paper routes until the local FastAPI service is reachable.",
      mutatesRuntimeIfRun: true,
      requiresOperatorConfirmation: true,
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

function buildDoctorTriage({ hermesBin, doctorTimeoutMs, commands, runtimeFindings }) {
  const versionCommand = commands.find((item) => item.name === "hermes version");
  const statusCommand = commands.find((item) => item.name === "hermes status");
  const doctorCommand = commands.find((item) => item.name === "hermes doctor short");
  const likelyCause = doctorTriageLikelyCause({ versionCommand, statusCommand, doctorCommand, runtimeFindings });
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
    next_safe_actions: doctorTriageActions({ likelyCause, runtimeFindings }),
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

function doctorTriageLikelyCause({ versionCommand, statusCommand, doctorCommand, runtimeFindings }) {
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

function doctorTriageActions({ likelyCause, runtimeFindings }) {
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
  const report = await intelligenceData();
  const eventPlan = buildEventPlan(report);
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  printJson(buildSourceRouteMatrix({ report, eventPlan, sourcePlan }));
}

async function triggerPolicy() {
  const [loop, report] = await Promise.all([
    safeLoopData(),
    intelligenceData(),
  ]);
  const eventPlan = buildEventPlan(report);
  const sourcePlan = buildSourceDiscovery({ report, eventPlan });
  printJson(buildTriggerPolicy({ loop, sourcePlan }));
}

async function opsCompiler() {
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
  printJson(buildOpsCompiler({
    loop,
    sourcePlan,
    triggerPlan,
    autonomyPlan,
    operator,
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
  const rehearsal = buildSchedulerRehearsal(loop);
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
  const rehearsal = buildSchedulerRehearsal(loop);
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
  const experimentReport = buildExperimentLedgerReport(readExperimentLedgerRecords());
  const operatorReport = buildOperatorLedgerReport(readOperatorLedgerRecords());
  const missionReport = buildMissionLedgerReport(readMissionLedgerRecords());
  const runtimePriorities = buildRuntimeFixPriorities(operatorReport);
  printJson(buildBacklogPlan({ experimentReport, operatorReport, missionReport, runtimePriorities }));
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
  const loop = await safeLoopData();
  const rehearsal = buildSchedulerRehearsal(loop);
  writeSchedulerAudit(rehearsal);
  printJson(rehearsal);
}

async function cronProposal() {
  const loop = await safeLoopData();
  const rehearsal = buildSchedulerRehearsal(loop);
  writeSchedulerAudit(rehearsal);
  const proposal = buildCronProposal(rehearsal);
  writeCronProposal(proposal);
  printJson(proposal);
}

async function activationChecklist() {
  const loop = await safeLoopData();
  const rehearsal = buildSchedulerRehearsal(loop);
  writeSchedulerAudit(rehearsal);
  const proposal = buildCronProposal(rehearsal);
  writeCronProposal(proposal);
  printJson(buildActivationChecklist({ loop, rehearsal, proposal }));
}

async function runtimeFixPlan() {
  const loop = await safeLoopData();
  const rehearsal = buildSchedulerRehearsal(loop);
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
    actions.push(runtimeDiagnosticAction({
      id: "bounded_doctor_review",
      command: "npm run hermes:runtime-check",
      reason: "Hermes doctor timed out inside bounded diagnostics; keep using the bounded repo wrapper instead of unbounded doctor calls.",
    }));
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
      "Hermes doctor timed out in bounded diagnostics; use npm run hermes:runtime-check instead of unbounded doctor calls.",
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
      diagnostic_actions: runtime.diagnostic_actions,
    },
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

function buildTriggerPolicy({ loop, sourcePlan }) {
  const triggers = buildWakeTriggers({ loop, sourcePlan });
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

function buildOpsCompiler({ loop, sourcePlan, triggerPlan, autonomyPlan, operator }) {
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
    execution_graph: buildExecutionGraph({ triggerPlan, sourcePlan, autonomyPlan, operator }),
    model_router: buildOpsModelRouter({ loop, triggerPlan }),
    operator_packet: {
      priority: operator.priority,
      headline: operator.headline,
      short_message: operator.short_message,
      next_action: operator.next_action,
      cost_guard: operator.cost_guard,
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
    autonomy_brief: {
      recommended_lane: autonomyPlan.recommended_lane,
      autonomy_matrix: autonomyPlan.autonomy_matrix,
    },
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

function buildExecutionGraph({ triggerPlan, sourcePlan, autonomyPlan, operator }) {
  return [
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
  if (runtimeFindings?.gateway_service_status === "running"
    && runtimeFindings?.doctor_status === "timed_out"
    && (runtimeFindings?.blockers ?? []).includes("doctor_timed_out")) {
    return "npm run hermes:doctor-triage";
  }
  return "npm run hermes:runtime-check";
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

function buildExperimentLab({ loop, report, eventPlan, sourcePlan, capabilityAuditPlan, gates }) {
  const experiments = buildExperimentRows({ loop, report, eventPlan, sourcePlan, capabilityAuditPlan, gates })
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

function buildExperimentRows({ loop, report, eventPlan, sourcePlan, capabilityAuditPlan, gates }) {
  const gateById = Object.fromEntries((gates.gates ?? []).map((gate) => [gate.id, gate]));
  const runtimeReady = gateById.channel_ready?.status === "pass";
  const cronReady = gateById.cron_ready?.status === "pass";
  const paperReady = gateById.paper_ready?.status === "pass";
  const learningReady = gateById.learning_ready?.status === "pass";
  const enterpriseEligible = gateById.enterprise_review?.status === "pass";
  const replayOrPersisted = Number(report.data_snapshot?.persisted_matches ?? 0) > 0
    || report.data_snapshot?.provider_mode === "replay";
  return [
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
      command: "npm --silent run hermes:source-discovery",
      hypothesis: "Allowed API/replay/operator-note routes can improve data density without scraping, bypass, or paid quota spend.",
      prerequisites: ["licensed_or_internal_sources_only"],
      successMetrics: ["allowed_collection_paths", "blocked_routes_count", "persisted_matches"],
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

function buildBacklogPlan({ experimentReport, operatorReport, missionReport, runtimePriorities }) {
  const items = buildBacklogItems({ experimentReport, operatorReport, missionReport, runtimePriorities })
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

function buildBacklogItems({ experimentReport, operatorReport, missionReport, runtimePriorities }) {
  const items = [];
  const topExperiment = experimentReport.top_experiment;
  const ready = experimentReport.ready_experiment_counts ?? {};
  const topBlocker = operatorReport.top_blocker;
  const topMissionAction = missionReport.top_next_action;
  const missionLaneCounts = missionReport.blocked_lane_counts ?? {};
  const missionNextLaneCounts = missionReport.next_lane_counts ?? {};
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

  if (!items.length) {
    items.push(backlogItem({
      id: "collect_more_hermes_operating_evidence",
      title: "Collect more Hermes operating evidence before changing code",
      priority: 90,
      source: ["experiment_ledger", "operator_ledger"],
      frequency: 0,
      rationale: "No repeated pattern is strong enough yet; continue ledger collection instead of guessing.",
      targetFiles: ["hermes/runs/*.jsonl"],
      validationCommands: [
        "npm --silent run hermes:experiment-ledger",
        "npm --silent run hermes:operator-ledger",
        "npm --silent run hermes:backlog-plan",
      ],
      acceptanceEvidence: [
        "experiment_ledger.total_records increases",
        "operator_ledger.total_records increases",
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
      status: loop.runtime?.status === "ready" ? "ready" : "degraded",
      score: loop.runtime?.status === "ready" ? 100 : 35,
      command: "npm run hermes:runtime-check",
      reason: "Runtime diagnostics determine whether cron, Telegram and gateway packets can be trusted.",
      evidence: [
        `runtime.status=${loop.runtime?.status ?? "unknown"}`,
        `safe_loop.status=${loop.status}`,
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
  if (capabilities.some((capability) => ["degraded", "pending", "collecting", "monitor"].includes(capability.status))) {
    return "partial";
  }
  return "ready";
}

function capabilityAutonomyCeiling({ loop, capabilities }) {
  const byId = Object.fromEntries(capabilities.map((capability) => [capability.id, capability]));
  if (loop.status === "safety_stop") {
    return ceiling("observe_only", "safety", "Real-execution or forbidden-route safety must be inspected first.");
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

function buildWakeTriggers({ loop, sourcePlan }) {
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
      command: "npm run hermes:runtime-check",
      condition: `runtime.status=${loop.runtime?.status ?? "unknown"}`,
      reason: "Collect local Hermes diagnostics before protected automation.",
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
  if (loop.runtime?.status !== "ready") {
    return autonomyLane("stabilize_runtime", 10, "local_runtime", "Fix Hermes local runtime diagnostics before protected automation.");
  }
  const topRuntimePriority = runtimePriorities.next_priority;
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
  for (const priority of runtimePriorities.priorities.slice(0, 3)) {
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
      command: "npm run hermes:runtime-check",
      reason: "Hermes local runtime is missing or degraded; collect CLI diagnostics without repair.",
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
    cost_guard: {
      throttle_level: loop.quota_plan?.throttle_level,
      budget_utilization: loop.quota_plan?.budget_utilization,
      provider_command_count: loop.quota_plan?.provider_command_count ?? 0,
      provider_api_call_allowed: false,
    },
    runtime: {
      status: loop.runtime?.status,
      next_actions: loop.runtime?.next_actions ?? [],
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
  if (loop.status === "runtime_degraded") return "high";
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
  return [
    `Hermes ${priority}: ${loop.status} in ${loop.active_phase}.`,
    `Runtime=${loop.runtime?.status}; data=${loop.live_stats?.collection_status}/${loop.live_stats?.processing_status}; quota=${loop.quota_plan?.throttle_level ?? "unknown"} (${budget}).`,
    `Next: ${command}.`,
    `Why: ${reason}`,
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

function buildSchedulerRehearsal(loop) {
  const schedule = schedulerSchedule(loop);
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
      sampling_policy: loop.live_stats?.sampling_policy,
      safety: loop.safety,
    },
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

function schedulerSchedule(loop) {
  const policy = loop.live_stats?.sampling_policy ?? {};
  const baseMinutes = Number(policy.poll_interval_minutes ?? 5);
  const safeLoopInterval = loop.status === "runtime_degraded"
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
      id: "trigger_policy",
      command: "npm --silent run hermes:trigger-policy",
      everyMinutes: 5,
      reason: "Refresh safe wakeup triggers for cron, Telegram, dashboard, Cloudflare Agent, and OpenClaw gateway.",
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
  return dedupeSchedule(rows);
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
  if (loop.status === "runtime_degraded") {
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
    .map(runtimeFixActionFor)
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

function runtimeFixActionFor(check) {
  const reason = check.summary;
  const checkId = check.id ?? check.name;
  const actions = {
    hermes_runtime_ready: {
      id: "fix_hermes_runtime_ready",
      priority: 10,
      lane: "local_runtime",
      command: "npm run hermes:runtime-check",
      reason,
      requiresHuman: false,
      notes: [
        "Inspect Hermes status and doctor output.",
        "Do not restart, install, repair, or edit LaunchAgents from this command.",
      ],
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
  "doctor-triage": doctorTriage,
  "channel-readiness": channelReadiness,
  "channel-recovery-plan": channelRecoveryPlan,
  "backend-readiness": backendReadiness,
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
  "collection-plan": collectionPlan,
  "quota-plan": quotaPlan,
  "learning-review": learningReview,
  "budget-chain": budgetChain,
  "provider-smoke": providerSmoke,
  "safe-loop": safeLoop,
  "autonomy-brief": autonomyBrief,
  "source-discovery": sourceDiscovery,
  "source-route-matrix": sourceRouteMatrix,
  "trigger-policy": triggerPolicy,
  "ops-compiler": opsCompiler,
  "capability-audit": capabilityAudit,
  "autonomy-gates": autonomyGates,
  "experiment-lab": experimentLab,
  "experiment-ledger": experimentLedger,
  "experiment-ledger-report": experimentLedgerReport,
  "backlog-plan": backlogPlan,
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
