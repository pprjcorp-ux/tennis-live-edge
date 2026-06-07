import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDir, "..");

function readAppFile(path) {
  return readFileSync(join(appRoot, path), "utf8");
}

test("agent preflight client has a blocked fallback instead of throwing into the dashboard", () => {
  const apiSource = readAppFile("lib/api.ts");

  assert.match(apiSource, /export async function getAgentPreflightSafe/);
  assert.match(apiSource, /catch \(error\)/);
  assert.match(apiSource, /status: "blocked"/);
  assert.match(apiSource, /Agent Ops preflight could not be loaded/);
});

test("dashboard uses safe preflight loading and keeps paper-order visibility", () => {
  const pageSource = readAppFile("app/page.tsx");
  const apiSource = readAppFile("lib/api.ts");
  const dataHealthSource = readAppFile("app/components/data-health-panel.tsx");
  const importBlock = pageSource.slice(
    pageSource.indexOf("import {"),
    pageSource.indexOf("} from \"@/lib/api\";") + 1
  );

  assert.match(importBlock, /getAgentPreflightSafe/);
  assert.match(importBlock, /getIngestionRuns/);
  assert.doesNotMatch(importBlock, /getAgentPreflight,/);
  assert.match(pageSource, /getAgentPreflightSafe\(\)/);
  assert.match(pageSource, /getIngestionRuns\(\)/);
  assert.match(pageSource, /ingestionRuns=\{ingestionRuns\}/);
  assert.match(apiSource, /\/api\/v1\/ingestion\/runs/);
  assert.match(dataHealthSource, /Ingestion Journal/);
  assert.match(dataHealthSource, /Ultimos ciclos persistidos/);
  assert.match(pageSource, /\["Paper orders", String\(agentBriefing\?\.paper_orders \?\? 0\)\]/);
});
