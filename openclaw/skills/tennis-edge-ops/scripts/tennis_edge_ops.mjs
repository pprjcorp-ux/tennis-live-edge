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

async function ingestionRuns() {
  const data = await request("/api/v1/ingestion/runs");
  printJson(data);
}

async function autopilot() {
  const preflightData = await request("/api/v1/agent/preflight");
  if (preflightData.status === "blocked") {
    throw new Error(
      `OpenClaw preflight blocked autopilot: ${summarizeFailedChecks(preflightData.checks)}`
    );
  }
  const data = await request("/api/v1/agent/autopilot/evaluate", {
    method: "POST",
    headers: await adminHeaders(),
    body: JSON.stringify({
      source: "openclaw",
      create_paper_orders: true,
      request_real_execution: false,
      max_paper_orders: 3,
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

function summarizeFailedChecks(checks = []) {
  const failed = checks.filter((check) => check.status === "fail");
  if (!failed.length) {
    return "status=blocked";
  }
  return failed.map((check) => `${check.name}: ${check.summary}`).join("; ");
}

const commands = {
  briefing,
  anomalies,
  runs,
  preflight,
  "ingestion-runs": ingestionRuns,
  autopilot,
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
