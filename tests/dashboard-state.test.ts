import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DASHBOARD_DOMAINS, resolveDashboardState, type DashboardConnection } from "../lib/operations/dashboard-state.ts";

const connected = (provider: string, lastSyncAt: string | null = null): DashboardConnection => ({ provider, status: "connected", lastSyncAt });
const synced = (provider: string) => connected(provider, "2026-09-20T00:00:00Z");

test("no connections preview all external domains; preview is distinct from an actual zero", () => {
  for (const domain of Object.keys(DASHBOARD_DOMAINS) as (keyof typeof DASHBOARD_DOMAINS)[]) {
    assert.equal(resolveDashboardState(domain, [], [], false), "preview");
  }
  assert.equal(resolveDashboardState("maintenance", [synced("buildium")], [], false), "empty");
});

test("initial import transitions from preview through syncing to live or empty", () => {
  assert.equal(resolveDashboardState("occupancy", [], [], false), "preview");
  assert.equal(resolveDashboardState("occupancy", [connected("buildium")], [], false), "syncing");
  assert.equal(resolveDashboardState("occupancy", [synced("buildium")], [], true), "live");
  assert.equal(resolveDashboardState("occupancy", [synced("buildium")], [], false), "empty");
});

test("provider capabilities unlock only supported domains and removal reverts them", () => {
  const pms = [synced("buildium")];
  assert.equal(resolveDashboardState("occupancy", pms, [], true), "live");
  assert.equal(resolveDashboardState("maintenance", pms, [], true), "live");
  assert.equal(resolveDashboardState("accounting", pms, [], true), "preview");
  assert.equal(resolveDashboardState("leasing", pms, [], true), "preview");
  assert.equal(resolveDashboardState("occupancy", [], [], true), "preview");
  assert.equal(resolveDashboardState("occupancy", [{ ...pms[0], status: "disconnected" }], [], true), "preview");
});

test("email-only and accounting-only workspaces unlock their own metrics", () => {
  assert.equal(resolveDashboardState("communications", [connected("gmail")], [], true), "live");
  assert.equal(resolveDashboardState("occupancy", [connected("gmail")], [], true), "preview");
  assert.equal(resolveDashboardState("accounting", [synced("quickbooks")], [], true), "live");
  assert.equal(resolveDashboardState("collections", [synced("quickbooks")], [], false), "preview");
  assert.equal(resolveDashboardState("occupancy", [synced("quickbooks")], [], true), "preview");
});

test("Aval-native work can be live beside preview financial and occupancy cards", () => {
  assert.equal(resolveDashboardState("maintenance", [], ["work.read"], true), "live");
  assert.equal(resolveDashboardState("occupancy", [], ["work.read"], false), "preview");
  assert.equal(resolveDashboardState("accounting", [], ["work.read"], false), "preview");
});

test("preview uses the shared chart without metric rows, hover values, or a demo dashboard", () => {
  const chart = readFileSync(new URL("../app/components/data-chart.tsx", import.meta.url), "utf8");
  const workspace = readFileSync(new URL("../app/components/operations-workspace.tsx", import.meta.url), "utf8");
  assert.match(chart, /dataState === "preview"/);
  assert.match(chart, /data-chart-preview/);
  assert.match(chart, /aria-hidden="true"/);
  assert.match(chart, /preview \? \(/);
  assert.ok(chart.includes("onConnect") && chart.includes("connectLabel"));
  const previewBranch = chart.split(') : preview ? (')[1]?.split(') : !rows.length')[0] ?? "";
  assert.ok(previewBranch.includes("data-chart-preview"));
  assert.ok(!previewBranch.includes("rows.map") && !previewBranch.includes("<title>") && !previewBranch.includes("chart-tooltip") && !previewBranch.includes("tabIndex"));
  assert.match(workspace, /<DataChart/);
  assert.match(workspace, /s\("preview"\)/);
  assert.doesNotMatch(workspace, /demoDashboard|sampleMetrics|fakeMetrics/);
});
