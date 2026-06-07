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

async function runCli(args, { stdin = "" } = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
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
    assert.match(result.stderr, /preflight.*blocked/i);
    assert.equal(autopilotCalled, false);
  } finally {
    server.close();
  }
});

test("autopilot proceeds when preflight is degraded but not blocked", async () => {
  let autopilotCalled = false;
  const { server, apiBase } = await startServer((request, response) => {
    if (request.url === "/api/v1/agent/preflight") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "degraded", checks: [] }));
      return;
    }
    if (request.url === "/api/v1/agent/autopilot/evaluate") {
      autopilotCalled = true;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          run: { id: "agent_1", summary: "ok", actions: [] },
          paper_orders_created: 0,
          paper_orders_skipped: 0,
          real_execution_blocked: false,
        })
      );
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
  } finally {
    server.close();
  }
});
