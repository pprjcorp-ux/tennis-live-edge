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
  assert.match(importBlock, /getLiveDashboard/);
  assert.doesNotMatch(importBlock, /getAgentPreflight,/);
  assert.doesNotMatch(importBlock, /getIngestionRuns/);
  assert.doesNotMatch(importBlock, /getDailyCostReport/);
  assert.doesNotMatch(importBlock, /getDailyMetrics/);
  assert.doesNotMatch(importBlock, /getLiveSignals/);
  assert.doesNotMatch(importBlock, /getOperationalState/);
  assert.doesNotMatch(importBlock, /getTodayMatches/);
  assert.match(pageSource, /getAgentPreflightSafe\(\)/);
  assert.match(pageSource, /getLiveDashboard\(\)/);
  assert.match(pageSource, /nextDashboard\.operational_state/);
  assert.match(pageSource, /nextDashboard\.matches/);
  assert.match(pageSource, /nextDashboard\.metrics/);
  assert.match(pageSource, /nextDashboard\.signals/);
  assert.match(pageSource, /nextDashboard\.readiness/);
  assert.match(pageSource, /replayOddsScenario/);
  assert.match(pageSource, /setReplayOddsScenario/);
  assert.match(pageSource, /runReplay\(selectedMatchId, adminToken\.trim\(\), replayOddsScenario\)/);
  assert.match(apiSource, /use_fixture_seed: true/);
  assert.match(pageSource, /nextOperational\.daily_cost_report/);
  assert.match(pageSource, /nextOperational\.api_onboarding/);
  assert.match(pageSource, /nextOperational\.model_lab/);
  assert.match(pageSource, /nextOperational\.replay_lab/);
  assert.match(pageSource, /budget_replay_fixtures/);
  assert.match(pageSource, /Live readiness/);
  assert.match(pageSource, /can_generate_entries/);
  assert.match(pageSource, /apiOnboarding=\{apiOnboarding\}/);
  assert.match(pageSource, /ingestionRuns=\{ingestionRuns\}/);
  assert.match(pageSource, /replayLab=\{replayLab\}/);
  assert.match(apiSource, /\/api\/v1\/dashboard\/live-state/);
  assert.match(apiSource, /odds_scenario: oddsScenario/);
  assert.match(dataHealthSource, /Ingestion Journal/);
  assert.match(dataHealthSource, /API Onboarding/);
  assert.match(dataHealthSource, /Core primeiro, providers por etapas/);
  assert.match(dataHealthSource, /Replay Contracts/);
  assert.match(dataHealthSource, /replayLab\.providers/);
  assert.match(dataHealthSource, /apiOnboarding\.steps/);
  assert.match(dataHealthSource, /Ultimos ciclos persistidos/);
  assert.match(dataHealthSource, /run\.run_type === "replay_run"/);
  assert.match(dataHealthSource, /events_replayed/);
  assert.match(dataHealthSource, /resync required/);
  assert.match(dataHealthSource, /cursorStatusClass/);
  assert.match(dataHealthSource, /expected_next_seq/);
  assert.match(dataHealthSource, /resync_required/);
  assert.match(pageSource, /Training Dataset/);
  assert.match(pageSource, /modelLab\.source/);
  assert.match(pageSource, /modelLab\.training_examples/);
  assert.match(pageSource, /\["Paper orders", String\(agentBriefing\?\.paper_orders \?\? 0\)\]/);
});
