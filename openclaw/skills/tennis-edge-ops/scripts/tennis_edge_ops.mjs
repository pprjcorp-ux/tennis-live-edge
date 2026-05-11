#!/usr/bin/env node

const API_BASE = process.env.TENNIS_EDGE_API_BASE ?? "http://localhost:8000";
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN ?? process.env.TENNIS_EDGE_ADMIN_API_TOKEN;

const command = process.argv[2] ?? "briefing";

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

function adminHeaders() {
  if (!ADMIN_TOKEN) {
    throw new Error("ADMIN_API_TOKEN is required for this OpenClaw command.");
  }
  return { "x-admin-token": ADMIN_TOKEN };
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

async function autopilot() {
  const data = await request("/api/v1/agent/autopilot/evaluate", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      source: "openclaw",
      create_paper_orders: true,
      request_real_execution: false,
      max_paper_orders: Number(process.env.OPENCLAW_MAX_PAPER_ORDERS ?? 3),
      notes: "openclaw local skill paper autopilot"
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

const commands = { briefing, anomalies, runs, autopilot };

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
