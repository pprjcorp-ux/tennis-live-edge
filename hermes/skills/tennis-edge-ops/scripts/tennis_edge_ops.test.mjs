import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const SCRIPT = new URL("./tennis_edge_ops.mjs", import.meta.url).pathname;

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, apiBase: `http://127.0.0.1:${port}` });
    });
  });
}

async function runCli(args, { stdin = "", env = {}, timeoutMs = 15_000 } = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  child.stdin.end(stdin);
  const [exit] = await once(child, "close");
  clearTimeout(timeout);
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  return { exit, stdout, stderr };
}

function eventRouterFixtures(overrides = {}) {
  return {
    "/api/v1/agent/briefing": {
      summary: "Hermes can monitor 2 matches.",
      autopilot_enabled: true,
      entry_signals: 1,
      provider_alerts: 0,
      readiness_status: "collecting",
    },
    "/api/v1/agent/preflight": {
      status: "ready",
      checks: [{ name: "real_execution_hard_block", status: "pass", summary: "blocked" }],
      generated_at: "2026-06-21T20:00:00Z",
    },
    "/api/v1/agent/anomalies": [],
    "/api/v1/provider-health": [
      { provider: "api_tennis", status: "healthy" },
      { provider: "odds_api_io", status: "healthy" },
    ],
    "/api/v1/provider-cursors": [],
    "/api/v1/data-quality": [],
    "/api/v1/cost-profile": {
      active_plan: "lean_atp",
      estimated_monthly_spend_usd: 377,
      monthly_budget_usd: 500,
      coverage_scope: ["atp_main", "grand_slam_men", "grand_slam_women"],
    },
    "/api/v1/cost-report/daily": {
      live_api_calls: 3,
      cost_per_signal_usd: 0.25,
    },
    "/api/v1/paper/performance": {
      readiness_status: "collecting",
      roi: 0.02,
      clv: 0.01,
      settled_orders: 42,
    },
    "/api/v1/execution/status": {
      real_execution_hard_block: true,
      can_submit_real_orders: false,
      stage: "paper",
    },
    "/api/v1/bankroll": {
      balance: 10000,
      currency: "USD",
      open_exposure: 0,
      daily_pnl: 0,
      weekly_pnl: 0,
    },
    "/api/v1/signals/live": [
      { id: "sig_1", status: "Entrada" },
      { id: "sig_2", status: "Bloqueado" },
    ],
    "/api/v1/ingestion/runs": [
      {
        id: "ingest_1",
        run_type: "live_budget_cycle",
        source: "cli",
        status: "completed",
      },
    ],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        source_summary: { total_matches: 2, persisted_matches: 2 },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          budget_chain_completed: true,
          enterprise_eligible: false,
          current_step: null,
          steps: [
            {
              order: 1,
              provider: "theoddsapi",
              capability: "archive_odds",
              status: "configured",
              configured: true,
              current: false,
              last_smoke_status: "completed",
              last_smoke_at: "2026-06-21T20:00:00Z",
              smoke_completed: true,
              required_before_enable: [],
              next_action: "Keep as REST archive/comparison and never override fresher persisted live odds.",
              notes: ["Lowest-risk paid provider to connect first."],
            },
          ],
        },
        source_summary: {
          total_matches: 2,
          persisted_matches: 2,
          match_freshness: [
            {
              match_id: "match_1",
              source: "live",
              persisted: true,
              score_age_ms: 8000,
              odds_age_ms: 5000,
            },
            {
              match_id: "match_2",
              source: "live",
              persisted: true,
              score_age_ms: 40000,
              odds_age_ms: 22000,
            },
          ],
        },
      },
    },
    ...overrides,
  };
}

test("autopilot aborts before protected action when preflight is blocked", async () => {
  let autopilotCalled = false;
  const { server, apiBase } = await startServer((request, response) => {
    if (request.url === "/api/v1/agent/preflight") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "blocked", checks: [] }));
      return;
    }
    if (request.url === "/api/v1/agent/autopilot/evaluate") {
      autopilotCalled = true;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ run: { id: "bad" } }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["autopilot", `--api-base=${apiBase}`, "--token-stdin"], {
      stdin: "local-admin",
    });

    assert.equal(result.exit, 1);
    assert.match(result.stderr, /Hermes preflight blocked autopilot/i);
    assert.equal(autopilotCalled, false);
  } finally {
    server.close();
  }
});

test("autopilot proceeds when preflight is degraded but not blocked", async () => {
  let autopilotCalled = false;
  let receivedBody = null;
  const { server, apiBase } = await startServer((request, response) => {
    if (request.url === "/api/v1/agent/preflight") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "degraded", checks: [] }));
      return;
    }
    if (request.url === "/api/v1/agent/autopilot/evaluate") {
      autopilotCalled = true;
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            run: { id: "agent_1", summary: "ok", actions: [] },
            paper_orders_created: 0,
            paper_orders_skipped: 0,
            real_execution_blocked: false,
          })
        );
      });
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["autopilot", `--api-base=${apiBase}`, "--token-stdin"], {
      stdin: "local-admin",
    });

    assert.equal(result.exit, 0);
    assert.equal(autopilotCalled, true);
    assert.equal(receivedBody.source, "hermes");
    assert.equal(receivedBody.request_real_execution, false);
  } finally {
    server.close();
  }
});

test("ingest-live-budget prints consolidated no-key summary without protected actions", async () => {
  const result = await runCli(
    [
      "ingest-live-budget",
      "--date",
      "2026-06-07",
      "--odds-max-messages",
      "1",
      "--odds-timeout-seconds",
      "0.01",
    ],
    {
      env: {
        TENNIS_EDGE_DATA_MODE: "live",
        TENNIS_EDGE_PERSISTENCE_ENABLED: "false",
        API_TENNIS_KEY: "",
        ODDS_API_IO_KEY: "",
      },
    }
  );

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.target_date, "2026-06-07");
  assert.equal(payload.score_ingestion.source, "empty");
  assert.equal(payload.odds_ingestion.connected, false);
  assert.equal(payload.can_submit_real_orders, false);
});

test("ingestion-runs reads the persisted run journal endpoint", async () => {
  const { server, apiBase } = await startServer((request, response) => {
    if (request.url === "/api/v1/ingestion/runs") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify([
          {
            id: "ingest_1",
            run_type: "live_budget_cycle",
            source: "cli",
            status: "skipped",
            summary: {},
            started_at: "2026-06-07T20:00:00Z",
            completed_at: "2026-06-07T20:00:01Z",
          },
        ])
      );
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["ingestion-runs", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload[0].id, "ingest_1");
    assert.equal(payload[0].run_type, "live_budget_cycle");
  } finally {
    server.close();
  }
});

test("ops-daily calls the protected operational endpoint and prints a compact report", async () => {
  let receivedToken = "";
  let receivedBody = null;
  const { server, apiBase } = await startServer((request, response) => {
    if (request.url === "/api/v1/ops/daily" && request.method === "POST") {
      receivedToken = request.headers["x-admin-token"] ?? "";
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            status: "collecting",
            source: "api",
            live_api_calls: 0,
            match_id: "match_atp_002",
            replay_contracts: {
              passed: true,
              scenarios: [
                {
                  scenario: "healthy",
                  passed: true,
                  final_status: "completed",
                  resync_required: false,
                },
              ],
            },
            paper_auto_settlement: {
              evaluated_orders: 2,
              settled_orders: 1,
              training_examples_ready: 1,
            },
            model_lab_backtest: {
              status: "skipped",
              model_version: "prematch_ensemble_v1",
              feature_set: "live_budget_v1",
              reason: "collecting",
            },
            execution: {
              can_submit_real_orders: false,
              real_execution_hard_block: true,
              stage: "paper",
            },
          })
        );
      });
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(
      [
        "ops-daily",
        `--api-base=${apiBase}`,
        "--token-stdin",
        "--match-id=match_atp_002",
        "--scenario=healthy",
        "--max-orders=2",
      ],
      { stdin: "local-admin" }
    );

    assert.equal(result.exit, 0);
    assert.equal(receivedToken, "local-admin");
    assert.deepEqual(receivedBody, {
      match_id: "match_atp_002",
      max_orders: 2,
      scenarios: ["healthy"],
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.live_api_calls, 0);
    assert.equal(payload.replay_passed, true);
    assert.equal(payload.paper_auto_settlement.training_examples_ready, 1);
    assert.equal(payload.execution.can_submit_real_orders, false);
  } finally {
    server.close();
  }
});

test("intelligence produces a safe operator packet from internal APIs only", async () => {
  const called = [];
  const fixtures = {
    "/api/v1/agent/briefing": {
      summary: "Hermes can monitor 2 matches.",
      autopilot_enabled: true,
      entry_signals: 1,
      provider_alerts: 0,
      readiness_status: "collecting",
    },
    "/api/v1/agent/preflight": {
      status: "ready",
      checks: [{ name: "real_execution_hard_block", status: "pass", summary: "blocked" }],
      generated_at: "2026-06-21T20:00:00Z",
    },
    "/api/v1/agent/anomalies": [],
    "/api/v1/provider-health": [
      { provider: "api_tennis", status: "healthy" },
      { provider: "odds_api_io", status: "healthy" },
    ],
    "/api/v1/provider-cursors": [],
    "/api/v1/data-quality": [],
    "/api/v1/cost-profile": {
      active_plan: "lean_atp",
      estimated_monthly_spend_usd: 377,
      monthly_budget_usd: 500,
    },
    "/api/v1/cost-report/daily": {
      live_api_calls: 3,
      cost_per_signal_usd: 0.25,
    },
    "/api/v1/paper/performance": {
      readiness_status: "collecting",
      roi: 0.02,
      clv: 0.01,
      settled_orders: 42,
    },
    "/api/v1/execution/status": {
      real_execution_hard_block: true,
      can_submit_real_orders: false,
      stage: "paper",
    },
    "/api/v1/bankroll": {
      balance: 10000,
      currency: "USD",
      open_exposure: 0,
      daily_pnl: 0,
      weekly_pnl: 0,
    },
    "/api/v1/signals/live": [
      { id: "sig_1", status: "Entrada" },
      { id: "sig_2", status: "Bloqueado" },
    ],
    "/api/v1/ingestion/runs": [
      {
        id: "ingest_1",
        run_type: "live_budget_cycle",
        source: "cli",
        status: "completed",
      },
    ],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        source_summary: { total_matches: 2, persisted_matches: 2 },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: { budget_chain_completed: true },
      },
    },
  };
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["intelligence", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.url === "/api/v1/agent/autopilot/evaluate"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "paper_autopilot_candidate");
    assert.equal(payload.safety.real_execution_hard_block, true);
    assert.equal(payload.safety.sportsbook_bypass_allowed, false);
    assert.equal(payload.signal_snapshot.entry_signals, 1);
    assert.deepEqual(payload.allowed_collection_paths, [
      "licensed_provider_api",
      "provider_websocket",
      "internal_fastapi_endpoint",
      "persisted_postgres_replay",
      "manual_operator_note",
    ]);
    assert.equal(payload.forbidden_collection_paths.includes("anti_bot_bypass"), true);
  } finally {
    server.close();
  }
});

test("events routes clean Entrada state to paper autopilot only", async () => {
  const called = [];
  const fixtures = eventRouterFixtures();
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["events", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.url === "/api/v1/agent/autopilot/evaluate"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.source_mode, "paper_autopilot_candidate");
    assert.equal(payload.can_run_paper_autopilot, true);
    const paperEvent = payload.events.find((event) => event.type === "paper_autopilot_candidate");
    assert.equal(paperEvent.allowed_command, "npm run hermes:autopilot");
    assert.equal(paperEvent.requires_admin_token, true);
    assert.equal(paperEvent.can_create_orders, true);
    assert.equal(paperEvent.can_submit_real_orders, false);
    assert.equal(payload.safety.sportsbook_bypass_allowed, false);
    assert.equal(payload.forbidden_actions.includes("credential_or_session_extraction"), true);
  } finally {
    server.close();
  }
});

test("events blocks paper autopilot when provider cursor requires resync", async () => {
  const fixtures = eventRouterFixtures({
    "/api/v1/provider-cursors": [
      {
        provider: "odds_api_io",
        stream: "tennis:h2h",
        status: "gap",
        last_seq: 10,
        expected_next_seq: 11,
        gap_count: 1,
        resync_required: true,
        note: "missing seq 11",
      },
    ],
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["events", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.source_mode, "investigate");
    assert.equal(payload.can_run_paper_autopilot, false);
    assert.equal(payload.events.some((event) => event.type === "cursor_resync_required"), true);
    assert.equal(payload.events.some((event) => event.can_create_orders), false);
    assert.equal(payload.recommended_commands.includes("npm run api:check:operational-truth -- --pretty"), true);
  } finally {
    server.close();
  }
});

test("events ignore deferred enterprise cursor while budget chain is not enterprise eligible", async () => {
  const fixtures = eventRouterFixtures({
    "/api/v1/signals/live": [],
    "/api/v1/provider-cursors": [
      {
        provider: "sportradar",
        stream: "tennis:score",
        status: "resync_required",
        last_seq: null,
        expected_next_seq: null,
        gap_count: 0,
        resync_required: true,
        note: "Enterprise score cursor waits for Sportradar contract payload validation.",
      },
    ],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        source_summary: { total_matches: 2, persisted_matches: 2 },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: false,
          enterprise_eligible: false,
          current_step: "1. theoddsapi:archive_odds",
          steps: [],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["events", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.source_mode, "budget_chain_buildout");
    assert.equal(payload.events.some((event) => event.type === "cursor_resync_required"), false);
    assert.equal(payload.events.some((event) => event.type === "budget_chain_next_step"), true);
    assert.equal(payload.can_run_paper_autopilot, false);
  } finally {
    server.close();
  }
});

test("unblock-plan classifies blockers into safe prioritized operator lanes", async () => {
  const fixtures = eventRouterFixtures({
    "/api/v1/agent/preflight": {
      status: "blocked",
      checks: [
        {
          name: "hermes_gateway",
          status: "fail",
          summary: "Hermes loopback gateway is not reachable.",
        },
        {
          name: "real_execution_hard_block",
          status: "pass",
          summary: "blocked",
        },
      ],
      generated_at: "2026-06-21T20:00:00Z",
    },
    "/api/v1/provider-health": [
      {
        provider: "api_tennis",
        configured: false,
        healthy: false,
        status: "score primary key missing",
      },
      {
        provider: "odds_api_io",
        configured: false,
        healthy: false,
        status: "odds websocket key missing",
      },
      {
        provider: "theoddsapi",
        configured: true,
        healthy: false,
        status: "historical archive configured; stale persisted feed: odds/archive",
      },
    ],
    "/api/v1/provider-cursors": [
      {
        provider: "sportradar",
        stream: "tennis:score",
        status: "resync_required",
        resync_required: true,
        note: "Enterprise score cursor waits for contract validation.",
      },
    ],
    "/api/v1/data-quality": [
      {
        id: "dq_persisted_live_budget",
        provider: "api_tennis",
        feed: "persisted/live-budget",
        sequence_health: 0.35,
        stale_ticks: 7,
        blocked_signals: 8,
      },
    ],
    "/api/v1/signals/live": [],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        source_summary: { total_matches: 2, persisted_matches: 2 },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: false,
          enterprise_eligible: false,
          current_step: "1. theoddsapi:archive_odds",
          steps: [
            {
              order: 1,
              provider: "theoddsapi",
              capability: "archive_odds",
              status: "configured",
              configured: true,
              current: true,
              smoke_completed: false,
              required_before_enable: [],
              next_action: "Run TheOddsAPI archive-sync smoke and confirm persisted payload evidence.",
              notes: [],
            },
          ],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["unblock-plan", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "unblock_plan");
    assert.equal(payload.can_run_paper_autopilot, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.lanes[0].id, "local_runtime");
    assert.equal(payload.lanes.some((lane) => lane.id === "provider_smoke" && lane.command === "npm run hermes:provider-smoke"), true);
    assert.equal(payload.lanes.some((lane) => lane.id === "provider_credentials" && lane.requires_human), true);
    assert.equal(payload.lanes.some((lane) => lane.id === "data_quality" && lane.command.includes("api:check:operational-truth")), true);
    assert.equal(payload.lanes.some((lane) => lane.id === "enterprise_deferred" && lane.status === "deferred"), true);
    assert.equal(payload.next_best_action.command, "hermes status && hermes doctor");
    assert.equal(payload.safety.forbidden_actions.includes("sportsbook_ui_automation"), true);
  } finally {
    server.close();
  }
});

test("runtime-check captures Hermes local diagnostics without failing protected flow", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-hermes-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: stopped sk-p...sq0A'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );

  const result = await runCli(["runtime-check"], {
    env: { HERMES_BIN: fakeHermes },
  });

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "local_runtime_check");
  assert.equal(payload.status, "degraded");
  assert.equal(payload.read_only, true);
  assert.equal(payload.writes, false);
  assert.equal(payload.provider_api_call_allowed, false);
  assert.equal(payload.can_submit_real_orders, false);
  assert.equal(payload.commands.length, 2);
  assert.equal(payload.commands[0].name, "hermes status");
  assert.equal(payload.commands[0].exit_code, 0);
  assert.match(payload.commands[0].stdout, /gateway: stopped/);
  assert.equal(payload.commands[0].stdout.includes("sk-p"), false);
  assert.match(payload.commands[0].stdout, /\[REDACTED_API_KEY\]/);
  assert.equal(payload.commands[1].name, "hermes doctor");
  assert.equal(payload.commands[1].exit_code, 1);
  assert.match(payload.commands[1].stderr, /gateway unreachable/);
  assert.equal(payload.runtime_findings.gateway_service_status, "stopped");
  assert.equal(payload.runtime_findings.doctor_status, "failed");
  assert.equal(payload.runtime_findings.blockers.includes("gateway_service_stopped"), true);
  assert.equal(payload.runtime_findings.blockers.includes("doctor_failed"), true);
  assert.equal(payload.diagnostic_actions[0].id, "start_gateway_manual_review");
  assert.equal(payload.diagnostic_actions[0].executes_now, false);
  assert.equal(payload.diagnostic_actions[0].writes, false);
  assert.equal(payload.diagnostic_actions[0].command, "hermes gateway start");
  assert.equal(payload.diagnostic_actions.some((action) => action.command.includes("launchctl kickstart")), false);
});

test("doctor-triage classifies a bounded doctor timeout without mutating runtime", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-doctor-triage-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === '--version') { console.log('hermes 1.2.3'); process.exit(0); }",
      "else if (process.argv[2] === 'status') { console.log('Gateway Service\\n  Status:       ✓ running\\nAuth\\n  OpenAI        ✓ configured'); process.exit(0); }",
      "else if (process.argv[2] === 'doctor') { console.log('checking ' + 's' + 'k-testsecret'); setTimeout(() => {}, 10000); }",
      "else { process.exit(2); }",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );

  const result = await runCli(["doctor-triage"], {
    env: {
      HERMES_BIN: fakeHermes,
      HERMES_DOCTOR_TRIAGE_TIMEOUT_MS: "100",
    },
    timeoutMs: 8_000,
  });

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "doctor_triage");
  assert.equal(payload.status, "blocked");
  assert.equal(payload.read_only, true);
  assert.equal(payload.writes, false);
  assert.equal(payload.provider_api_call_allowed, false);
  assert.equal(payload.can_submit_real_orders, false);
  assert.equal(payload.can_create_paper_orders, false);
  assert.equal(payload.llm_per_tick_allowed, false);
  assert.equal(payload.doctor_timeout_ms, 100);
  assert.equal(payload.runtime_findings.gateway_service_status, "running");
  assert.equal(payload.runtime_findings.doctor_status, "timed_out");
  assert.equal(payload.likely_cause, "doctor_timeout_with_gateway_running");
  const doctorSummary = payload.command_summary.find((item) => item.name === "hermes doctor short");
  assert.equal(doctorSummary.timed_out, true);
  assert.equal(JSON.stringify(payload).includes(["s", "k-testsecret"].join("")), false);
  assert.equal(JSON.stringify(payload).includes("[REDACTED_API_KEY]"), true);
  assert.equal(payload.next_safe_actions[0].id, "bounded_doctor_recheck");
  assert.equal(payload.next_safe_actions.every((action) => action.executes_now === false), true);
  assert.equal(payload.safety.secret_value_printed, false);
  assert.equal(payload.safety.browser_sportsbook_automation_allowed, false);
});

test("doctor-triage escalates persistent gateway-running timeouts without looping", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-doctor-persistent-timeout-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === '--version') { console.log('Hermes Agent v0.17.0\\nUpdate available: 216 commits behind'); process.exit(0); }",
      "else if (process.argv[2] === 'status') { console.log('Gateway Service\\n  Status:       ✓ running\\nAuth\\n  OpenAI        ✓ configured'); process.exit(0); }",
      "else if (process.argv[2] === 'doctor') { console.log('◆ API Connectivity\\n  Running 26 connectivity checks in parallel...'); setTimeout(() => {}, 10000); }",
      "else { process.exit(2); }",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );

  const result = await runCli(["doctor-triage"], {
    env: {
      HERMES_BIN: fakeHermes,
      HERMES_DOCTOR_TRIAGE_TIMEOUT_MS: "5000",
    },
    timeoutMs: 8_000,
  });

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "doctor_triage");
  assert.equal(payload.status, "blocked");
  assert.equal(payload.read_only, true);
  assert.equal(payload.writes, false);
  assert.equal(payload.provider_api_call_allowed, false);
  assert.equal(payload.can_submit_real_orders, false);
  assert.equal(payload.can_create_paper_orders, false);
  assert.equal(payload.doctor_timeout_ms, 5000);
  assert.equal(payload.runtime_findings.gateway_service_status, "running");
  assert.equal(payload.runtime_findings.doctor_status, "timed_out");
  assert.equal(payload.runtime_findings.doctor_progress.reached_api_connectivity, true);
  assert.equal(payload.runtime_findings.doctor_progress.connectivity_checks_count, 26);
  assert.equal(payload.runtime_findings.doctor_progress.last_section, "API Connectivity");
  assert.equal(payload.likely_cause, "persistent_doctor_api_connectivity_timeout");
  assert.equal(payload.next_safe_actions[0].id, "api_connectivity_timeout_review");
  assert.equal(payload.next_safe_actions.some((action) => action.id === "bounded_doctor_recheck"), false);
  assert.equal(payload.next_safe_actions.some((action) => (
    action.id === "manual_hermes_update_review"
      && action.command === "hermes update"
      && action.executes_now === false
      && action.mutates_runtime_if_run === true
      && action.requires_operator_confirmation === true
  )), true);
  assert.equal(payload.next_safe_actions.every((action) => action.executes_now === false), true);
  assert.equal(payload.safety.secret_value_printed, false);
});

test("channel-readiness blocks channel activation without mutating runtime", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-channel-readiness-blocked-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('Gateway Service\\n  Status:       ✗ stopped\\nMessaging Platforms\\n  Telegram      ✗ not configured'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { setTimeout(() => {}, 10000); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );

  const result = await runCli(["channel-readiness"], {
    env: {
      HERMES_BIN: fakeHermes,
      HERMES_TELEGRAM_ALLOWED_USER_IDS: "",
      OPENCLAW_TELEGRAM_ALLOWED_USER_IDS: "",
      PRIVATE_ALLOWED_EMAILS: "",
      TENNIS_EDGE_PRIVATE_ALLOWED_EMAILS: "",
      ADMIN_API_TOKEN: "",
      TENNIS_EDGE_ADMIN_API_TOKEN: "",
    },
  });

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "channel_readiness");
  assert.equal(payload.status, "blocked");
  assert.equal(payload.readiness_ceiling, "observe");
  assert.equal(payload.read_only, true);
  assert.equal(payload.writes, false);
  assert.equal(payload.provider_api_call_allowed, false);
  assert.equal(payload.can_submit_real_orders, false);
  assert.equal(payload.can_create_paper_orders, false);
  assert.equal(payload.llm_per_tick_allowed, false);
  const checks = Object.fromEntries(payload.checks.map((check) => [check.id, check]));
  assert.equal(checks.gateway_service_running.status, "fail");
  assert.equal(checks.doctor_passed.status, "fail");
  assert.equal(checks.telegram_allowlist_configured.status, "fail");
  assert.equal(payload.next_action.id, "start_gateway_manual_review");
  assert.equal(payload.next_action.executes_now, false);
  assert.equal(payload.next_action.mutates_runtime_if_run, true);
  assert.equal(payload.actions.some((action) => action.id === "configure_local_admin_token"), true);
});

test("channel-readiness proves channel_ready only when runtime and local allowlists pass", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-channel-readiness-ready-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('Gateway Service\\n  Status:       ✓ running\\nMessaging Platforms\\n  Telegram      ✓ configured'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.log('doctor ok'); process.exit(0); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );

  const result = await runCli(["channel-readiness"], {
    env: {
      HERMES_BIN: fakeHermes,
      HERMES_TELEGRAM_ALLOWED_USER_IDS: "123456789",
      PRIVATE_ALLOWED_EMAILS: "operator@example.com",
      ADMIN_API_TOKEN: "local-admin",
    },
  });

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "channel_readiness");
  assert.equal(payload.status, "ready");
  assert.equal(payload.readiness_ceiling, "channel_ready");
  assert.equal(payload.checks.every((check) => check.status === "pass"), true);
  assert.equal(payload.next_action.command, "npm run hermes:activation-checklist");
  assert.equal(payload.next_action.executes_now, false);
  assert.equal(payload.safety.real_execution_hard_block, true);
  assert.equal(payload.safety.can_submit_real_orders, false);
  assert.equal(payload.safety.provider_api_call_allowed, false);
});

test("channel-recovery-plan summarizes local-only recovery gates without exposing secrets", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-channel-recovery-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('Gateway Service\\n  Status:       ✓ running\\nMessaging Platforms\\n  Telegram      ✗ not configured'); process.exit(0); }",
      "else if (process.argv[2] === 'doctor') { setTimeout(() => {}, 10000); }",
      "else { process.exit(2); }",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );

  const result = await runCli(["channel-recovery-plan"], {
    env: {
      HERMES_BIN: fakeHermes,
      HERMES_HTTP_TIMEOUT_MS: "100",
      HERMES_TELEGRAM_ALLOWED_USER_IDS: "",
      OPENCLAW_TELEGRAM_ALLOWED_USER_IDS: "",
      PRIVATE_ALLOWED_EMAILS: "",
      TENNIS_EDGE_PRIVATE_ALLOWED_EMAILS: "",
      ADMIN_API_TOKEN: "",
      TENNIS_EDGE_ADMIN_API_TOKEN: "",
    },
    timeoutMs: 8_000,
  });

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "channel_recovery_plan");
  assert.equal(payload.status, "blocked");
  assert.equal(payload.read_only, true);
  assert.equal(payload.writes, false);
  assert.equal(payload.provider_api_call_allowed, false);
  assert.equal(payload.can_submit_real_orders, false);
  assert.equal(payload.can_create_paper_orders, false);
  assert.equal(payload.llm_per_tick_allowed, false);
  assert.equal(payload.runtime.status, "degraded");
  assert.equal(payload.runtime.gateway_service_status, "running");
  assert.equal(payload.runtime.doctor_status, "timed_out");
  assert.equal(payload.failed_check_ids.includes("doctor_passed"), true);
  assert.equal(payload.failed_check_ids.includes("telegram_allowlist_configured"), true);
  assert.equal(payload.failed_check_ids.includes("private_access_allowlist_configured"), true);
  assert.equal(payload.failed_check_ids.includes("local_admin_secret_available"), true);
  const envById = Object.fromEntries(payload.local_env_requirements.map((item) => [item.id, item]));
  assert.deepEqual(envById.telegram_allowlist.names, [
    "HERMES_TELEGRAM_ALLOWED_USER_IDS",
    "OPENCLAW_TELEGRAM_ALLOWED_USER_IDS",
  ]);
  assert.equal(envById.telegram_allowlist.configured, false);
  assert.equal(envById.local_admin_token.secret_value_printed, false);
  assert.equal(JSON.stringify(payload).includes("local-admin"), false);
  assert.equal(payload.verification_commands.includes("npm run hermes:runtime-check"), true);
  assert.equal(payload.verification_commands.includes("npm run hermes:channel-readiness"), true);
  assert.equal(payload.verification_commands.includes("npm run hermes:activation-checklist"), true);
  assert.equal(payload.next_human_steps.some((step) => step.includes("Configure HERMES_TELEGRAM_ALLOWED_USER_IDS")), true);
  assert.equal(payload.safety.browser_sportsbook_automation_allowed, false);
});

test("backend-readiness proves internal API endpoints without protected actions", async () => {
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        source_summary: { total_matches: 2, persisted_matches: 2 },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: false,
          enterprise_eligible: false,
          current_step: "1. theoddsapi:archive_odds",
          steps: [],
          warnings: [],
        },
      },
    },
    "/api/v1/live/matches": [
      { match_id: "match_1", status: "live" },
      { match_id: "match_2", status: "scheduled" },
    ],
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["backend-readiness", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.method === "POST"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "backend_readiness");
    assert.equal(payload.status, "ready");
    assert.equal(payload.read_only, true);
    assert.equal(payload.writes, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.request_errors.length, 0);
    assert.equal(payload.checks.every((check) => check.status === "pass"), true);
    assert.equal(payload.endpoint_summary.live_match_count, 2);
    assert.equal(payload.endpoint_summary.provider_mode, "replay");
    assert.equal(payload.next_action.command, "npm --silent run hermes:live-window");
    assert.equal(payload.next_action.executes_now, false);
    assert.equal(payload.safety.real_execution_hard_block, true);
  } finally {
    server.close();
  }
});

test("backend-readiness fails closed when FastAPI hangs", async () => {
  const called = [];
  const { server, apiBase } = await startServer((request) => {
    called.push({ url: request.url, method: request.method });
  });

  try {
    const result = await runCli(["backend-readiness", `--api-base=${apiBase}`], {
      env: {
        HERMES_HTTP_TIMEOUT_MS: "100",
      },
      timeoutMs: 5_000,
    });

    assert.equal(result.exit, 0);
    assert.equal(called.some((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.method === "POST"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "backend_readiness");
    assert.equal(payload.status, "blocked");
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.request_errors.length >= 1, true);
    const checks = Object.fromEntries(payload.checks.map((check) => [check.id, check]));
    assert.equal(checks.internal_api_reachable.status, "fail");
    assert.equal(checks.real_execution_hard_block.status, "pass");
    assert.equal(payload.next_action.command, "npm run api:dev");
    assert.equal(payload.next_action.executes_now, false);
    assert.equal(payload.next_action.mutates_runtime_if_run, true);
    assert.equal(payload.actions.some((action) => action.command.includes("api:check:operational-truth")), true);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("backend-readiness routes partial endpoint timeouts to latency triage", async () => {
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/live/matches": [
      { match_id: "match_1", status: "live" },
    ],
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    if (request.url === "/api/v1/dashboard/live-state") {
      return;
    }
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["backend-readiness", `--api-base=${apiBase}`], {
      env: {
        HERMES_HTTP_TIMEOUT_MS: "100",
      },
      timeoutMs: 5_000,
    });

    assert.equal(result.exit, 0);
    assert.equal(called.some((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.method === "POST"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "backend_readiness");
    assert.equal(payload.status, "blocked");
    assert.equal(payload.request_errors.some((error) => error.label === "dashboard_state"), true);
    assert.equal(payload.next_action.command, "npm run hermes:backend-latency-triage");
    assert.equal(payload.next_action.mutates_runtime_if_run, false);
    assert.equal(payload.next_action.requires_operator_confirmation, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("backend-latency-triage measures partial endpoint latency without payload bodies", async () => {
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/live/matches": [
      { match_id: "match_1", status: "live", secret_field: "do-not-print" },
    ],
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    if (request.url === "/api/v1/dashboard/live-state") {
      return;
    }
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["backend-latency-triage", `--api-base=${apiBase}`], {
      env: {
        HERMES_BACKEND_TRIAGE_TIMEOUT_MS: "100",
      },
      timeoutMs: 5_000,
    });

    assert.equal(result.exit, 0);
    assert.equal(called.some((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.method === "POST"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "backend_latency_triage");
    assert.equal(payload.status, "degraded");
    assert.equal(payload.read_only, true);
    assert.equal(payload.writes, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.timeout_ms, 100);
    assert.equal(payload.likely_cause, "partial_endpoint_latency_or_contention");
    assert.equal(payload.failed_count >= 1, true);
    assert.equal(payload.passed_count >= 1, true);
    assert.equal(payload.probes.some((probe) => probe.label === "dashboard_state" && probe.timed_out), true);
    assert.equal(payload.next_safe_actions[0].command, "HERMES_BACKEND_TRIAGE_TIMEOUT_MS=10000 npm run hermes:backend-latency-triage");
    assert.equal(payload.safety.payload_body_printed, false);
    assert.equal(JSON.stringify(payload).includes("do-not-print"), false);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("mission-control prioritizes backend restore when internal API hangs", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-mission-control-backend-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('Gateway Service\\n  Status:       ✓ running'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.log('doctor ok'); process.exit(0); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const { server, apiBase } = await startServer((request) => {
    called.push({ url: request.url, method: request.method });
  });

  try {
    const result = await runCli(["mission-control", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_HTTP_TIMEOUT_MS: "100",
        HERMES_TELEGRAM_ALLOWED_USER_IDS: "123456789",
        PRIVATE_ALLOWED_EMAILS: "operator@example.com",
        ADMIN_API_TOKEN: "local-admin",
      },
      timeoutMs: 8_000,
    });

    assert.equal(result.exit, 0);
    assert.equal(called.some((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.method === "POST"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "mission_control");
    assert.equal(payload.status, "blocked");
    assert.equal(payload.read_only, true);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.next_action.lane, "backend");
    assert.equal(payload.next_action.command, "npm run api:dev");
    assert.equal(payload.next_action.executes_now, false);
    assert.equal(payload.next_action.mutates_runtime_if_run, true);
    assert.equal(payload.packets.backend_readiness.status, "blocked");
    assert.equal(payload.safety.browser_sportsbook_automation_allowed, false);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("mission-control prioritizes Hermes channel before live-window routes", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-mission-control-channel-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('Gateway Service\\n  Status:       ✗ stopped\\nMessaging Platforms\\n  Telegram      ✗ not configured'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/live/matches": [
      { match_id: "match_1", status: "live" },
    ],
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["mission-control", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
      },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "mission_control");
    assert.equal(payload.status, "blocked");
    assert.equal(payload.active_ceiling, "observe");
    assert.equal(payload.next_action.lane, "channel");
    assert.equal(payload.next_action.command, "hermes gateway start");
    assert.equal(payload.next_action.executes_now, false);
    assert.equal(payload.next_action.mutates_runtime_if_run, true);
    assert.equal(payload.packets.backend_readiness.status, "ready");
    assert.equal(payload.packets.channel_readiness.status, "blocked");
    assert.equal(payload.packets.source_routes.next_route, "replay_backfill");
    assert.equal(payload.lanes.every((lane) => lane.can_submit_real_orders === false), true);
    assert.equal(payload.safe_jailbreak_policy.bypass_allowed, false);
  } finally {
    server.close();
  }
});

test("mission-ledger appends mission-control decisions without executing actions", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-mission-ledger-"));
  const ledgerPath = join(tempDir, "mission-ledger.jsonl");
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('Gateway Service\\n  Status:       ✗ stopped\\nMessaging Platforms\\n  Telegram      ✗ not configured'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/live/matches": [
      { match_id: "match_1", status: "live" },
    ],
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["mission-ledger", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_MISSION_LEDGER_PATH: ledgerPath,
      },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.method === "POST"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "mission_ledger");
    assert.equal(payload.status, "blocked");
    assert.equal(payload.writes, true);
    assert.equal(payload.write_scope, "local_mission_jsonl_only");
    assert.equal(payload.executed_commands.length, 0);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.ledger.path, ledgerPath);
    assert.equal(payload.record.mission.mode, "mission_control");
    assert.equal(payload.record.next_action_lane, "channel");
    assert.equal(payload.record.next_action_command, "hermes gateway start");
    assert.deepEqual(payload.record.blocked_lane_ids, ["channel", "live_window"]);
    assert.equal(payload.record.action_executed, false);
    assert.equal(payload.record.mission_command_executed, false);
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const audit = JSON.parse(lines[0]);
    assert.equal(audit.mode, "mission_ledger_record");
    assert.equal(audit.next_action_lane, "channel");
    assert.equal(audit.mission_command_executed, false);
    assert.equal(audit.action_executed, false);
  } finally {
    server.close();
  }
});

test("mission-ledger-report summarizes repeated mission blockers", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-mission-ledger-report-"));
  const ledgerPath = join(tempDir, "mission-ledger.jsonl");
  const rows = [
    {
      generated_at: "2026-06-21T20:00:00Z",
      mode: "mission_ledger_record",
      status: "blocked",
      active_ceiling: "observe",
      outcome: "observed",
      action_executed: false,
      mission_command_executed: false,
      next_action_lane: "channel",
      next_action_command: "hermes gateway start",
      blocked_lane_ids: ["channel", "live_window"],
      mission: { status: "blocked" },
    },
    {
      generated_at: "2026-06-21T20:05:00Z",
      mode: "mission_ledger_record",
      status: "blocked",
      active_ceiling: "observe",
      outcome: "observed",
      action_executed: false,
      mission_command_executed: false,
      next_action_lane: "channel",
      next_action_command: "hermes gateway start",
      blocked_lane_ids: ["channel"],
      mission: { status: "blocked" },
    },
    {
      generated_at: "2026-06-21T20:10:00Z",
      mode: "mission_ledger_record",
      status: "ready",
      active_ceiling: "channel_ready",
      outcome: "observed",
      action_executed: false,
      mission_command_executed: false,
      next_action_lane: "live_window",
      next_action_command: "npm --silent run hermes:live-window",
      blocked_lane_ids: ["live_window"],
      mission: { status: "ready" },
    },
  ];
  writeFileSync(ledgerPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = await runCli(["mission-ledger-report"], {
    env: { HERMES_MISSION_LEDGER_PATH: ledgerPath },
  });

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "mission_ledger_report");
  assert.equal(payload.read_only, true);
  assert.equal(payload.writes, false);
  assert.equal(payload.provider_api_call_allowed, false);
  assert.equal(payload.can_submit_real_orders, false);
  assert.equal(payload.can_create_paper_orders, false);
  assert.equal(payload.ledger.path, ledgerPath);
  assert.equal(payload.total_records, 3);
  assert.equal(payload.action_executed_count, 0);
  assert.equal(payload.mission_command_executed_count, 0);
  assert.equal(payload.status_counts.blocked, 2);
  assert.equal(payload.active_ceiling_counts.observe, 2);
  assert.equal(payload.next_lane_counts.channel, 2);
  assert.equal(payload.blocked_lane_counts.channel, 2);
  assert.equal(payload.top_next_action, "hermes gateway start");
  assert.equal(payload.next_action_counts[0].count, 2);
});

test("safe-loop aggregates runtime and budget signals without protected actions", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-hermes-loop-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: stopped'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/agent/preflight": {
      status: "blocked",
      checks: [
        {
          name: "hermes_gateway",
          status: "fail",
          summary: "Hermes loopback gateway is not reachable.",
        },
        {
          name: "real_execution_hard_block",
          status: "pass",
          summary: "blocked",
        },
      ],
      generated_at: "2026-06-21T20:00:00Z",
    },
    "/api/v1/signals/live": [],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        source_summary: { total_matches: 2, persisted_matches: 2 },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: false,
          enterprise_eligible: false,
          current_step: "1. theoddsapi:archive_odds",
          steps: [
            {
              order: 1,
              provider: "theoddsapi",
              capability: "archive_odds",
              status: "ready_next",
              configured: true,
              current: true,
              smoke_completed: false,
              required_before_enable: [],
              next_action: "Run TheOddsAPI archive-sync smoke and confirm persisted payload evidence.",
              notes: [],
            },
          ],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["safe-loop", `--api-base=${apiBase}`], {
      env: { HERMES_BIN: fakeHermes },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.url === "/api/v1/agent/autopilot/evaluate"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "safe_loop");
    assert.equal(payload.runtime.status, "degraded");
    assert.equal(payload.active_phase, "stabilize_data");
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.quota_plan.status, "blocked");
    assert.equal(payload.quota_plan.throttle_level, "blocked");
    assert.equal(payload.quota_plan.provider_api_call_allowed, false);
    assert.equal(payload.quota_plan.provider_command_count, 0);
    assert.equal(payload.next_best_command.command, "npm run hermes:runtime-check");
    assert.equal(payload.safe_commands.some((command) => command.command === "npm --silent run hermes:quota-plan"), true);
    assert.equal(payload.safe_commands.some((command) => command.command === "npm run hermes:provider-smoke"), true);
    assert.equal(payload.forbidden_actions.includes("sportsbook_ui_automation"), true);
  } finally {
    server.close();
  }
});

test("autonomy-brief consolidates safe Hermes operating decisions without executing actions", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-autonomy-brief-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  const ledgerPath = join(tempDir, "operator-ledger.jsonl");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: stopped'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  writeFileSync(
    ledgerPath,
    `${JSON.stringify({
      mode: "operator_ledger_record",
      outcome: "observed",
      action_executed: false,
      next_action_command: "npm run hermes:runtime-check",
      packet: { priority: "high", status: "runtime_degraded", cost_guard: { throttle_level: "blocked" } },
    })}\n`
  );
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/agent/preflight": {
      status: "blocked",
      checks: [
        { name: "hermes_gateway", status: "fail", summary: "Hermes loopback gateway is not reachable." },
        { name: "real_execution_hard_block", status: "pass", summary: "blocked" },
      ],
      generated_at: "2026-06-21T20:00:00Z",
    },
    "/api/v1/signals/live": [],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        source_summary: {
          total_matches: 1,
          persisted_matches: 1,
          match_freshness: [
            {
              match_id: "match_1",
              source: "replay",
              persisted: true,
              score_age_ms: 90000,
              odds_age_ms: 120000,
            },
          ],
        },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: false,
          enterprise_eligible: false,
          current_step: "1. theoddsapi:archive_odds",
          steps: [
            {
              order: 1,
              provider: "theoddsapi",
              capability: "archive_odds",
              status: "ready_next",
              configured: true,
              current: true,
              smoke_completed: false,
              required_before_enable: [],
              next_action: "Run TheOddsAPI archive-sync smoke and confirm persisted payload evidence.",
              notes: [],
            },
          ],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["autonomy-brief", `--api-base=${apiBase}`], {
      env: { HERMES_BIN: fakeHermes, HERMES_OPERATOR_LEDGER_PATH: ledgerPath },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.url === "/api/v1/agent/autopilot/evaluate"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "autonomy_brief");
    assert.equal(payload.status, "runtime_degraded");
    assert.equal(payload.read_only, true);
    assert.equal(payload.writes, false);
    assert.equal(payload.live_api_calls, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.recommended_lane.id, "stabilize_runtime");
    assert.equal(payload.autonomy_matrix.collect.status, "frozen");
    assert.equal(payload.autonomy_matrix.process.status, "replay_only");
    assert.equal(payload.autonomy_matrix.live_statistics.llm_per_tick_allowed, false);
    assert.equal(payload.autonomy_matrix.paper_autopilot.status, "blocked");
    assert.equal(payload.action_queue[0].command, "npm run hermes:runtime-check");
    assert.equal(payload.action_queue[0].executes_now, false);
    assert.equal(payload.action_queue.every((item) => item.can_submit_real_orders === false), true);
    assert.equal(payload.safe_jailbreak_paths.includes("persisted_postgres_replay"), true);
    assert.equal(payload.forbidden_actions.includes("anti_bot_bypass"), true);
    assert.equal(payload.research_principles.some((item) => item.id === "event_driven_wakeups"), true);
  } finally {
    server.close();
  }
});

test("source-discovery maps safe data acquisition paths without bypasses or live calls", async () => {
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/provider-health": [
      { provider: "api_tennis", status: "healthy", cost_tier: "budget" },
      { provider: "odds_api_io", status: "degraded", cost_tier: "budget" },
      { provider: "theoddsapi", status: "healthy", cost_tier: "budget" },
    ],
    "/api/v1/provider-cursors": [
      {
        provider: "odds_api_io",
        stream: "tennis:moneyline",
        resync_required: true,
        last_seq: 10,
        last_seen_at: "2026-06-21T20:00:00Z",
      },
    ],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        source_summary: {
          total_matches: 2,
          persisted_matches: 2,
          match_freshness: [
            { match_id: "match_1", source: "replay", persisted: true, score_age_ms: 90000, odds_age_ms: 120000 },
            { match_id: "match_2", source: "persisted_fallback", persisted: true, score_age_ms: 30000, odds_age_ms: 45000 },
          ],
        },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: false,
          enterprise_eligible: false,
          current_step: "1. theoddsapi:archive_odds",
          steps: [
            {
              order: 1,
              provider: "theoddsapi",
              capability: "archive_odds",
              status: "ready_next",
              configured: true,
              current: true,
              smoke_completed: false,
              required_before_enable: [],
              next_action: "Run archive smoke manually.",
              notes: [],
            },
          ],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["source-discovery", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.url === "/api/v1/agent/autopilot/evaluate"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "source_discovery");
    assert.equal(payload.read_only, true);
    assert.equal(payload.live_api_calls, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.source_mode, "investigate");
    assert.equal(payload.discovery_scope.includes("score_state"), true);
    assert.equal(payload.acquisition_matrix.score_state.primary_path, "licensed_provider_api");
    assert.equal(payload.acquisition_matrix.odds_live.status, "blocked");
    assert.equal(payload.acquisition_matrix.odds_live.blockers.includes("cursor_resync_required"), true);
    assert.equal(payload.acquisition_matrix.replay_backfill.primary_path, "persisted_postgres_replay");
    assert.equal(payload.acquisition_matrix.public_context.primary_path, "public_allowed_research");
    assert.equal(payload.acquisition_matrix.operator_notes.primary_path, "manual_operator_note");
    assert.equal(payload.provider_routes.some((route) => route.provider === "theoddsapi"), true);
    assert.equal(payload.next_safe_command.command, "npm --silent run hermes:budget-chain");
    assert.equal(payload.forbidden_actions.includes("credential_or_session_extraction"), true);
    assert.equal(payload.forbidden_actions.includes("sportsbook_ui_automation"), true);
    assert.equal(payload.safe_jailbreak_policy.bypass_allowed, false);
  } finally {
    server.close();
  }
});

test("source-route-matrix ranks allowed routes without provider spend or bypass", async () => {
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/provider-health": [
      { provider: "api_tennis", status: "healthy", cost_tier: "budget" },
      { provider: "odds_api_io", status: "degraded", cost_tier: "budget" },
      { provider: "theoddsapi", status: "healthy", cost_tier: "budget" },
    ],
    "/api/v1/provider-cursors": [
      {
        provider: "odds_api_io",
        stream: "tennis:moneyline",
        resync_required: true,
        last_seq: 10,
        last_seen_at: "2026-06-21T20:00:00Z",
      },
    ],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        source_summary: {
          total_matches: 2,
          persisted_matches: 2,
          match_freshness: [
            { match_id: "match_1", source: "replay", persisted: true, score_age_ms: 90000, odds_age_ms: 120000 },
            { match_id: "match_2", source: "persisted_fallback", persisted: true, score_age_ms: 30000, odds_age_ms: 45000 },
          ],
        },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: false,
          enterprise_eligible: false,
          current_step: "1. theoddsapi:archive_odds",
          steps: [
            {
              order: 1,
              provider: "theoddsapi",
              capability: "archive_odds",
              status: "ready_next",
              configured: true,
              current: true,
              smoke_completed: false,
              required_before_enable: [],
              next_action: "Run archive smoke manually.",
              notes: [],
            },
          ],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["source-route-matrix", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.method === "POST"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "source_route_matrix");
    assert.equal(payload.read_only, true);
    assert.equal(payload.writes, false);
    assert.equal(payload.live_api_calls, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.objective.includes("without_bypass"), true);
    assert.equal(payload.next_route.id, "replay_backfill");
    assert.equal(payload.routes[0].id, "replay_backfill");
    assert.equal(payload.routes[0].status, "ready_now");
    const byId = Object.fromEntries(payload.routes.map((route) => [route.id, route]));
    assert.equal(byId.odds_live_websocket.status, "blocked");
    assert.equal(byId.odds_live_websocket.blocked_when.includes("cursor_resync_required"), true);
    assert.equal(byId.odds_live_websocket.provider_api_call_allowed, false);
    assert.equal(byId.odds_archive_budget_smoke.status, "operator_ready");
    assert.equal(byId.odds_archive_budget_smoke.operator_required, true);
    assert.equal(byId.live_statistics.llm_per_tick_allowed, false);
    assert.equal(byId.public_context_operator_note.blocked_when.includes("paywall"), true);
    assert.equal(payload.event_policy.wake_on_events_not_ticks, true);
    assert.equal(payload.event_policy.blocked_triggers.includes("llm_per_odds_tick"), true);
    assert.equal(payload.safe_jailbreak_policy.bypass_allowed, false);
    assert.equal(payload.safety.browser_sportsbook_automation_allowed, false);
  } finally {
    server.close();
  }
});

test("trigger-policy emits event wakeups without executing commands or live calls", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-trigger-policy-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: stopped'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/agent/preflight": {
      status: "blocked",
      checks: [
        { name: "hermes_gateway", status: "fail", summary: "Hermes loopback gateway is not reachable." },
        { name: "real_execution_hard_block", status: "pass", summary: "blocked" },
      ],
      generated_at: "2026-06-21T20:00:00Z",
    },
    "/api/v1/provider-cursors": [
      { provider: "odds_api_io", stream: "tennis:moneyline", resync_required: true },
    ],
    "/api/v1/signals/live": [],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        source_summary: { total_matches: 1, persisted_matches: 1 },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: false,
          enterprise_eligible: false,
          current_step: "1. theoddsapi:archive_odds",
          steps: [
            {
              order: 1,
              provider: "theoddsapi",
              capability: "archive_odds",
              status: "ready_next",
              configured: true,
              current: true,
              smoke_completed: false,
              required_before_enable: [],
              next_action: "Run archive smoke manually.",
              notes: [],
            },
          ],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["trigger-policy", `--api-base=${apiBase}`], {
      env: { HERMES_BIN: fakeHermes },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.url === "/api/v1/agent/autopilot/evaluate"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "trigger_policy");
    assert.equal(payload.read_only, true);
    assert.equal(payload.live_api_calls, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.wakeup_channels.includes("cron"), true);
    assert.equal(payload.wakeup_channels.includes("cloudflare_agent"), true);
    assert.equal(payload.triggers.some((trigger) => trigger.id === "runtime_degraded"), true);
    assert.equal(payload.triggers.some((trigger) => trigger.id === "source_discovery"), true);
    assert.equal(payload.triggers.some((trigger) => trigger.id === "cursor_resync_required"), true);
    assert.equal(payload.triggers.every((trigger) => trigger.executes_now === false), true);
    assert.equal(payload.triggers.every((trigger) => trigger.provider_api_call_allowed === false), true);
    assert.equal(payload.next_wakeup.command, "npm run hermes:runtime-check");
    assert.equal(payload.debounce_policy.llm_per_tick_allowed, false);
    assert.equal(payload.forbidden_actions.includes("anti_bot_bypass"), true);
  } finally {
    server.close();
  }
});

test("trigger-policy wakes on Grand Slam prediction readiness without executing actions", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-trigger-slam-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: running'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.log('◆ API Connectivity'); process.exit(0); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const slamMatch = {
    match: {
      id: "slam_trigger_match",
      tournament: "Wimbledon",
      round: "R64",
      tour: "ATP",
      surface: "grass",
      player1: { id: "p1", name: "Player One" },
      player2: { id: "p2", name: "Player Two" },
      state: { status: "live", p1_games: 3, p2_games: 2, point_score: "30-15" },
    },
    prediction: {
      p1_win_prob: 0.62,
      p2_win_prob: 0.38,
      confidence: "Alta",
      model_version: "baseline_v0",
    },
    signals: [],
    freshness: {
      source: "live",
      persisted: true,
      score_age_ms: 3000,
      odds_age_ms: 2500,
    },
  };
  const fixtures = eventRouterFixtures({
    "/api/v1/live/matches": [slamMatch],
    "/api/v1/signals/live": [],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "live_with_keys",
        source_summary: {
          total_matches: 1,
          persisted_matches: 1,
          match_freshness: [
            {
              match_id: "slam_trigger_match",
              source: "live",
              persisted: true,
              score_age_ms: 3000,
              odds_age_ms: 2500,
            },
          ],
        },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: true,
          enterprise_eligible: false,
          current_step: null,
          steps: [],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli([
      "trigger-policy",
      `--api-base=${apiBase}`,
      "--date=2026-07-01",
    ], {
      env: { HERMES_BIN: fakeHermes },
    });

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.grand_slam_readiness.status, "prediction_ready");
    assert.equal(payload.grand_slam_readiness.prediction_ready, true);
    assert.equal(payload.grand_slam_readiness.visible_matches, 1);
    assert.equal(payload.triggers.some((trigger) => trigger.id === "grand_slam_prediction_ready"), true);
    const trigger = payload.triggers.find((item) => item.id === "grand_slam_prediction_ready");
    assert.equal(trigger.command, "npm --silent run hermes:grand-slam-readiness");
    assert.equal(trigger.executes_now, false);
    assert.equal(trigger.provider_api_call_allowed, false);
    assert.equal(trigger.can_create_paper_orders, false);
  } finally {
    server.close();
  }
});

test("ops-compiler produces a single non-executing orchestration packet", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-ops-compiler-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: stopped'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/agent/preflight": {
      status: "blocked",
      checks: [
        { name: "hermes_gateway", status: "fail", summary: "Hermes loopback gateway is not reachable." },
        { name: "real_execution_hard_block", status: "pass", summary: "blocked" },
      ],
      generated_at: "2026-06-21T20:00:00Z",
    },
    "/api/v1/provider-health": [
      { provider: "api_tennis", status: "degraded", cost_tier: "budget" },
      { provider: "theoddsapi", status: "healthy", cost_tier: "budget" },
    ],
    "/api/v1/signals/live": [],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        source_summary: { total_matches: 1, persisted_matches: 1 },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: false,
          enterprise_eligible: false,
          current_step: "1. theoddsapi:archive_odds",
          steps: [
            {
              order: 1,
              provider: "theoddsapi",
              capability: "archive_odds",
              status: "ready_next",
              configured: true,
              current: true,
              smoke_completed: false,
              required_before_enable: [],
              next_action: "Run archive smoke manually.",
              notes: [],
            },
          ],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["ops-compiler", `--api-base=${apiBase}`], {
      env: { HERMES_BIN: fakeHermes },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.url === "/api/v1/agent/autopilot/evaluate"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "ops_compiler");
    assert.equal(payload.read_only, true);
    assert.equal(payload.live_api_calls, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.execution_graph[0].id, "trigger_policy");
    assert.equal(payload.execution_graph.some((node) => node.id === "source_discovery"), true);
    assert.equal(payload.execution_graph.some((node) => node.id === "grand_slam_readiness"), true);
    assert.equal(payload.grand_slam_readiness.prediction_ready, false);
    assert.equal(payload.execution_graph.every((node) => node.executes_now === false), true);
    assert.equal(payload.compiled_action.command, "npm run hermes:runtime-check");
    assert.equal(payload.compiled_action.executes_now, false);
    assert.equal(payload.model_router.routine_model, "gpt-5.4-mini");
    assert.equal(payload.model_router.critical_model, "gpt-5.5");
    assert.equal(payload.model_router.selected_model, "gpt-5.5");
    assert.equal(payload.operator_packet.next_action.command, "npm run hermes:runtime-check");
    assert.equal(payload.safe_jailbreak_policy.bypass_allowed, false);
    assert.equal(payload.forbidden_actions.includes("sportsbook_ui_automation"), true);
  } finally {
    server.close();
  }
});

test("ops-compiler routes running-gateway doctor timeouts through doctor-triage", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-ops-compiler-doctor-timeout-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('Gateway Service\\n  Status:       ✓ running'); process.exit(0); }",
      "else if (process.argv[2] === 'doctor') { setTimeout(() => {}, 10000); }",
      "else { process.exit(2); }",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const fixtures = eventRouterFixtures();
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["ops-compiler", `--api-base=${apiBase}`], {
      env: { HERMES_BIN: fakeHermes },
      timeoutMs: 12_000,
    });

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "ops_compiler");
    assert.equal(payload.compiled_action.command, "npm run hermes:doctor-triage");
    assert.equal(payload.operator_packet.next_action.command, "npm run hermes:doctor-triage");
    assert.equal(payload.trigger_policy.next_wakeup.command, "npm run hermes:doctor-triage");
    assert.equal(payload.compiled_action.executes_now, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
  } finally {
    server.close();
  }
});

test("capability-audit scores Hermes autonomy without executing actions", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-capability-audit-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: running'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.log('doctor: ok'); process.exit(0); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const fixtures = eventRouterFixtures();
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["capability-audit", `--api-base=${apiBase}`], {
      env: { HERMES_BIN: fakeHermes },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.url === "/api/v1/agent/autopilot/evaluate"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "capability_audit");
    assert.equal(payload.objective, "maximize_safe_hermes_autonomy");
    assert.equal(payload.read_only, true);
    assert.equal(payload.live_api_calls, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.overall_score > 0, true);
    assert.equal(payload.capabilities.length >= 8, true);
    assert.equal(payload.capabilities.every((capability) => capability.executes_now === false), true);
    assert.equal(payload.capabilities.every((capability) => capability.evidence.length > 0), true);
    const byId = Object.fromEntries(payload.capabilities.map((capability) => [capability.id, capability]));
    assert.equal(byId.runtime_and_channels.status, "ready");
    assert.equal(byId.safe_source_discovery.status, "ready");
    assert.equal(byId.external_agent_orchestration.status, "ready");
    assert.equal(byId.paper_autopilot.status, "operator_ready");
    assert.equal(byId.learning_review.status, "collecting");
    assert.equal(byId.enterprise_gate.status, "locked");
    assert.equal(payload.autonomy_ceiling.id, "paper_autopilot");
    assert.equal(payload.next_safe_command.command, "npm run hermes:autopilot");
    assert.equal(payload.next_safe_command.executes_now, false);
    assert.equal(payload.next_safe_command.can_submit_real_orders, false);
    assert.equal(payload.safe_jailbreak_policy.bypass_allowed, false);
    assert.equal(payload.forbidden_actions.includes("credential_or_session_extraction"), true);
    assert.equal(payload.blocked_routes.includes("real_money_execution"), true);
  } finally {
    server.close();
  }
});

test("autonomy-gates proves the highest safe autonomy level without executing actions", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-autonomy-gates-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('Gateway Service\\n  Status: running'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.log('doctor: ok'); process.exit(0); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const fixtures = eventRouterFixtures();
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["autonomy-gates", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_TELEGRAM_ALLOWED_USER_IDS: "123456789",
        PRIVATE_ALLOWED_EMAILS: "operator@example.com",
        ADMIN_API_TOKEN: "local-admin",
        HERMES_EXPERIMENT_LEDGER_PATH: join(tempDir, "experiment-ledger.jsonl"),
        HERMES_OPERATOR_LEDGER_PATH: join(tempDir, "operator-ledger.jsonl"),
        HERMES_MISSION_LEDGER_PATH: join(tempDir, "mission-ledger.jsonl"),
        HERMES_LIVE_CONTROLLER_LEDGER_PATH: join(tempDir, "live-controller-ledger.jsonl"),
      },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.method === "POST"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "autonomy_gates");
    assert.equal(payload.read_only, true);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.active_ceiling.id, "paper_ready");
    const byId = Object.fromEntries(payload.gates.map((gate) => [gate.id, gate]));
    assert.equal(byId.observe.status, "pass");
    assert.equal(byId.channel_ready.status, "pass");
    assert.equal(byId.cron_ready.status, "pass");
    assert.equal(byId.paper_ready.status, "pass");
    assert.equal(byId.learning_ready.status, "blocked");
    assert.equal(byId.enterprise_review.status, "locked");
    assert.equal(byId.paper_ready.executes_now, false);
    assert.equal(byId.paper_ready.can_create_paper_orders, false);
    assert.equal(payload.next_required_gate.id, "learning_ready");
    assert.equal(payload.safety.real_execution_hard_block, true);
  } finally {
    server.close();
  }
});

test("autonomy-gates does not skip blocked earlier gates when paper is otherwise ready", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-autonomy-gates-blocked-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: stopped'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const fixtures = eventRouterFixtures();
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["autonomy-gates", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
        ADMIN_API_TOKEN: "local-admin",
      },
    });

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    const byId = Object.fromEntries(payload.gates.map((gate) => [gate.id, gate]));
    assert.equal(byId.channel_ready.status, "blocked");
    assert.equal(byId.paper_ready.status, "pass");
    assert.equal(payload.active_ceiling.id, "observe");
    assert.equal(payload.next_required_gate.id, "channel_ready");
  } finally {
    server.close();
  }
});

test("autonomy-gates routes running-gateway doctor timeouts to doctor-triage", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-autonomy-gates-doctor-timeout-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('Gateway Service\\n  Status:       ✓ running'); process.exit(0); }",
      "else if (process.argv[2] === 'doctor') { setTimeout(() => {}, 10000); }",
      "else { process.exit(2); }",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const fixtures = eventRouterFixtures();
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["autonomy-gates", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
        ADMIN_API_TOKEN: "local-admin",
      },
      timeoutMs: 12_000,
    });

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    const byId = Object.fromEntries(payload.gates.map((gate) => [gate.id, gate]));
    assert.equal(byId.channel_ready.status, "blocked");
    assert.equal(byId.channel_ready.command, "npm run hermes:doctor-triage");
    assert.equal(byId.channel_ready.blockers.includes("doctor_timed_out"), true);
    assert.equal(payload.next_required_gate.id, "channel_ready");
    assert.equal(payload.next_required_gate.command, "npm run hermes:doctor-triage");
    assert.equal(payload.safety.can_submit_real_orders, false);
    assert.equal(payload.safety.provider_api_call_allowed, false);
  } finally {
    server.close();
  }
});

test("experiment-lab ranks safe Hermes experiments without executing actions", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-experiment-lab-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('Gateway Service\\n  Status: running'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.log('doctor: ok'); process.exit(0); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const fixtures = eventRouterFixtures();
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["experiment-lab", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_TELEGRAM_ALLOWED_USER_IDS: "123456789",
        PRIVATE_ALLOWED_EMAILS: "operator@example.com",
        ADMIN_API_TOKEN: "local-admin",
      },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.method === "POST"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "experiment_lab");
    assert.equal(payload.read_only, true);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.research_question.includes("maximum safe Hermes ROI/CLV leverage"), true);
    assert.equal(payload.active_ceiling.id, "paper_ready");
    assert.equal(payload.experiments.length >= 4, true);
    assert.equal(payload.experiments.every((experiment) => experiment.executes_now === false), true);
    assert.equal(payload.experiments.every((experiment) => experiment.provider_api_call_allowed === false), true);
    const byId = Object.fromEntries(payload.experiments.map((experiment) => [experiment.id, experiment]));
    assert.equal(byId.paper_autopilot_rehearsal.status, "ready");
    assert.equal(byId.paper_autopilot_rehearsal.success_metrics.includes("paper_orders_created"), true);
    assert.equal(byId.live_collection_cadence.status, "ready");
    assert.equal(payload.next_experiment.id, "paper_autopilot_rehearsal");
    assert.equal(payload.safety.real_execution_hard_block, true);
  } finally {
    server.close();
  }
});

test("experiment-lab prioritizes live-controller backlog evidence", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-experiment-lab-controller-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  const controllerLedgerPath = join(tempDir, "live-controller-ledger.jsonl");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('Gateway Service\\n  Status: running'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.log('doctor: ok'); process.exit(0); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const controllerRows = [
    {
      mode: "live_controller_ledger_record",
      outcome: "observed",
      action_executed: false,
      collection_command_executed: false,
      provider_command_executed: false,
      paper_order_created: false,
      status: "blocked",
      action: "freeze_collection",
      next_safe_command: "npm --silent run hermes:events",
      throttle_level: "blocked",
      source_route_id: "replay_backfill",
    },
    {
      mode: "live_controller_ledger_record",
      outcome: "observed",
      action_executed: false,
      collection_command_executed: false,
      provider_command_executed: false,
      paper_order_created: false,
      status: "blocked",
      action: "freeze_collection",
      next_safe_command: "npm --silent run hermes:events",
      throttle_level: "blocked",
      source_route_id: "replay_backfill",
    },
  ];
  writeFileSync(controllerLedgerPath, `${controllerRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const fixtures = eventRouterFixtures();
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["experiment-lab", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_TELEGRAM_ALLOWED_USER_IDS: "123456789",
        PRIVATE_ALLOWED_EMAILS: "operator@example.com",
        ADMIN_API_TOKEN: "local-admin",
        HERMES_EXPERIMENT_LEDGER_PATH: join(tempDir, "experiment-ledger.jsonl"),
        HERMES_OPERATOR_LEDGER_PATH: join(tempDir, "operator-ledger.jsonl"),
        HERMES_MISSION_LEDGER_PATH: join(tempDir, "mission-ledger.jsonl"),
        HERMES_LIVE_CONTROLLER_LEDGER_PATH: controllerLedgerPath,
      },
    });

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "experiment_lab");
    assert.equal(payload.read_only, true);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.backlog_guidance.next_item_id, "harden_live_controller_feedback_loop");
    assert.equal(payload.backlog_guidance.next_item_source.includes("live_controller_ledger"), true);
    assert.equal(payload.next_experiment.id, "live_controller_feedback_loop");
    assert.equal(payload.next_experiment.command, "npm --silent run hermes:backlog-plan");
    assert.equal(payload.next_experiment.executes_now, false);
    assert.equal(payload.next_experiment.provider_api_call_allowed, false);
    assert.equal(payload.next_experiment.can_submit_real_orders, false);
    assert.equal(payload.next_experiment.evidence.includes("backlog_next_item=harden_live_controller_feedback_loop"), true);
  } finally {
    server.close();
  }
});

test("experiment-ledger appends experiment recommendations without executing actions", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-experiment-ledger-"));
  const ledgerPath = join(tempDir, "experiment-ledger.jsonl");
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: stopped'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const fixtures = eventRouterFixtures();
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["experiment-ledger", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_EXPERIMENT_LEDGER_PATH: ledgerPath,
      },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.method === "POST"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "experiment_ledger");
    assert.equal(payload.writes, true);
    assert.equal(payload.write_scope, "local_experiment_jsonl_only");
    assert.equal(payload.executed_commands.length, 0);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.ledger.path, ledgerPath);
    assert.equal(payload.record.lab.mode, "experiment_lab");
    assert.equal(payload.record.next_experiment_id, "runtime_channel_recovery");
    assert.equal(payload.record.action_executed, false);
    assert.equal(payload.record.experiment_command_executed, false);
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const audit = JSON.parse(lines[0]);
    assert.equal(audit.mode, "experiment_ledger_record");
    assert.equal(audit.next_experiment_id, "runtime_channel_recovery");
    assert.equal(audit.action_executed, false);
  } finally {
    server.close();
  }
});

test("experiment-ledger fails closed when backend API hangs", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-experiment-ledger-timeout-"));
  const ledgerPath = join(tempDir, "experiment-ledger.jsonl");
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: stopped'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const { server, apiBase } = await startServer((request) => {
    called.push({ url: request.url, method: request.method });
  });

  try {
    const result = await runCli(["experiment-ledger", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_EXPERIMENT_LEDGER_PATH: ledgerPath,
        HERMES_HTTP_TIMEOUT_MS: "100",
      },
      timeoutMs: 5_000,
    });

    assert.equal(result.exit, 0);
    assert.equal(called.some((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.method === "POST"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "experiment_ledger");
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.record.lab.mode, "experiment_lab");
    assert.equal(payload.record.lab.safety.real_execution_hard_block, true);
    assert.equal(
      payload.record.lab.experiments.every((experiment) => experiment.executes_now === false),
      true
    );
    assert.equal(
      payload.record.lab.experiments.every((experiment) => experiment.provider_api_call_allowed === false),
      true
    );
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const audit = JSON.parse(lines[0]);
    assert.equal(audit.mode, "experiment_ledger_record");
    assert.equal(audit.lab.active_ceiling.id, "observe");
    assert.equal(audit.action_executed, false);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("experiment-ledger-report summarizes repeated experiment recommendations", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-experiment-ledger-report-"));
  const ledgerPath = join(tempDir, "experiment-ledger.jsonl");
  const rows = [
    {
      generated_at: "2026-06-21T20:00:00Z",
      mode: "experiment_ledger_record",
      outcome: "observed",
      action_executed: false,
      experiment_command_executed: false,
      active_ceiling_id: "observe",
      next_experiment_id: "runtime_channel_recovery",
      next_experiment_command: "npm run hermes:runtime-fix-plan",
      ready_experiment_ids: ["runtime_channel_recovery", "source_discovery_backfill"],
      lab: { status: "ready" },
    },
    {
      generated_at: "2026-06-21T20:15:00Z",
      mode: "experiment_ledger_record",
      outcome: "observed",
      action_executed: false,
      experiment_command_executed: false,
      active_ceiling_id: "observe",
      next_experiment_id: "runtime_channel_recovery",
      next_experiment_command: "npm run hermes:runtime-fix-plan",
      ready_experiment_ids: ["runtime_channel_recovery"],
      lab: { status: "ready" },
    },
    {
      generated_at: "2026-06-21T20:30:00Z",
      mode: "experiment_ledger_record",
      outcome: "observed",
      action_executed: false,
      experiment_command_executed: false,
      active_ceiling_id: "paper_ready",
      next_experiment_id: "paper_autopilot_rehearsal",
      next_experiment_command: "npm run hermes:autopilot",
      ready_experiment_ids: ["paper_autopilot_rehearsal"],
      lab: { status: "ready" },
    },
  ];
  writeFileSync(ledgerPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = await runCli(["experiment-ledger-report"], {
    env: { HERMES_EXPERIMENT_LEDGER_PATH: ledgerPath },
  });

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "experiment_ledger_report");
  assert.equal(payload.read_only, true);
  assert.equal(payload.writes, false);
  assert.equal(payload.provider_api_call_allowed, false);
  assert.equal(payload.can_submit_real_orders, false);
  assert.equal(payload.can_create_paper_orders, false);
  assert.equal(payload.ledger.path, ledgerPath);
  assert.equal(payload.total_records, 3);
  assert.equal(payload.action_executed_count, 0);
  assert.equal(payload.experiment_command_executed_count, 0);
  assert.equal(payload.top_experiment, "runtime_channel_recovery");
  assert.equal(payload.next_experiment_counts[0].command, "runtime_channel_recovery");
  assert.equal(payload.active_ceiling_counts.observe, 2);
  assert.equal(payload.ready_experiment_counts.runtime_channel_recovery, 2);
});

test("backlog-plan turns repeated ledgers into non-executing implementation priorities", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-backlog-plan-"));
  const experimentLedgerPath = join(tempDir, "experiment-ledger.jsonl");
  const operatorLedgerPath = join(tempDir, "operator-ledger.jsonl");
  const experimentRows = [
    {
      mode: "experiment_ledger_record",
      outcome: "observed",
      action_executed: false,
      experiment_command_executed: false,
      active_ceiling_id: "observe",
      next_experiment_id: "runtime_channel_recovery",
      next_experiment_command: "npm run hermes:runtime-fix-plan",
      ready_experiment_ids: ["runtime_channel_recovery", "source_discovery_backfill"],
      lab: { status: "ready" },
    },
    {
      mode: "experiment_ledger_record",
      outcome: "observed",
      action_executed: false,
      experiment_command_executed: false,
      active_ceiling_id: "observe",
      next_experiment_id: "runtime_channel_recovery",
      next_experiment_command: "npm run hermes:runtime-fix-plan",
      ready_experiment_ids: ["runtime_channel_recovery"],
      lab: { status: "ready" },
    },
  ];
  const operatorRows = [
    {
      mode: "operator_ledger_record",
      outcome: "observed",
      action_executed: false,
      next_action_command: "npm run hermes:runtime-check",
      packet: { priority: "high", status: "runtime_degraded", cost_guard: { throttle_level: "blocked" } },
    },
    {
      mode: "operator_ledger_record",
      outcome: "observed",
      action_executed: false,
      next_action_command: "npm run hermes:runtime-check",
      packet: { priority: "high", status: "runtime_degraded", cost_guard: { throttle_level: "blocked" } },
    },
  ];
  writeFileSync(experimentLedgerPath, `${experimentRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(operatorLedgerPath, `${operatorRows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = await runCli(["backlog-plan"], {
    env: {
      HERMES_EXPERIMENT_LEDGER_PATH: experimentLedgerPath,
      HERMES_OPERATOR_LEDGER_PATH: operatorLedgerPath,
    },
  });

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "backlog_plan");
  assert.equal(payload.read_only, true);
  assert.equal(payload.writes, false);
  assert.equal(payload.provider_api_call_allowed, false);
  assert.equal(payload.can_submit_real_orders, false);
  assert.equal(payload.can_create_paper_orders, false);
  assert.equal(payload.llm_per_tick_allowed, false);
  assert.equal(payload.items.length >= 2, true);
  assert.equal(payload.items[0].id, "stabilize_hermes_runtime_channels");
  assert.equal(payload.items[0].source.includes("experiment_ledger"), true);
  assert.equal(payload.items[0].source.includes("mission_ledger"), false);
  assert.equal(payload.items[0].validation_commands.includes("npm run hermes:runtime-check"), true);
  assert.equal(payload.items[0].executes_now, false);
  assert.equal(payload.items.every((item) => item.executes_now === false), true);
  assert.equal(payload.next_item.id, "stabilize_hermes_runtime_channels");
  assert.equal(payload.evidence.experiment_ledger.total_records, 2);
  assert.equal(payload.evidence.operator_ledger.total_records, 2);
  assert.equal(payload.safety.can_submit_real_orders, false);
});

test("backlog-plan uses mission-ledger blockers as implementation evidence", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-backlog-mission-plan-"));
  const experimentLedgerPath = join(tempDir, "experiment-ledger.jsonl");
  const operatorLedgerPath = join(tempDir, "operator-ledger.jsonl");
  const missionLedgerPath = join(tempDir, "mission-ledger.jsonl");
  const missionRows = [
    {
      mode: "mission_ledger_record",
      status: "blocked",
      active_ceiling: "observe",
      outcome: "observed",
      action_executed: false,
      mission_command_executed: false,
      next_action_lane: "channel",
      next_action_command: "hermes gateway start",
      blocked_lane_ids: ["channel", "live_window"],
      mission: { status: "blocked" },
    },
    {
      mode: "mission_ledger_record",
      status: "blocked",
      active_ceiling: "observe",
      outcome: "observed",
      action_executed: false,
      mission_command_executed: false,
      next_action_lane: "channel",
      next_action_command: "hermes gateway start",
      blocked_lane_ids: ["channel"],
      mission: { status: "blocked" },
    },
  ];
  writeFileSync(experimentLedgerPath, "");
  writeFileSync(operatorLedgerPath, "");
  writeFileSync(missionLedgerPath, `${missionRows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = await runCli(["backlog-plan"], {
    env: {
      HERMES_EXPERIMENT_LEDGER_PATH: experimentLedgerPath,
      HERMES_OPERATOR_LEDGER_PATH: operatorLedgerPath,
      HERMES_MISSION_LEDGER_PATH: missionLedgerPath,
    },
  });

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "backlog_plan");
  assert.equal(payload.read_only, true);
  assert.equal(payload.writes, false);
  assert.equal(payload.provider_api_call_allowed, false);
  assert.equal(payload.can_submit_real_orders, false);
  assert.equal(payload.can_create_paper_orders, false);
  assert.equal(payload.items[0].id, "stabilize_hermes_runtime_channels");
  assert.equal(payload.items[0].source.includes("mission_ledger"), true);
  assert.equal(payload.items[0].frequency, 2);
  assert.equal(payload.next_item.id, "stabilize_hermes_runtime_channels");
  assert.equal(payload.evidence.mission_ledger.total_records, 2);
  assert.equal(payload.evidence.mission_ledger.top_next_action, "hermes gateway start");
  assert.equal(payload.evidence.mission_ledger.blocked_lane_counts.channel, 2);
  assert.equal(payload.evidence.mission_ledger.mission_command_executed_count, 0);
});

test("backlog-plan uses live-controller ledger as implementation evidence", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-backlog-controller-plan-"));
  const experimentLedgerPath = join(tempDir, "experiment-ledger.jsonl");
  const operatorLedgerPath = join(tempDir, "operator-ledger.jsonl");
  const missionLedgerPath = join(tempDir, "mission-ledger.jsonl");
  const controllerLedgerPath = join(tempDir, "live-controller-ledger.jsonl");
  const controllerRows = [
    {
      mode: "live_controller_ledger_record",
      outcome: "observed",
      action_executed: false,
      collection_command_executed: false,
      provider_command_executed: false,
      paper_order_created: false,
      status: "blocked",
      action: "freeze_collection",
      next_safe_command: "npm --silent run hermes:events",
      provider_candidate_command: null,
      protected_backend_command: null,
      throttle_level: "blocked",
      source_route_id: "replay_backfill",
    },
    {
      mode: "live_controller_ledger_record",
      outcome: "observed",
      action_executed: false,
      collection_command_executed: false,
      provider_command_executed: false,
      paper_order_created: false,
      status: "blocked",
      action: "freeze_collection",
      next_safe_command: "npm --silent run hermes:events",
      provider_candidate_command: null,
      protected_backend_command: null,
      throttle_level: "blocked",
      source_route_id: "replay_backfill",
    },
  ];
  writeFileSync(experimentLedgerPath, "");
  writeFileSync(operatorLedgerPath, "");
  writeFileSync(missionLedgerPath, "");
  writeFileSync(controllerLedgerPath, `${controllerRows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = await runCli(["backlog-plan"], {
    env: {
      HERMES_EXPERIMENT_LEDGER_PATH: experimentLedgerPath,
      HERMES_OPERATOR_LEDGER_PATH: operatorLedgerPath,
      HERMES_MISSION_LEDGER_PATH: missionLedgerPath,
      HERMES_LIVE_CONTROLLER_LEDGER_PATH: controllerLedgerPath,
    },
  });

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "backlog_plan");
  assert.equal(payload.read_only, true);
  assert.equal(payload.writes, false);
  assert.equal(payload.provider_api_call_allowed, false);
  assert.equal(payload.can_submit_real_orders, false);
  assert.equal(payload.can_create_paper_orders, false);
  assert.equal(payload.items[0].id, "harden_live_controller_feedback_loop");
  assert.equal(payload.items[0].source.includes("live_controller_ledger"), true);
  assert.equal(payload.items[0].frequency, 2);
  assert.equal(payload.items[0].validation_commands.includes("npm --silent run hermes:live-controller-ledger-report"), true);
  assert.equal(payload.items[0].executes_now, false);
  assert.equal(payload.next_item.id, "harden_live_controller_feedback_loop");
  assert.equal(payload.evidence.live_controller_ledger.total_records, 2);
  assert.equal(payload.evidence.live_controller_ledger.top_repeated_action, "freeze_collection");
  assert.equal(payload.evidence.live_controller_ledger.top_next_safe_command, "npm --silent run hermes:events");
  assert.equal(payload.evidence.live_controller_ledger.action_counts.freeze_collection, 2);
  assert.equal(payload.evidence.live_controller_ledger.throttle_counts.blocked, 2);
  assert.equal(payload.evidence.live_controller_ledger.provider_command_executed_count, 0);
  assert.equal(payload.evidence.live_controller_ledger.paper_order_created_count, 0);
  assert.equal(payload.safety.can_submit_real_orders, false);
});

test("implementation-handoff turns backlog priority into a safe work order", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-implementation-handoff-"));
  const experimentLedgerPath = join(tempDir, "experiment-ledger.jsonl");
  const operatorLedgerPath = join(tempDir, "operator-ledger.jsonl");
  const missionLedgerPath = join(tempDir, "mission-ledger.jsonl");
  const controllerLedgerPath = join(tempDir, "live-controller-ledger.jsonl");
  const controllerRows = [
    {
      mode: "live_controller_ledger_record",
      outcome: "observed",
      action_executed: false,
      collection_command_executed: false,
      provider_command_executed: false,
      paper_order_created: false,
      status: "blocked",
      action: "freeze_collection",
      next_safe_command: "npm --silent run hermes:events",
      provider_candidate_command: null,
      protected_backend_command: null,
      throttle_level: "blocked",
      source_route_id: "replay_backfill",
    },
    {
      mode: "live_controller_ledger_record",
      outcome: "observed",
      action_executed: false,
      collection_command_executed: false,
      provider_command_executed: false,
      paper_order_created: false,
      status: "blocked",
      action: "freeze_collection",
      next_safe_command: "npm --silent run hermes:events",
      provider_candidate_command: null,
      protected_backend_command: null,
      throttle_level: "blocked",
      source_route_id: "replay_backfill",
    },
  ];
  writeFileSync(experimentLedgerPath, "");
  writeFileSync(operatorLedgerPath, "");
  writeFileSync(missionLedgerPath, "");
  writeFileSync(controllerLedgerPath, `${controllerRows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = await runCli(["implementation-handoff"], {
    env: {
      HERMES_EXPERIMENT_LEDGER_PATH: experimentLedgerPath,
      HERMES_OPERATOR_LEDGER_PATH: operatorLedgerPath,
      HERMES_MISSION_LEDGER_PATH: missionLedgerPath,
      HERMES_LIVE_CONTROLLER_LEDGER_PATH: controllerLedgerPath,
    },
  });

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "implementation_handoff");
  assert.equal(payload.status, "ready");
  assert.equal(payload.read_only, true);
  assert.equal(payload.writes, false);
  assert.equal(payload.provider_api_call_allowed, false);
  assert.equal(payload.can_submit_real_orders, false);
  assert.equal(payload.can_create_paper_orders, false);
  assert.equal(payload.llm_per_tick_allowed, false);
  assert.equal(payload.source_plan.next_item_id, "harden_live_controller_feedback_loop");
  assert.equal(payload.work_order.id, "harden_live_controller_feedback_loop");
  assert.equal(payload.work_order.executes_now, false);
  assert.equal(payload.work_order.provider_api_call_allowed, false);
  assert.equal(payload.work_order.can_submit_real_orders, false);
  assert.equal(payload.work_order.can_create_paper_orders, false);
  assert.equal(payload.work_order.target_files.includes("hermes/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs"), true);
  assert.equal(payload.work_order.validation_commands.includes("npm --silent run hermes:live-controller-ledger-report"), true);
  assert.equal(payload.work_order.validation_commands.includes("npm run hermes:test"), true);
  assert.equal(payload.work_order.validation_commands.includes("python3 scripts/check_private_runtime.py"), true);
  assert.equal(payload.work_order.acceptance_criteria.includes("provider_api_call_allowed=false"), true);
  assert.equal(payload.work_order.prohibited_changes.includes("do not automate sportsbook browser sessions"), true);
  assert.equal(payload.implementation_policy.spend_provider_quota, false);
  assert.equal(payload.implementation_policy.real_execution_allowed, false);
  assert.equal(payload.evidence.sources.includes("live_controller_ledger"), true);
  assert.equal(payload.evidence.backlog_evidence.live_controller_ledger.provider_command_executed_count, 0);
  assert.equal(payload.safety.anti_bot_bypass_allowed, false);
  assert.equal(payload.safety.credential_or_session_extraction_allowed, false);
});

test("operator-packet emits a compact channel-safe decision summary", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-operator-packet-"));
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: stopped'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/agent/preflight": {
      status: "blocked",
      checks: [
        { name: "hermes_gateway", status: "fail", summary: "Hermes loopback gateway is not reachable." },
        { name: "real_execution_hard_block", status: "pass", summary: "blocked" },
      ],
      generated_at: "2026-06-21T20:00:00Z",
    },
    "/api/v1/signals/live": [],
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["operator-packet", `--api-base=${apiBase}`], {
      env: { HERMES_BIN: fakeHermes },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.url === "/api/v1/agent/autopilot/evaluate"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "operator_packet");
    assert.equal(payload.channel, "telegram_openclaw");
    assert.equal(payload.read_only, true);
    assert.equal(payload.writes, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.priority, "high");
    assert.equal(payload.status, "runtime_degraded");
    assert.match(payload.headline, /runtime_degraded/);
    assert.equal(payload.next_action.command, "npm run hermes:runtime-check");
    assert.equal(payload.cost_guard.throttle_level, "blocked");
    assert.equal(payload.cost_guard.provider_command_count, 0);
    assert.equal(payload.short_message.length <= 700, true);
    assert.match(payload.short_message, /Next: npm run hermes:runtime-check/);
    assert.equal(payload.forbidden_actions.includes("sportsbook_ui_automation"), true);
  } finally {
    server.close();
  }
});

test("operator-ledger appends operator packet decisions without executing actions", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-operator-ledger-"));
  const ledgerPath = join(tempDir, "operator-ledger.jsonl");
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: stopped'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/agent/preflight": {
      status: "blocked",
      checks: [
        { name: "hermes_gateway", status: "fail", summary: "Hermes loopback gateway is not reachable." },
        { name: "real_execution_hard_block", status: "pass", summary: "blocked" },
      ],
      generated_at: "2026-06-21T20:00:00Z",
    },
    "/api/v1/signals/live": [],
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["operator-ledger", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_OPERATOR_LEDGER_PATH: ledgerPath,
      },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.url === "/api/v1/agent/autopilot/evaluate"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "operator_ledger");
    assert.equal(payload.writes, true);
    assert.equal(payload.write_scope, "local_operator_jsonl_only");
    assert.equal(payload.executed_commands.length, 0);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.ledger.path, ledgerPath);
    assert.equal(payload.record.packet.mode, "operator_packet");
    assert.equal(payload.record.packet.next_action.command, "npm run hermes:runtime-check");
    assert.equal(payload.record.outcome, "observed");
    assert.equal(payload.record.action_executed, false);
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const audit = JSON.parse(lines[0]);
    assert.equal(audit.mode, "operator_ledger_record");
    assert.equal(audit.packet.priority, "high");
    assert.equal(audit.action_executed, false);
  } finally {
    server.close();
  }
});

test("operator-ledger-report summarizes local recommendations without executing actions", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-operator-ledger-report-"));
  const ledgerPath = join(tempDir, "operator-ledger.jsonl");
  const rows = [
    {
      generated_at: "2026-06-21T20:00:00Z",
      mode: "operator_ledger_record",
      outcome: "observed",
      action_executed: false,
      next_action_command: "npm run hermes:runtime-check",
      packet: {
        priority: "high",
        status: "runtime_degraded",
        cost_guard: { throttle_level: "blocked" },
      },
    },
    {
      generated_at: "2026-06-21T20:05:00Z",
      mode: "operator_ledger_record",
      outcome: "ignored",
      action_executed: false,
      next_action_command: "npm --silent run hermes:events",
      packet: {
        priority: "medium",
        status: "blocked",
        cost_guard: { throttle_level: "cost_watch" },
      },
    },
    {
      generated_at: "2026-06-21T20:10:00Z",
      mode: "operator_ledger_record",
      outcome: "observed",
      action_executed: false,
      next_action_command: "npm run hermes:runtime-check",
      packet: {
        priority: "high",
        status: "runtime_degraded",
        cost_guard: { throttle_level: "blocked" },
      },
    },
  ];
  writeFileSync(ledgerPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = await runCli(["operator-ledger-report"], {
    env: { HERMES_OPERATOR_LEDGER_PATH: ledgerPath },
  });

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "operator_ledger_report");
  assert.equal(payload.read_only, true);
  assert.equal(payload.writes, false);
  assert.equal(payload.provider_api_call_allowed, false);
  assert.equal(payload.can_submit_real_orders, false);
  assert.equal(payload.can_create_paper_orders, false);
  assert.equal(payload.ledger.path, ledgerPath);
  assert.equal(payload.total_records, 3);
  assert.equal(payload.action_executed_count, 0);
  assert.equal(payload.priority_counts.high, 2);
  assert.equal(payload.priority_counts.medium, 1);
  assert.equal(payload.status_counts.runtime_degraded, 2);
  assert.equal(payload.outcome_counts.observed, 2);
  assert.equal(payload.next_action_counts[0].command, "npm run hermes:runtime-check");
  assert.equal(payload.next_action_counts[0].count, 2);
  assert.equal(payload.throttle_counts.blocked, 2);
  assert.equal(payload.top_blocker, "npm run hermes:runtime-check");
});

test("runtime-fix-priorities converts ledger blockers into non-mutating priorities", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-runtime-priorities-"));
  const ledgerPath = join(tempDir, "operator-ledger.jsonl");
  const rows = [
    {
      mode: "operator_ledger_record",
      outcome: "observed",
      action_executed: false,
      next_action_command: "npm run hermes:runtime-check",
      packet: { priority: "high", status: "runtime_degraded", cost_guard: { throttle_level: "blocked" } },
    },
    {
      mode: "operator_ledger_record",
      outcome: "observed",
      action_executed: false,
      next_action_command: "npm run hermes:runtime-check",
      packet: { priority: "high", status: "runtime_degraded", cost_guard: { throttle_level: "blocked" } },
    },
    {
      mode: "operator_ledger_record",
      outcome: "observed",
      action_executed: false,
      next_action_command: "npm --silent run hermes:events",
      packet: { priority: "medium", status: "blocked", cost_guard: { throttle_level: "cost_watch" } },
    },
  ];
  writeFileSync(ledgerPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = await runCli(["runtime-fix-priorities"], {
    env: { HERMES_OPERATOR_LEDGER_PATH: ledgerPath },
  });

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "runtime_fix_priorities");
  assert.equal(payload.read_only, true);
  assert.equal(payload.writes, false);
  assert.equal(payload.provider_api_call_allowed, false);
  assert.equal(payload.can_submit_real_orders, false);
  assert.equal(payload.can_create_paper_orders, false);
  assert.equal(payload.ledger_report.total_records, 3);
  assert.equal(payload.priorities[0].id, "stabilize_hermes_runtime");
  assert.equal(payload.priorities[0].source_command, "npm run hermes:runtime-check");
  assert.equal(payload.priorities[0].frequency, 2);
  assert.equal(payload.priorities[0].executes_now, false);
  assert.equal(payload.priorities[0].provider_api_call_allowed, false);
  assert.equal(payload.priorities[0].can_submit_real_orders, false);
  assert.equal(payload.priorities[1].id, "inspect_event_router_blockers");
  assert.equal(payload.next_priority.id, "stabilize_hermes_runtime");
  assert.equal(payload.operator_note.includes("No priority executes automatically"), true);
});

test("scheduler-rehearsal records a safe loop plan without executing commands", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-scheduler-"));
  const runLog = join(tempDir, "scheduler-runs.jsonl");
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: stopped'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/agent/preflight": {
      status: "blocked",
      checks: [
        { name: "hermes_gateway", status: "fail", summary: "Hermes loopback gateway is not reachable." },
        { name: "real_execution_hard_block", status: "pass", summary: "blocked" },
      ],
      generated_at: "2026-06-21T20:00:00Z",
    },
    "/api/v1/signals/live": [],
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["scheduler-rehearsal", `--api-base=${apiBase}`, "--date=2026-06-22"], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_SCHEDULER_RUN_LOG: runLog,
      },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.url === "/api/v1/agent/autopilot/evaluate"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "scheduler_rehearsal");
    assert.equal(payload.executed_commands.length, 0);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.next_tick.command, "npm run hermes:runtime-check");
    assert.equal(payload.schedule.some((item) => item.command === "npm --silent run hermes:safe-loop"), true);
    assert.equal(payload.schedule.some((item) => item.command === "npm --silent run hermes:quota-plan"), true);
    const grandSlamItem = payload.schedule.find((item) => item.id === "grand_slam_readiness");
    assert.equal(grandSlamItem.command, "npm --silent run hermes:grand-slam-readiness");
    assert.equal(grandSlamItem.every_minutes, 30);
    assert.equal(grandSlamItem.provider_api_call_allowed, false);
    assert.equal(grandSlamItem.can_create_paper_orders, false);
    assert.equal(payload.grand_slam_readiness.status, "blocked");
    assert.equal(payload.grand_slam_readiness.cadence.every_minutes, 30);
    assert.equal(payload.audit_log.path, runLog);
    const lines = readFileSync(runLog, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const audit = JSON.parse(lines[0]);
    assert.equal(audit.mode, "scheduler_rehearsal");
    assert.equal(audit.next_tick.command, "npm run hermes:runtime-check");
    assert.equal(audit.executed_commands.length, 0);
  } finally {
    server.close();
  }
});

test("scheduler-rehearsal tightens Grand Slam cadence when paper-ready without executing actions", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-scheduler-slam-"));
  const runLog = join(tempDir, "scheduler-runs.jsonl");
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: running'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.log('doctor: ok'); process.exit(0); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const match = {
    match: {
      id: "wimbledon_live_edge",
      tournament: "Wimbledon",
      round: "R64",
      tour: "WTA",
      competition_level: "GRAND_SLAM",
      surface: "grass",
      player1: { id: "p1", name: "Player One" },
      player2: { id: "p2", name: "Player Two" },
      state: {
        status: "live",
        p1_games: 3,
        p2_games: 2,
        point_score: "30-15",
        server_player_id: "p1",
        is_tiebreak: false,
        is_break_point: false,
      },
    },
    prediction: {
      p1_win_prob: 0.64,
      p2_win_prob: 0.36,
      confidence: "Alta",
      model_version: "baseline_v0",
    },
    signals: [
      {
        id: "sig_wimbledon_edge",
        match_id: "wimbledon_live_edge",
        player_id: "p1",
        player_name: "Player One",
        status: "Entrada",
        edge: 0.075,
        threshold: 0.03,
        confidence: "Alta",
        best_odds: 2.02,
        reason: "fresh Grand Slam edge",
      },
    ],
    freshness: {
      source: "live",
      persisted: true,
      score_age_ms: 3000,
      odds_age_ms: 2500,
      provider_lineage: ["api_tennis", "odds_api_io"],
    },
  };
  const fixtures = eventRouterFixtures({
    "/api/v1/live/matches": [match],
    "/api/v1/signals/live": [match.signals[0]],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "live_with_keys",
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 12,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: true,
          enterprise_eligible: false,
          current_step: null,
          steps: [],
        },
        source_summary: {
          total_matches: 1,
          persisted_matches: 1,
          match_freshness: [
            {
              match_id: "wimbledon_live_edge",
              source: "live",
              persisted: true,
              score_age_ms: 3000,
              odds_age_ms: 2500,
            },
          ],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["scheduler-rehearsal", `--api-base=${apiBase}`, "--date=2026-07-01"], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_SCHEDULER_RUN_LOG: runLog,
      },
    });

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    const grandSlamItem = payload.schedule.find((item) => item.id === "grand_slam_readiness");
    assert.equal(payload.grand_slam_readiness.status, "paper_ready");
    assert.equal(payload.grand_slam_readiness.paper_ready, true);
    assert.equal(payload.grand_slam_readiness.grand_slam_visible, 1);
    assert.equal(grandSlamItem.every_minutes, 5);
    assert.equal(grandSlamItem.live_api_calls, false);
    assert.equal(grandSlamItem.provider_api_call_allowed, false);
    assert.equal(grandSlamItem.can_create_paper_orders, false);
    assert.equal(payload.executed_commands.length, 0);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.can_submit_real_orders, false);
  } finally {
    server.close();
  }
});

test("cron-proposal writes reviewable Hermes cron commands without creating jobs", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-cron-proposal-"));
  const runLog = join(tempDir, "scheduler-runs.jsonl");
  const proposalPath = join(tempDir, "cron-proposal.json");
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: stopped'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "if (process.argv[2] === 'cron') { console.error('cron must not be called'); process.exit(9); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/agent/preflight": {
      status: "blocked",
      checks: [
        { name: "hermes_gateway", status: "fail", summary: "Hermes loopback gateway is not reachable." },
        { name: "real_execution_hard_block", status: "pass", summary: "blocked" },
      ],
      generated_at: "2026-06-21T20:00:00Z",
    },
    "/api/v1/signals/live": [],
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["cron-proposal", `--api-base=${apiBase}`, "--date=2026-06-22"], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_SCHEDULER_RUN_LOG: runLog,
        HERMES_CRON_PROPOSAL_PATH: proposalPath,
      },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.url === "/api/v1/agent/autopilot/evaluate"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "cron_proposal");
    assert.equal(payload.created_jobs, false);
    assert.equal(payload.executed_commands.length, 0);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.proposal_path, proposalPath);
    assert.equal(payload.jobs.some((job) => job.name === "tennis-edge-safe-loop"), true);
    const grandSlamJob = payload.jobs.find((job) => job.name === "tennis-edge-grand-slam-readiness");
    assert.equal(grandSlamJob.every, "30m");
    assert.equal(grandSlamJob.source_command, "npm --silent run hermes:grand-slam-readiness");
    assert.equal(grandSlamJob.message.includes("Report status, active_grand_slams"), true);
    assert.equal(grandSlamJob.can_create_paper_orders, false);
    assert.equal(grandSlamJob.provider_api_call_allowed, false);
    assert.equal(payload.jobs.every((job) => job.command_preview.startsWith("hermes cron add")), true);
    assert.equal(payload.jobs.every((job) => job.command_preview.includes("--message")), true);
    assert.equal(payload.jobs.every((job) => !job.command_preview.includes("--execute-provider-call")), true);
    assert.equal(payload.operator_steps[0], "Review this proposal before creating any Hermes cron jobs.");
    const proposal = JSON.parse(readFileSync(proposalPath, "utf8"));
    assert.equal(proposal.mode, "cron_proposal");
    assert.equal(proposal.created_jobs, false);
    assert.equal(proposal.jobs.length, payload.jobs.length);
  } finally {
    server.close();
  }
});

test("activation-checklist allows only manual cron activation when all gates pass", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-activation-"));
  const proposalPath = join(tempDir, "cron-proposal.json");
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: running'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.log('doctor: ok'); process.exit(0); }",
      "if (process.argv[2] === 'cron') { console.error('cron must not be called'); process.exit(9); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const called = [];
  const fixtures = eventRouterFixtures({
    "/api/v1/signals/live": [],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        source_summary: { total_matches: 2, persisted_matches: 2 },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: true,
          enterprise_eligible: false,
          current_step: null,
          steps: [],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["activation-checklist", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_CRON_PROPOSAL_PATH: proposalPath,
        HERMES_TELEGRAM_ALLOWED_USER_IDS: "123456789",
        PRIVATE_ALLOWED_EMAILS: "operator@example.com",
        ADMIN_API_TOKEN: "local-admin",
      },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.url === "/api/v1/agent/autopilot/evaluate"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "activation_checklist");
    assert.equal(payload.activation_allowed, true);
    assert.equal(payload.created_jobs, false);
    assert.equal(payload.executed_commands.length, 0);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.checks.every((check) => check.status === "pass"), true);
    assert.equal(payload.manual_activation_commands.length, payload.cron_proposal.jobs.length);
    assert.equal(payload.manual_activation_commands.every((command) => command.startsWith("hermes cron add")), true);
    assert.equal(payload.manual_activation_commands.every((command) => !command.includes("--execute-provider-call")), true);
  } finally {
    server.close();
  }
});

test("activation-checklist blocks cron activation when runtime or operator gates are missing", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-activation-blocked-"));
  const proposalPath = join(tempDir, "cron-proposal.json");
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: stopped'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "if (process.argv[2] === 'cron') { console.error('cron must not be called'); process.exit(9); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const fixtures = eventRouterFixtures({
    "/api/v1/agent/preflight": {
      status: "blocked",
      checks: [
        { name: "hermes_gateway", status: "fail", summary: "Hermes loopback gateway is not reachable." },
        { name: "real_execution_hard_block", status: "pass", summary: "blocked" },
      ],
      generated_at: "2026-06-21T20:00:00Z",
    },
    "/api/v1/signals/live": [],
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["activation-checklist", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_CRON_PROPOSAL_PATH: proposalPath,
        HERMES_TELEGRAM_ALLOWED_USER_IDS: "",
        PRIVATE_ALLOWED_EMAILS: "",
        ADMIN_API_TOKEN: "",
      },
    });

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "activation_checklist");
    assert.equal(payload.activation_allowed, false);
    assert.equal(payload.created_jobs, false);
    assert.equal(payload.executed_commands.length, 0);
    assert.equal(payload.manual_activation_commands.length, 0);
    assert.equal(payload.checks.some((check) => check.id === "hermes_runtime_ready" && check.status === "fail"), true);
    assert.equal(payload.checks.some((check) => check.id === "telegram_allowlist_configured" && check.status === "fail"), true);
    assert.equal(payload.checks.some((check) => check.id === "private_access_allowlist_configured" && check.status === "fail"), true);
  } finally {
    server.close();
  }
});

test("runtime-fix-plan turns failed activation checks into non-mutating actions", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-runtime-fix-"));
  const proposalPath = join(tempDir, "cron-proposal.json");
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('gateway: stopped'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.error('gateway unreachable'); process.exit(1); }",
      "if (process.argv[2] === 'cron') { console.error('cron must not be called'); process.exit(9); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const fixtures = eventRouterFixtures({
    "/api/v1/agent/preflight": {
      status: "blocked",
      checks: [
        { name: "hermes_gateway", status: "fail", summary: "Hermes loopback gateway is not reachable." },
        { name: "real_execution_hard_block", status: "pass", summary: "blocked" },
      ],
      generated_at: "2026-06-21T20:00:00Z",
    },
    "/api/v1/signals/live": [],
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["runtime-fix-plan", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_CRON_PROPOSAL_PATH: proposalPath,
        HERMES_TELEGRAM_ALLOWED_USER_IDS: "",
        PRIVATE_ALLOWED_EMAILS: "",
        ADMIN_API_TOKEN: "",
      },
    });

    assert.equal(result.exit, 0);
    assert.equal(existsSync(proposalPath), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "runtime_fix_plan");
    assert.equal(payload.read_only, true);
    assert.equal(payload.writes, false);
    assert.equal(payload.created_jobs, false);
    assert.equal(payload.executed_commands.length, 0);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.next_action.id, "runtime_start_gateway_manual_review");
    assert.equal(payload.next_action.command, "hermes gateway start");
    assert.equal(payload.next_action.mutates_runtime_if_run, true);
    assert.equal(payload.next_action.executes_now, false);
    assert.equal(payload.runtime.findings.gateway_service_status, "stopped");
    assert.equal(payload.runtime.findings.blockers.includes("gateway_service_stopped"), true);
    assert.equal(payload.actions.some((action) => (
      action.id === "runtime_start_gateway_manual_review"
        && action.command === "hermes gateway start"
        && action.executes_now === false
        && action.mutates_runtime_if_run === true
    )), true);
    assert.equal(payload.actions.some((action) => (
      action.id === "fix_hermes_runtime_ready"
        && action.superseded_by_diagnostic_action === true
        && action.priority === 19
    )), true);
    assert.equal(payload.actions.some((action) => action.id === "fix_telegram_allowlist_configured" && action.requires_human), true);
    assert.equal(payload.actions.some((action) => action.id === "fix_private_access_allowlist_configured" && action.requires_human), true);
    assert.equal(payload.actions.some((action) => action.id === "fix_local_admin_secret_available" && action.requires_human), true);
    assert.equal(payload.actions.every((action) => action.executes_now === false), true);
  } finally {
    server.close();
  }
});

test("runtime-fix-plan escalates full-probe doctor timeouts without looping", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-runtime-doctor-timeout-"));
  const proposalPath = join(tempDir, "cron-proposal.json");
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('Gateway Service\\n  Status: running'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { setTimeout(() => {}, 10000); }",
      "if (process.argv[2] === 'cron') { console.error('cron must not be called'); process.exit(9); }",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const fixtures = eventRouterFixtures({
    "/api/v1/signals/live": [],
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["runtime-fix-plan", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_CRON_PROPOSAL_PATH: proposalPath,
        HERMES_TELEGRAM_ALLOWED_USER_IDS: "",
        PRIVATE_ALLOWED_EMAILS: "",
        ADMIN_API_TOKEN: "",
      },
      timeoutMs: 20_000,
    });

    assert.equal(result.exit, 0);
    assert.equal(existsSync(proposalPath), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "runtime_fix_plan");
    assert.equal(payload.read_only, true);
    assert.equal(payload.writes, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.next_action.id, "runtime_persistent_doctor_timeout_review");
    assert.equal(payload.next_action.command, "npm run hermes:runtime-check");
    assert.equal(payload.next_action.mutates_runtime_if_run, false);
    assert.equal(payload.runtime.findings.gateway_service_status, "running");
    assert.equal(payload.runtime.findings.doctor_status, "timed_out");
    assert.equal(payload.runtime.findings.doctor_timeout_ms, 5000);
    assert.equal(payload.runtime.findings.blockers.includes("doctor_timed_out"), true);
    assert.equal(payload.actions.some((action) => (
      action.id === "runtime_manual_hermes_update_review"
        && action.command === "hermes update"
        && action.mutates_runtime_if_run === true
        && action.requires_human === true
    )), true);
    assert.equal(payload.actions.some((action) => (
      action.id === "fix_hermes_runtime_ready"
        && action.superseded_by_diagnostic_action === true
        && action.priority === 19
    )), true);
    assert.equal(payload.actions.every((action) => action.executes_now === false), true);
  } finally {
    server.close();
  }
});

test("runtime-fix-plan preserves doctor progress when API connectivity times out", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-runtime-api-connectivity-timeout-"));
  const proposalPath = join(tempDir, "cron-proposal.json");
  const fakeHermes = join(tempDir, "hermes-fake.mjs");
  writeFileSync(
    fakeHermes,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'status') { console.log('Gateway Service\\n  Status: running'); process.exit(0); }",
      "if (process.argv[2] === 'doctor') { console.log('◆ API Connectivity\\n  Running 26 connectivity checks in parallel...'); setTimeout(() => {}, 10000); }",
      "if (process.argv[2] === 'cron') { console.error('cron must not be called'); process.exit(9); }",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const fixtures = eventRouterFixtures({
    "/api/v1/signals/live": [],
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["runtime-fix-plan", `--api-base=${apiBase}`], {
      env: {
        HERMES_BIN: fakeHermes,
        HERMES_CRON_PROPOSAL_PATH: proposalPath,
        HERMES_TELEGRAM_ALLOWED_USER_IDS: "",
        PRIVATE_ALLOWED_EMAILS: "",
        ADMIN_API_TOKEN: "",
      },
      timeoutMs: 20_000,
    });

    assert.equal(result.exit, 0);
    assert.equal(existsSync(proposalPath), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "runtime_fix_plan");
    assert.equal(payload.read_only, true);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.next_action.id, "runtime_api_connectivity_timeout_review");
    assert.equal(payload.next_action.command, "npm run hermes:runtime-check");
    assert.equal(payload.runtime.findings.doctor_progress.reached_api_connectivity, true);
    assert.equal(payload.runtime.findings.doctor_progress.connectivity_checks_count, 26);
    assert.equal(payload.actions.some((action) => (
      action.id === "runtime_manual_hermes_update_review"
        && action.executes_now === false
        && action.mutates_runtime_if_run === true
    )), true);
    assert.equal(payload.actions.every((action) => action.executes_now === false), true);
  } finally {
    server.close();
  }
});

test("playbook prioritizes data stabilization when cursor resync is required", async () => {
  const fixtures = eventRouterFixtures({
    "/api/v1/provider-cursors": [
      {
        provider: "odds_api_io",
        stream: "tennis:h2h",
        status: "gap",
        last_seq: 10,
        expected_next_seq: 11,
        gap_count: 1,
        resync_required: true,
        note: "missing seq 11",
      },
    ],
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["playbook", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.active_phase, "stabilize_data");
    assert.equal(payload.can_run_paper_autopilot, false);
    assert.equal(payload.can_submit_real_orders, false);
    const replayStep = payload.steps.find((step) => step.id === "replay_contracts");
    assert.equal(replayStep.status, "ready");
    assert.equal(replayStep.live_api_calls, false);
    const paperStep = payload.steps.find((step) => step.id === "paper_autopilot");
    assert.equal(paperStep.status, "blocked");
    assert.equal(paperStep.can_create_paper_orders, false);
    assert.equal(payload.hard_boundaries.includes("no_direct_betfair_or_sportsbook_calls"), true);
  } finally {
    server.close();
  }
});

test("playbook routes FastAPI provider degradation to backend latency triage", async () => {
  const fixtures = eventRouterFixtures({
    "/api/v1/provider-health": [
      {
        provider: "fastapi",
        configured: true,
        healthy: false,
        status: "unreachable",
      },
      { provider: "api_tennis", status: "healthy" },
    ],
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["playbook", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    const providerStep = payload.steps.find((step) => step.id === "provider_health_review");
    assert.equal(providerStep.status, "ready");
    assert.equal(providerStep.command, "npm run hermes:backend-latency-triage");
    assert.equal(providerStep.reason, "provider:fastapi:unreachable");
    assert.equal(providerStep.live_api_calls, false);
    assert.equal(providerStep.can_submit_real_orders, false);
    assert.equal(payload.event_summary.some((event) => (
      event.type === "provider_health_degraded"
        && event.allowed_command === "npm run hermes:backend-latency-triage"
    )), true);
  } finally {
    server.close();
  }
});

test("playbook exposes paper autopilot as the only order-creating step when clean", async () => {
  const fixtures = eventRouterFixtures();
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["playbook", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.active_phase, "paper_autopilot");
    assert.equal(payload.can_run_paper_autopilot, true);
    assert.equal(payload.enterprise_eligible, false);
    const orderCreatingSteps = payload.steps.filter((step) => step.can_create_paper_orders);
    assert.equal(orderCreatingSteps.length, 1);
    assert.equal(orderCreatingSteps[0].id, "paper_autopilot");
    assert.equal(orderCreatingSteps[0].command, "npm run hermes:autopilot");
    assert.equal(orderCreatingSteps[0].requires_admin_token, true);
    assert.equal(orderCreatingSteps[0].can_submit_real_orders, false);
  } finally {
    server.close();
  }
});

test("playbook keeps enterprise locked when budget chain is incomplete", async () => {
  const fixtures = eventRouterFixtures({
    "/api/v1/signals/live": [],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        source_summary: { total_matches: 2, persisted_matches: 2 },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          budget_chain_completed: false,
          enterprise_eligible: false,
          current_step: "1. theoddsapi:archive_odds",
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["playbook", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.active_phase, "budget_chain");
    assert.equal(payload.budget_chain_completed, false);
    assert.equal(payload.enterprise_eligible, false);
    assert.equal(payload.current_budget_step, "1. theoddsapi:archive_odds");
    const budgetStep = payload.steps.find((step) => step.id === "budget_chain_next_step");
    assert.equal(budgetStep.status, "ready");
    assert.match(budgetStep.reason, /theoddsapi:archive_odds/);
  } finally {
    server.close();
  }
});

test("live-stats emits deterministic collection, processing, and sampling metrics", async () => {
  const fixtures = eventRouterFixtures();
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["live-stats", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "paper_autopilot_candidate");
    assert.equal(payload.active_phase, "paper_autopilot");
    assert.equal(payload.signal_stats.entry, 1);
    assert.equal(payload.signal_stats.entry_rate, 0.5);
    assert.equal(payload.freshness.matches_sampled, 2);
    assert.equal(payload.freshness.stale_score_matches, 1);
    assert.equal(payload.freshness.stale_odds_matches, 1);
    assert.equal(payload.sampling_policy.name, "paper_signal_watch");
    assert.equal(payload.sampling_policy.llm_per_tick_allowed, false);
    assert.equal(payload.safety.can_submit_real_orders, false);
    assert.equal(payload.next_safe_commands.some((command) => command.id === "paper_autopilot"), true);
  } finally {
    server.close();
  }
});

test("live-window emits a go/no-go packet without executing actions", async () => {
  const cleanFixtures = eventRouterFixtures({
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "live_with_keys",
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 12,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: true,
          enterprise_eligible: false,
          current_step: null,
          steps: [],
        },
        source_summary: {
          total_matches: 2,
          persisted_matches: 2,
          match_freshness: [
            {
              match_id: "match_live_1",
              source: "live",
              persisted: true,
              score_age_ms: 4000,
              odds_age_ms: 3000,
            },
          ],
        },
      },
    },
  });
  const { server: cleanServer, apiBase: cleanApiBase } = await startServer((request, response) => {
    const payload = cleanFixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["live-window", `--api-base=${cleanApiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "live_window");
    assert.equal(payload.status, "paper_ready");
    assert.equal(payload.window_open, true);
    assert.equal(payload.read_only, true);
    assert.equal(payload.writes, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.autopilot_candidate, true);
    assert.equal(payload.next_action.command, "npm run hermes:autopilot");
    assert.equal(payload.next_action.executes_now, false);
    assert.equal(payload.gates.every((gate) => gate.status === "pass"), true);
    assert.equal(payload.forbidden_actions.includes("sportsbook_ui_automation"), true);
  } finally {
    cleanServer.close();
  }

  const blockedFixtures = eventRouterFixtures({
    "/api/v1/provider-cursors": [
      {
        provider: "odds_api_io",
        stream: "tennis.live",
        status: "gap",
        resync_required: true,
        last_seq: 12,
        expected_next_seq: 13,
        gap_count: 1,
      },
    ],
    "/api/v1/signals/live": [{ id: "sig_1", status: "Entrada" }],
  });
  const { server: blockedServer, apiBase: blockedApiBase } = await startServer((request, response) => {
    const payload = blockedFixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["live-window", `--api-base=${blockedApiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.window_open, false);
    assert.equal(payload.autopilot_candidate, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.blockers.includes("event_severity:high"), true);
    assert.equal(payload.gates.some((gate) => gate.id === "event_severity_clear" && gate.status === "fail"), true);
    assert.equal(payload.next_action.command, "npm --silent run hermes:events");
  } finally {
    blockedServer.close();
  }
});

test("match-pulse ranks match attention without creating orders", async () => {
  const matches = [
    {
      match: {
        id: "match_live_edge",
        tournament: "Wimbledon",
        round: "R16",
        tour: "ATP",
        competition_level: "GRAND_SLAM",
        surface: "grass",
        player1: { id: "p1", name: "Player One" },
        player2: { id: "p2", name: "Player Two" },
        state: {
          status: "live",
          p1_sets: 1,
          p2_sets: 1,
          p1_games: 4,
          p2_games: 3,
          point_score: "40-30",
          server_player_id: "p1",
          is_tiebreak: false,
          is_break_point: true,
        },
      },
      prediction: {
        p1_win_prob: 0.61,
        p2_win_prob: 0.39,
        confidence: "Alta",
        model_version: "baseline_v0",
      },
      signals: [
        {
          id: "sig_edge",
          match_id: "match_live_edge",
          player_id: "p1",
          player_name: "Player One",
          status: "Entrada",
          edge: 0.085,
          threshold: 0.03,
          confidence: "Alta",
          best_odds: 2.05,
          reason: "fresh edge",
        },
      ],
      freshness: {
        source: "live",
        persisted: true,
        score_age_ms: 4000,
        odds_age_ms: 3000,
        provider_lineage: ["api_tennis", "odds_api_io"],
      },
    },
    {
      match: {
        id: "match_stale_monitor",
        tournament: "Rome Masters",
        round: "QF",
        tour: "ATP",
        competition_level: "ATP",
        surface: "clay",
        player1: { id: "p3", name: "Player Three" },
        player2: { id: "p4", name: "Player Four" },
        state: {
          status: "live",
          p1_sets: 0,
          p2_sets: 0,
          p1_games: 2,
          p2_games: 2,
          point_score: "15-15",
          server_player_id: "p4",
          is_tiebreak: false,
          is_break_point: false,
        },
      },
      prediction: {
        p1_win_prob: 0.52,
        p2_win_prob: 0.48,
        confidence: "Media",
        model_version: "baseline_v0",
      },
      signals: [
        {
          id: "sig_monitor",
          match_id: "match_stale_monitor",
          player_id: "p3",
          player_name: "Player Three",
          status: "Monitorar",
          edge: 0.015,
          threshold: 0.04,
          confidence: "Media",
          best_odds: 1.9,
          reason: "below threshold",
        },
      ],
      freshness: {
        source: "persisted_fallback",
        persisted: true,
        score_age_ms: 45000,
        odds_age_ms: 26000,
        provider_lineage: ["api_tennis"],
      },
    },
  ];
  const fixtures = eventRouterFixtures({
    "/api/v1/live/matches": matches,
    "/api/v1/signals/live": [matches[0].signals[0], matches[1].signals[0]],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "live_with_keys",
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 12,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: true,
          enterprise_eligible: false,
          current_step: null,
          steps: [],
        },
        source_summary: {
          total_matches: 2,
          persisted_matches: 2,
          match_freshness: [
            {
              match_id: "match_live_edge",
              source: "live",
              persisted: true,
              score_age_ms: 4000,
              odds_age_ms: 3000,
            },
          ],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["match-pulse", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "match_pulse");
    assert.equal(payload.read_only, true);
    assert.equal(payload.writes, false);
    assert.equal(payload.live_api_calls, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.live_window_status, "paper_ready");
    assert.equal(payload.watchlist.length, 2);
    assert.equal(payload.top_match.match_id, "match_live_edge");
    assert.equal(payload.watchlist[0].attention, "paper_candidate");
    assert.equal(payload.watchlist[0].next_action.command, "npm run hermes:autopilot");
    assert.equal(payload.watchlist[0].next_action.executes_now, false);
    assert.equal(payload.watchlist[1].attention, "stale_monitor");
    assert.equal(payload.watchlist[0].priority_score > payload.watchlist[1].priority_score, true);
  } finally {
    server.close();
  }

  const blockedFixtures = eventRouterFixtures({
    "/api/v1/live/matches": matches,
    "/api/v1/provider-cursors": [
      {
        provider: "odds_api_io",
        stream: "tennis.live",
        status: "gap",
        resync_required: true,
        last_seq: 22,
        expected_next_seq: 23,
        gap_count: 1,
      },
    ],
    "/api/v1/signals/live": [matches[0].signals[0]],
  });
  const { server: blockedServer, apiBase: blockedApiBase } = await startServer((request, response) => {
    const payload = blockedFixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["match-pulse", `--api-base=${blockedApiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.live_window_status, "blocked");
    assert.equal(payload.watchlist[0].attention, "blocked_watch");
    assert.equal(payload.watchlist[0].next_action.command, "npm --silent run hermes:events");
    assert.equal(payload.watchlist.every((item) => item.next_action.can_create_paper_orders === false), true);
  } finally {
    blockedServer.close();
  }
});

test("grand-slam-readiness reports off-calendar state without provider calls", async () => {
  const fixtures = eventRouterFixtures({
    "/api/v1/live/matches": [],
    "/api/v1/signals/live": [],
    "/api/v1/cost-profile": {
      active_plan: "lean_atp",
      estimated_monthly_spend_usd: 377,
      monthly_budget_usd: 500,
      coverage_scope: ["atp_main", "grand_slam_men", "grand_slam_women"],
    },
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: true,
          enterprise_eligible: false,
          current_step: null,
          steps: [],
        },
        source_summary: {
          total_matches: 0,
          persisted_matches: 0,
          match_freshness: [],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli([
      "grand-slam-readiness",
      `--api-base=${apiBase}`,
      "--date=2026-06-22",
    ]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "grand_slam_readiness");
    assert.equal(payload.status, "off_calendar");
    assert.equal(payload.prediction_ready, false);
    assert.equal(payload.read_only, true);
    assert.equal(payload.live_api_calls, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.deepEqual(payload.active_grand_slams, []);
    assert.equal(payload.matches.grand_slam_visible, 0);
    assert.equal(payload.gates.find((gate) => gate.id === "grand_slam_coverage").status, "pass");
    assert.equal(payload.next_action.id, "wait_for_grand_slam_window");
    assert.equal(payload.operating_policy.bypass_allowed, false);
    assert.equal(payload.operating_policy.sportsbook_browser_automation_allowed, false);
  } finally {
    server.close();
  }
});

test("grand-slam-readiness exposes paper-ready Slam predictions without executing actions", async () => {
  const match = {
    match: {
      id: "wimbledon_live_edge",
      tournament: "Wimbledon",
      round: "R64",
      tour: "WTA",
      competition_level: "GRAND_SLAM",
      surface: "grass",
      player1: { id: "p1", name: "Player One" },
      player2: { id: "p2", name: "Player Two" },
      state: {
        status: "live",
        p1_sets: 0,
        p2_sets: 0,
        p1_games: 3,
        p2_games: 2,
        point_score: "30-15",
        server_player_id: "p1",
        is_tiebreak: false,
        is_break_point: false,
      },
    },
    prediction: {
      p1_win_prob: 0.64,
      p2_win_prob: 0.36,
      confidence: "Alta",
      model_version: "baseline_v0",
    },
    signals: [
      {
        id: "sig_wimbledon_edge",
        match_id: "wimbledon_live_edge",
        player_id: "p1",
        player_name: "Player One",
        status: "Entrada",
        edge: 0.075,
        threshold: 0.03,
        confidence: "Alta",
        best_odds: 2.02,
        reason: "fresh Grand Slam edge",
      },
    ],
    freshness: {
      source: "live",
      persisted: true,
      score_age_ms: 3000,
      odds_age_ms: 2500,
      provider_lineage: ["api_tennis", "odds_api_io"],
    },
  };
  const fixtures = eventRouterFixtures({
    "/api/v1/live/matches": [match],
    "/api/v1/signals/live": [match.signals[0]],
    "/api/v1/cost-profile": {
      active_plan: "lean_atp",
      estimated_monthly_spend_usd: 377,
      monthly_budget_usd: 500,
      coverage_scope: ["atp_main", "grand_slam_men", "grand_slam_women"],
    },
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "live_with_keys",
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 12,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: true,
          enterprise_eligible: false,
          current_step: null,
          steps: [],
        },
        source_summary: {
          total_matches: 1,
          persisted_matches: 1,
          match_freshness: [
            {
              match_id: "wimbledon_live_edge",
              source: "live",
              persisted: true,
              score_age_ms: 3000,
              odds_age_ms: 2500,
            },
          ],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli([
      "grand-slam-readiness",
      `--api-base=${apiBase}`,
      "--date=2026-07-01",
    ]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "grand_slam_readiness");
    assert.equal(payload.status, "paper_ready");
    assert.equal(payload.prediction_ready, true);
    assert.equal(payload.paper_ready, true);
    assert.equal(payload.active_grand_slams[0].id, "wimbledon");
    assert.equal(payload.matches.grand_slam_visible, 1);
    assert.equal(payload.matches.prediction_rows, 1);
    assert.equal(payload.matches.paper_candidates, 1);
    assert.equal(payload.matches.preview[0].match_id, "wimbledon_live_edge");
    assert.equal(payload.matches.preview[0].p1_win_prob, 0.64);
    assert.equal(payload.next_action.command, "npm run hermes:autopilot");
    assert.equal(payload.next_action.executes_now, false);
    assert.equal(payload.next_action.can_create_paper_orders, true);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.safety.can_submit_real_orders, false);
    assert.equal(payload.safety.llm_per_tick_allowed, false);
  } finally {
    server.close();
  }
});

test("collection-plan converts match pulse into safe polling cadence", async () => {
  const matches = [
    {
      match: {
        id: "match_live_hot",
        tournament: "US Open",
        round: "R32",
        tour: "ATP",
        competition_level: "GRAND_SLAM",
        surface: "hard",
        player1: { id: "p1", name: "Player One" },
        player2: { id: "p2", name: "Player Two" },
        state: {
          status: "live",
          p1_sets: 2,
          p2_sets: 2,
          p1_games: 5,
          p2_games: 5,
          point_score: "40-40",
          server_player_id: "p1",
          is_tiebreak: false,
          is_break_point: true,
        },
      },
      prediction: { p1_win_prob: 0.58, p2_win_prob: 0.42, confidence: "Alta", model_version: "baseline_v0" },
      signals: [
        {
          id: "sig_hot",
          match_id: "match_live_hot",
          player_id: "p1",
          player_name: "Player One",
          status: "Entrada",
          edge: 0.092,
          threshold: 0.03,
          confidence: "Alta",
          best_odds: 2.15,
          reason: "fresh high edge",
        },
      ],
      freshness: {
        source: "live",
        persisted: true,
        score_age_ms: 3000,
        odds_age_ms: 2500,
        provider_lineage: ["api_tennis", "odds_api_io"],
      },
    },
  ];
  const fixtures = eventRouterFixtures({
    "/api/v1/live/matches": matches,
    "/api/v1/signals/live": [matches[0].signals[0]],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "live_with_keys",
        replay_lab: { status: "ready" },
        model_lab: { status: "collecting", production_training_examples: 12, can_run_live_backtest: false },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: true,
          enterprise_eligible: false,
          current_step: null,
          steps: [],
        },
        source_summary: {
          total_matches: 1,
          persisted_matches: 1,
          match_freshness: [
            { match_id: "match_live_hot", source: "live", persisted: true, score_age_ms: 3000, odds_age_ms: 2500 },
          ],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["collection-plan", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "collection_plan");
    assert.equal(payload.status, "live_watch");
    assert.equal(payload.read_only, true);
    assert.equal(payload.writes, false);
    assert.equal(payload.live_api_calls, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.targets[0].match_id, "match_live_hot");
    assert.equal(payload.targets[0].lane, "hot_watch");
    assert.equal(payload.targets[0].score_poll_seconds, 15);
    assert.equal(payload.targets[0].odds_poll_seconds, 5);
    assert.equal(payload.targets[0].provider_api_call_allowed, false);
    assert.equal(payload.safe_commands.some((command) => command.command === "npm --silent run hermes:match-pulse"), true);
    assert.equal(payload.provider_commands.every((command) => command.executes_now === false), true);
  } finally {
    server.close();
  }

  const blockedFixtures = eventRouterFixtures({
    "/api/v1/live/matches": matches,
    "/api/v1/provider-cursors": [
      {
        provider: "odds_api_io",
        stream: "tennis.live",
        status: "gap",
        resync_required: true,
        last_seq: 2,
        expected_next_seq: 3,
        gap_count: 1,
      },
    ],
    "/api/v1/signals/live": [matches[0].signals[0]],
  });
  const { server: blockedServer, apiBase: blockedApiBase } = await startServer((request, response) => {
    const payload = blockedFixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["collection-plan", `--api-base=${blockedApiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.targets[0].lane, "frozen");
    assert.equal(payload.targets[0].score_poll_seconds, 0);
    assert.equal(payload.targets[0].odds_poll_seconds, 0);
    assert.equal(payload.provider_commands.length, 0);
    assert.equal(payload.safe_commands[0].command, "npm --silent run hermes:events");
  } finally {
    blockedServer.close();
  }
});

test("quota-plan throttles collection cadence near budget limits", async () => {
  const matches = [
    {
      match: {
        id: "match_live_quota",
        tournament: "Australian Open",
        round: "R16",
        tour: "ATP",
        competition_level: "GRAND_SLAM",
        surface: "hard",
        player1: { id: "p1", name: "Player One" },
        player2: { id: "p2", name: "Player Two" },
        state: {
          status: "live",
          p1_sets: 1,
          p2_sets: 1,
          p1_games: 4,
          p2_games: 4,
          point_score: "30-30",
          server_player_id: "p1",
          is_tiebreak: false,
          is_break_point: false,
        },
      },
      prediction: { p1_win_prob: 0.6, p2_win_prob: 0.4, confidence: "Alta", model_version: "baseline_v0" },
      signals: [
        {
          id: "sig_quota",
          match_id: "match_live_quota",
          player_id: "p1",
          player_name: "Player One",
          status: "Entrada",
          edge: 0.08,
          threshold: 0.03,
          confidence: "Alta",
          best_odds: 2.05,
          reason: "fresh edge",
        },
      ],
      freshness: {
        source: "live",
        persisted: true,
        score_age_ms: 5000,
        odds_age_ms: 4000,
        provider_lineage: ["api_tennis", "odds_api_io"],
      },
    },
  ];
  const baseDashboard = {
    operational_state: {
      provider_mode: "live_with_keys",
      replay_lab: { status: "ready" },
      model_lab: { status: "collecting", production_training_examples: 12, can_run_live_backtest: false },
      api_onboarding: {
        core_ready: true,
        budget_chain_completed: true,
        enterprise_eligible: false,
        current_step: null,
        steps: [],
      },
      source_summary: {
        total_matches: 1,
        persisted_matches: 1,
        match_freshness: [
          { match_id: "match_live_quota", source: "live", persisted: true, score_age_ms: 5000, odds_age_ms: 4000 },
        ],
      },
    },
  };
  const normalFixtures = eventRouterFixtures({
    "/api/v1/live/matches": matches,
    "/api/v1/signals/live": [matches[0].signals[0]],
    "/api/v1/dashboard/live-state": baseDashboard,
    "/api/v1/cost-profile": {
      active_plan: "lean_atp",
      estimated_monthly_spend_usd: 350,
      monthly_budget_usd: 500,
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = normalFixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["quota-plan", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "quota_plan");
    assert.equal(payload.status, "normal");
    assert.equal(payload.read_only, true);
    assert.equal(payload.writes, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.throttle.level, "normal");
    assert.equal(payload.effective_targets[0].match_id, "match_live_quota");
    assert.equal(payload.effective_targets[0].score_poll_seconds, 15);
    assert.equal(payload.effective_targets[0].odds_poll_seconds, 5);
    assert.equal(payload.provider_commands.every((command) => command.executes_now === false), true);
  } finally {
    server.close();
  }

  const guardedFixtures = eventRouterFixtures({
    "/api/v1/live/matches": matches,
    "/api/v1/signals/live": [matches[0].signals[0]],
    "/api/v1/dashboard/live-state": baseDashboard,
    "/api/v1/cost-profile": {
      active_plan: "lean_atp",
      estimated_monthly_spend_usd: 485,
      monthly_budget_usd: 500,
    },
  });
  const { server: guardedServer, apiBase: guardedApiBase } = await startServer((request, response) => {
    const payload = guardedFixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["quota-plan", `--api-base=${guardedApiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "throttled");
    assert.equal(payload.throttle.level, "budget_guard");
    assert.equal(payload.throttle.budget_utilization, 0.97);
    assert.equal(payload.effective_targets[0].score_poll_seconds, 60);
    assert.equal(payload.effective_targets[0].odds_poll_seconds, 60);
    assert.equal(payload.provider_commands.length, 0);
    assert.equal(payload.safe_commands[0].command, "npm --silent run hermes:collection-plan");
  } finally {
    guardedServer.close();
  }
});

test("live-controller compiles live data decisions without executing collection", async () => {
  const matches = [
    {
      match: {
        id: "match_controller_hot",
        tournament: "Roland Garros",
        round: "R16",
        tour: "WTA",
        competition_level: "GRAND_SLAM",
        surface: "clay",
        player1: { id: "p1", name: "Player One" },
        player2: { id: "p2", name: "Player Two" },
        state: {
          status: "live",
          p1_sets: 1,
          p2_sets: 1,
          p1_games: 5,
          p2_games: 4,
          point_score: "40-30",
          server_player_id: "p1",
          is_tiebreak: false,
          is_break_point: true,
        },
      },
      prediction: { p1_win_prob: 0.62, p2_win_prob: 0.38, confidence: "Alta", model_version: "baseline_v0" },
      signals: [
        {
          id: "sig_controller",
          match_id: "match_controller_hot",
          player_id: "p1",
          player_name: "Player One",
          status: "Entrada",
          edge: 0.075,
          threshold: 0.03,
          confidence: "Alta",
          best_odds: 2.1,
          reason: "fresh edge",
        },
      ],
      freshness: {
        source: "live",
        persisted: true,
        score_age_ms: 3000,
        odds_age_ms: 2000,
        provider_lineage: ["api_tennis", "odds_api_io"],
      },
    },
  ];
  const dashboard = {
    operational_state: {
      provider_mode: "live_with_keys",
      replay_lab: { status: "ready" },
      model_lab: { status: "collecting", production_training_examples: 18, can_run_live_backtest: false },
      api_onboarding: {
        core_ready: true,
        budget_chain_completed: true,
        enterprise_eligible: false,
        current_step: null,
        steps: [],
      },
      source_summary: {
        total_matches: 1,
        persisted_matches: 1,
        match_freshness: [
          { match_id: "match_controller_hot", source: "live", persisted: true, score_age_ms: 3000, odds_age_ms: 2000 },
        ],
      },
    },
  };
  const fixtures = eventRouterFixtures({
    "/api/v1/live/matches": matches,
    "/api/v1/signals/live": [matches[0].signals[0]],
    "/api/v1/dashboard/live-state": dashboard,
    "/api/v1/cost-profile": {
      active_plan: "lean_atp",
      estimated_monthly_spend_usd: 300,
      monthly_budget_usd: 500,
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["live-controller", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "live_controller");
    assert.equal(payload.status, "paper_ready");
    assert.equal(payload.read_only, true);
    assert.equal(payload.writes, false);
    assert.equal(payload.live_api_calls, false);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.operator_decision.action, "paper_autopilot_candidate");
    assert.equal(payload.operator_decision.protected_backend_action.command, "npm run hermes:autopilot");
    assert.equal(payload.operator_decision.protected_backend_action.executes_now, false);
    assert.equal(payload.operator_decision.protected_backend_action.provider_api_call_allowed, false);
    assert.equal(payload.operator_decision.top_match_id, "match_controller_hot");
    assert.equal(payload.collection.provider_candidates.every((command) => command.provider_api_call_allowed === false), true);
    assert.equal(payload.collection.provider_candidates.every((command) => command.executes_now === false), true);
    assert.equal(payload.control_policy.event_driven_not_tick_driven, true);
    assert.equal(payload.control_policy.provider_spend_requires_operator, true);
    assert.equal(payload.safety.can_submit_real_orders, false);
  } finally {
    server.close();
  }

  const blockedFixtures = eventRouterFixtures({
    "/api/v1/live/matches": matches,
    "/api/v1/signals/live": [matches[0].signals[0]],
    "/api/v1/dashboard/live-state": dashboard,
    "/api/v1/provider-cursors": [
      {
        provider: "odds_api_io",
        stream: "tennis.live",
        status: "gap",
        resync_required: true,
        last_seq: 30,
        expected_next_seq: 31,
        gap_count: 1,
      },
    ],
  });
  const { server: blockedServer, apiBase: blockedApiBase } = await startServer((request, response) => {
    const payload = blockedFixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["live-controller", `--api-base=${blockedApiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.operator_decision.action, "freeze_collection");
    assert.equal(payload.operator_decision.next_safe_command.command, "npm --silent run hermes:events");
    assert.equal(payload.operator_decision.next_safe_command.executes_now, false);
    assert.equal(payload.match_pulse.target_summary.lanes.frozen, 1);
    assert.equal(payload.quota.throttle.level, "blocked");
    assert.equal(payload.collection.provider_candidates.length, 0);
    assert.equal(payload.events.some((event) => event.type === "cursor_resync_required"), true);
    assert.equal(payload.safety.can_submit_real_orders, false);
  } finally {
    blockedServer.close();
  }
});

test("live-controller-ledger appends controller decisions without executing actions", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-live-controller-ledger-"));
  const ledgerPath = join(tempDir, "live-controller-ledger.jsonl");
  const called = [];
  const fixtures = eventRouterFixtures();
  const { server, apiBase } = await startServer((request, response) => {
    called.push({ url: request.url, method: request.method });
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["live-controller-ledger", `--api-base=${apiBase}`], {
      env: { HERMES_LIVE_CONTROLLER_LEDGER_PATH: ledgerPath },
    });

    assert.equal(result.exit, 0);
    assert.equal(called.every((call) => call.method === "GET"), true);
    assert.equal(called.some((call) => call.url === "/api/v1/agent/autopilot/evaluate"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "live_controller_ledger");
    assert.equal(payload.writes, true);
    assert.equal(payload.write_scope, "local_live_controller_jsonl_only");
    assert.equal(payload.executed_commands.length, 0);
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.can_submit_real_orders, false);
    assert.equal(payload.can_create_paper_orders, false);
    assert.equal(payload.ledger.path, ledgerPath);
    assert.equal(payload.record.mode, "live_controller_ledger_record");
    assert.equal(payload.record.controller.mode, "live_controller");
    assert.equal(payload.record.action_executed, false);
    assert.equal(payload.record.collection_command_executed, false);
    assert.equal(payload.record.provider_command_executed, false);
    assert.equal(payload.record.paper_order_created, false);
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const audit = JSON.parse(lines[0]);
    assert.equal(audit.mode, "live_controller_ledger_record");
    assert.equal(audit.action_executed, false);
    assert.equal(audit.provider_command_executed, false);
    assert.equal(audit.paper_order_created, false);
  } finally {
    server.close();
  }
});

test("live-controller-ledger-report summarizes repeated control decisions", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tennis-edge-live-controller-ledger-report-"));
  const ledgerPath = join(tempDir, "live-controller-ledger.jsonl");
  const rows = [
    {
      mode: "live_controller_ledger_record",
      outcome: "observed",
      action_executed: false,
      collection_command_executed: false,
      provider_command_executed: false,
      paper_order_created: false,
      status: "blocked",
      action: "freeze_collection",
      next_safe_command: "npm --silent run hermes:events",
      provider_candidate_command: null,
      protected_backend_command: null,
      throttle_level: "blocked",
      source_route_id: "replay_backfill",
    },
    {
      mode: "live_controller_ledger_record",
      outcome: "observed",
      action_executed: false,
      collection_command_executed: false,
      provider_command_executed: false,
      paper_order_created: false,
      status: "blocked",
      action: "freeze_collection",
      next_safe_command: "npm --silent run hermes:events",
      provider_candidate_command: null,
      protected_backend_command: null,
      throttle_level: "blocked",
      source_route_id: "replay_backfill",
    },
    {
      mode: "live_controller_ledger_record",
      outcome: "observed",
      action_executed: false,
      collection_command_executed: false,
      provider_command_executed: false,
      paper_order_created: false,
      status: "paper_ready",
      action: "paper_autopilot_candidate",
      next_safe_command: "npm run hermes:autopilot",
      provider_candidate_command: "npm run api:ingest:live-budget",
      protected_backend_command: "npm run hermes:autopilot",
      throttle_level: "normal",
      source_route_id: "live_statistics",
    },
  ];
  writeFileSync(ledgerPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = await runCli(["live-controller-ledger-report"], {
    env: { HERMES_LIVE_CONTROLLER_LEDGER_PATH: ledgerPath },
  });

  assert.equal(result.exit, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "live_controller_ledger_report");
  assert.equal(payload.read_only, true);
  assert.equal(payload.writes, false);
  assert.equal(payload.provider_api_call_allowed, false);
  assert.equal(payload.can_submit_real_orders, false);
  assert.equal(payload.can_create_paper_orders, false);
  assert.equal(payload.ledger.path, ledgerPath);
  assert.equal(payload.total_records, 3);
  assert.equal(payload.action_executed_count, 0);
  assert.equal(payload.collection_command_executed_count, 0);
  assert.equal(payload.provider_command_executed_count, 0);
  assert.equal(payload.paper_order_created_count, 0);
  assert.equal(payload.status_counts.blocked, 2);
  assert.equal(payload.action_counts.freeze_collection, 2);
  assert.equal(payload.throttle_counts.blocked, 2);
  assert.equal(payload.source_route_counts.replay_backfill, 2);
  assert.equal(payload.next_safe_command_counts[0].command, "npm --silent run hermes:events");
  assert.equal(payload.next_safe_command_counts[0].count, 2);
  assert.equal(payload.provider_candidate_counts[0].command, "npm run api:ingest:live-budget");
  assert.equal(payload.top_repeated_action, "freeze_collection");
  assert.equal(payload.top_next_safe_command, "npm --silent run hermes:events");
  assert.equal(payload.top_provider_candidate, "npm run api:ingest:live-budget");
});

test("budget-chain emits a dry-run provider onboarding plan without spending quota", async () => {
  const fixtures = eventRouterFixtures({
    "/api/v1/signals/live": [],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        source_summary: { total_matches: 2, persisted_matches: 2 },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: false,
          enterprise_eligible: false,
          current_step: "1. theoddsapi:archive_odds",
          warnings: [],
          steps: [
            {
              order: 1,
              provider: "theoddsapi",
              capability: "archive_odds",
              status: "ready_next",
              configured: true,
              current: true,
              last_smoke_status: null,
              last_smoke_at: null,
              smoke_completed: false,
              required_before_enable: [],
              next_action: "Run TheOddsAPI archive-sync smoke and confirm persisted payload evidence.",
              notes: ["Lowest-risk paid provider to connect first."],
            },
            {
              order: 2,
              provider: "api_tennis",
              capability: "score_livescore",
              status: "blocked",
              configured: false,
              current: false,
              last_smoke_status: null,
              last_smoke_at: null,
              smoke_completed: false,
              required_before_enable: ["TheOddsAPI archive smoke completed"],
              next_action: "Set API_TENNIS_KEY after archive odds are stable.",
              notes: [],
            },
          ],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["budget-chain", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "dry_run");
    assert.equal(payload.enterprise_eligible, false);
    assert.equal(payload.current_step.provider, "theoddsapi");
    assert.equal(payload.current_step.capability, "archive_odds");
    assert.equal(payload.current_step.smoke_command, "npm run api:ingest:archive-odds -- --pretty");
    assert.equal(payload.current_step.provider_api_call_allowed, false);
    assert.equal(payload.current_step.requires_operator_confirmation, true);
    assert.equal(payload.steps[1].status, "blocked");
    assert.equal(payload.safety.can_submit_real_orders, false);
  } finally {
    server.close();
  }
});

test("provider-smoke defaults to blocked dry-run and does not spend provider quota", async () => {
  const fixtures = eventRouterFixtures({
    "/api/v1/signals/live": [],
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "replay",
        source_summary: { total_matches: 2, persisted_matches: 2 },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "collecting",
          production_training_examples: 0,
          can_run_live_backtest: false,
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: false,
          enterprise_eligible: false,
          current_step: "1. theoddsapi:archive_odds",
          warnings: [],
          steps: [
            {
              order: 1,
              provider: "theoddsapi",
              capability: "archive_odds",
              status: "ready_next",
              configured: true,
              current: true,
              last_smoke_status: null,
              last_smoke_at: null,
              smoke_completed: false,
              required_before_enable: [],
              next_action: "Run TheOddsAPI archive-sync smoke and confirm persisted payload evidence.",
              notes: ["Lowest-risk paid provider to connect first."],
            },
          ],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["provider-smoke", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "dry_run");
    assert.equal(payload.status, "blocked");
    assert.equal(payload.reason, "explicit_provider_call_flag_required");
    assert.equal(payload.provider_api_call_allowed, false);
    assert.equal(payload.executed, false);
    assert.equal(payload.current_step.provider, "theoddsapi");
    assert.equal(payload.current_step.capability, "archive_odds");
    assert.equal(payload.would_run, "npm run api:ingest:archive-odds -- --pretty");
    assert.equal(payload.safety.can_submit_real_orders, false);
  } finally {
    server.close();
  }
});

test("learning-review summarizes model readiness without enabling real execution", async () => {
  const fixtures = eventRouterFixtures({
    "/api/v1/signals/live": [],
    "/api/v1/paper/performance": {
      readiness_status: "ready_for_review",
      roi: 0.08,
      clv: 0.018,
      settled_orders: 540,
      brier_score: 0.19,
      log_loss: 0.58,
      max_drawdown: 0.04,
      readiness_reasons: ["500+ settled paper signals reached"],
    },
    "/api/v1/dashboard/live-state": {
      operational_state: {
        provider_mode: "live_with_keys",
        source_summary: { total_matches: 2, persisted_matches: 2 },
        replay_lab: { status: "ready" },
        model_lab: {
          status: "ready",
          production_training_examples: 540,
          total_training_examples: 540,
          rehearsal_training_examples: 0,
          can_run_live_backtest: true,
          reasons: [],
        },
        api_onboarding: {
          core_ready: true,
          budget_chain_completed: true,
          enterprise_eligible: false,
          current_step: null,
          warnings: [],
          steps: [],
        },
      },
    },
  });
  const { server, apiBase } = await startServer((request, response) => {
    const payload = fixtures[request.url];
    if (payload !== undefined && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    const result = await runCli(["learning-review", `--api-base=${apiBase}`]);

    assert.equal(result.exit, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "weekly_learning_review");
    assert.equal(payload.review_status, "ready");
    assert.equal(payload.model_route.model, "gpt-5.5");
    assert.equal(payload.metrics.settled_orders, 540);
    assert.equal(payload.metrics.roi, 0.08);
    assert.equal(payload.metrics.clv, 0.018);
    assert.equal(payload.gates.budget_chain_completed, true);
    assert.equal(payload.gates.can_run_live_backtest, true);
    assert.equal(payload.gates.ready_for_review, true);
    assert.equal(payload.real_execution_recommendation, "keep_blocked");
    assert.equal(payload.safety.can_submit_real_orders, false);
    assert.equal(payload.llm_per_tick_allowed, false);
    assert.equal(payload.next_actions.includes("Run protected backtest/calibration review before any model promotion."), true);
  } finally {
    server.close();
  }
});
