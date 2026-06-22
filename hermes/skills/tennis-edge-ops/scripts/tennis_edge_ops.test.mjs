import { once } from "node:events";
import http from "node:http";
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
        api_onboarding: { budget_chain_completed: true },
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
