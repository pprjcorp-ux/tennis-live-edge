import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

async function runCli(args, { stdin = "", env = {} } = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  child.stdin.end(stdin);
  const [exit] = await once(child, "close");
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
    assert.equal(payload.next_best_command.command, "npm run hermes:runtime-check");
    assert.equal(payload.safe_commands.some((command) => command.command === "npm run hermes:provider-smoke"), true);
    assert.equal(payload.forbidden_actions.includes("sportsbook_ui_automation"), true);
  } finally {
    server.close();
  }
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
    const result = await runCli(["scheduler-rehearsal", `--api-base=${apiBase}`], {
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
    const result = await runCli(["cron-proposal", `--api-base=${apiBase}`], {
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
